/**
 * api/server.js
 * Webhook ingestion API — validates, stores, and enqueues tasks
 */

const express = require("express");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const {
  createLogger,
  createDbPool,
  createRedisClient,
  TaskRepository,
  QUEUES,
} = require("../shared");

const SERVICE_NAME = process.env.SERVICE_NAME || "webhook-api";
const PORT = parseInt(process.env.PORT || "3000");

const log = createLogger(SERVICE_NAME);
const db = createDbPool(log);
const redis = createRedisClient(log, "publisher");
const tasks = new TaskRepository(db);

const app = express();
app.use(express.json({ limit: "1mb" }));

// ─── Middleware ────────────────────────────────────────────────────────────────

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  message: { error: "Too many requests" },
});

app.use("/webhook", limiter);

// Request logging
app.use((req, _res, next) => {
  log.info("Incoming request", {
    method: req.method,
    path: req.path,
    ip: req.ip,
    size: req.headers["content-length"],
  });
  next();
});

// ─── HMAC Signature Validation ────────────────────────────────────────────────
const validateSignature = (req, res, next) => {
  const secret =WEBHOOK_SECRET;
  if (!secret) return next(); // skip if not configured

  const sig =
    req.headers["x-hub-signature-256"] ||
    req.headers["x-webhook-signature"] ||
    req.headers["x-signature"];

  if (!sig) {
    log.warn("Missing webhook signature");
    return res.status(401).json({ error: "Missing signature" });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(req.body))
    .digest("hex");

  const provided = sig.replace(/^sha256=/, "");

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    log.warn("Invalid webhook signature", { source: req.body?.source });
    return res.status(401).json({ error: "Invalid signature" });
  }
  next();
};

// ─── Routes ───────────────────────────────────────────────────────────────────

/** Health check */
app.get("/health", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    await redis.ping();
    res.json({ status: "ok", service: SERVICE_NAME, ts: new Date().toISOString() });
  } catch (err) {
    log.error("Health check failed", { error: err.message });
    res.status(503).json({ status: "degraded", error: err.message });
  }
});

/** Main webhook endpoint */
app.post("/webhook", validateSignature, async (req, res) => {
  const requestId = uuidv4();
  const startMs = Date.now();

  try {
    const {
      source = "default",
      event_type,
      priority = "normal",
      external_id,
      data: payload,
      metadata = {},
    } = req.body;

    // Validate priority
    const validPriorities = ["low", "normal", "high", "critical"];
    const safePriority = validPriorities.includes(priority) ? priority : "normal";

    // Persist to DB
    const task = await tasks.create({
      externalId: external_id || requestId,
      source,
      payload: payload || req.body,
      priority: safePriority,
      metadata: { ...metadata, event_type, requestId },
    });

    // Log initial event
    await tasks.logEvent(task.id, "webhook_received", SERVICE_NAME, {
      source,
      event_type,
      priority: safePriority,
    });

    // Push onto incoming queue (Redis list)
    const message = JSON.stringify({
      taskId: task.id,
      source,
      priority: safePriority,
      payload: task.payload,
      receivedAt: new Date().toISOString(),
    });

    // Use priority-aware queue key
    const queueKey =
      safePriority === "critical" || safePriority === "high"
        ? QUEUES.INCOMING + ":high"
        : QUEUES.INCOMING;

    await redis.lpush(queueKey, message);

    const latency = Date.now() - startMs;
    log.info("Task enqueued", {
      taskId: task.id,
      source,
      priority: safePriority,
      latencyMs: latency,
    });

    res.status(202).json({
      accepted: true,
      task_id: task.id,
      status: "received",
      estimated_processing: "< 30s",
    });
  } catch (err) {
    log.error("Webhook processing failed", { error: err.message, stack: err.stack });
    res.status(500).json({ error: "Internal server error", request_id: requestId });
  }
});

/** Task status endpoint */
app.get("/tasks/:id", async (req, res) => {
  try {
    const task = await tasks.getById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const { rows: events } = await db.query(
      `SELECT event_type, agent_name, details, duration_ms, created_at
       FROM task_events WHERE task_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ task, events });
  } catch (err) {
    log.error("Status lookup failed", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/** Queue stats */
app.get("/stats", async (_req, res) => {
  try {
    const [dbStats, queueDepths] = await Promise.all([
      tasks.getStats(),
      Promise.all(
        Object.entries(QUEUES).map(async ([name, key]) => ({
          queue: name,
          depth: await redis.llen(key),
        }))
      ),
    ]);
    res.json({ taskStats: dbStats, queues: queueDepths });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Dead-letter queue — requeue a task */
app.post("/tasks/:id/retry", async (req, res) => {
  try {
    const task = await tasks.getById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    await tasks.updateStatus(task.id, "received");
    await redis.lpush(
      QUEUES.INCOMING,
      JSON.stringify({ taskId: task.id, source: task.source, payload: task.payload })
    );
    log.info("Task re-queued for retry", { taskId: task.id });
    res.json({ requeued: true, taskId: task.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log.info(`Webhook API listening on :${PORT}`);
});

process.on("SIGTERM", async () => {
  log.info("SIGTERM received, shutting down gracefully");
  await db.end();
  await redis.quit();
  process.exit(0);
});
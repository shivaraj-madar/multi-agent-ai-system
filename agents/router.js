/**
 * agents/router.js
 * Router Agent — maps classified tasks to the appropriate executor handler.
 * Uses memory to track routing performance and adapt over time.
 */

const {
  createLogger,
  createDbPool,
  createRedisClient,
  AgentMemory,
  TaskRepository,
  QUEUES,
} = require("../shared");

const AGENT_NAME = "router-agent";
const log = createLogger(AGENT_NAME);
const db = createDbPool(log);
const redis = createRedisClient(log, "router-sub");
const pub = createRedisClient(log, "router-pub");
const memory = new AgentMemory(db, AGENT_NAME, log);
const tasks = new TaskRepository(db);

// ─── Routing table (category → handler) ───────────────────────────────────────
const ROUTING_TABLE = {
  payment_event:         { handler: "payment-handler",   timeout: 15000 },
  order_lifecycle:       { handler: "order-handler",     timeout: 20000 },
  user_action:           { handler: "user-handler",      timeout: 10000 },
  system_alert:          { handler: "alert-handler",     timeout: 5000  },
  data_pipeline:         { handler: "pipeline-handler",  timeout: 60000 },
  content_moderation:    { handler: "moderation-handler",timeout: 30000 },
  security_event:        { handler: "security-handler",  timeout: 8000  },
  notification_request:  { handler: "notify-handler",    timeout: 5000  },
  report_generation:     { handler: "report-handler",    timeout: 120000},
  unknown:               { handler: "fallback-handler",  timeout: 10000 },
};

// ─── Priority adjustment based on classification ───────────────────────────────
const adjustPriority = (currentPriority, classification, confidence) => {
  if (classification === "security_event") return "critical";
  if (classification === "system_alert" && confidence > 0.8) return "high";
  if (classification === "payment_event" && currentPriority === "low") return "normal";
  return currentPriority;
};

// ─── Route a task ──────────────────────────────────────────────────────────────
const routeTask = async (message) => {
  const { taskId, classification, confidence, payload, prioritySuggestion } = message;
  const startMs = Date.now();

  log.info("Routing task", { taskId, classification, confidence });

  const route = ROUTING_TABLE[classification] || ROUTING_TABLE.unknown;

  // Check memory for recent routing issues with this handler
  const handlerHealth = await memory.get(`handler_health:${route.handler}`);
  let effectiveHandler = route.handler;
  if (handlerHealth && handlerHealth.failureRate > 0.5) {
    log.warn("Handler has high failure rate, using fallback", {
      handler: route.handler,
      failureRate: handlerHealth.failureRate,
    });
    effectiveHandler = "fallback-handler";
  }

  const task = await tasks.getById(taskId);
  const priority = adjustPriority(
    task?.priority || "normal",
    classification,
    confidence
  );

  await tasks.updateStatus(taskId, "routed", {
    assignedAgent: effectiveHandler,
  });

  await tasks.logEvent(taskId, "routing_done", AGENT_NAME, {
    handler: effectiveHandler,
    originalHandler: route.handler,
    priority,
    confidence,
  }, Date.now() - startMs);

  // Forward to executor queue
  const executorMessage = JSON.stringify({
    taskId,
    handler: effectiveHandler,
    classification,
    confidence,
    entities: message.entities || {},
    routingHints: message.routingHints || [],
    priority,
    timeout: route.timeout,
    payload,
    intent: message.intent,
  });

  await pub.lpush(QUEUES.ROUTED, executorMessage);

  // Update routing memory (success path)
  const routeKey = `route_count:${classification}`;
  const existing = (await memory.get(routeKey)) || { count: 0 };
  await memory.set(routeKey, { count: existing.count + 1, lastHandler: effectiveHandler }, [
    "routing",
    classification,
  ]);

  log.info("Task routed", {
    taskId,
    handler: effectiveHandler,
    priority,
    latencyMs: Date.now() - startMs,
  });
};

// ─── Consumer loop ─────────────────────────────────────────────────────────────
const run = async () => {
  log.info("Router agent started");

  while (true) {
    try {
      const result = await redis.brpop(QUEUES.CLASSIFIED, 5);
      if (!result) continue;

      const [, raw] = result;
      const message = JSON.parse(raw);

      await routeTask(message).catch(async (err) => {
        log.error("Routing failed", { taskId: message.taskId, error: err.message });
        await pub.lpush(
          QUEUES.DEAD_LETTER,
          JSON.stringify({ ...message, failedAt: AGENT_NAME, error: err.message })
        );
        await tasks.updateStatus(message.taskId, "failed", {
          errorMessage: `Router: ${err.message}`,
          incrementRetry: true,
        });
      });
    } catch (err) {
      log.error("Router consumer error", { error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};

// ─── Metrics ───────────────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    const depth = await redis.llen(QUEUES.CLASSIFIED);
    await db.query(
      `INSERT INTO system_metrics (agent_name, queue_depth) VALUES ($1, $2)`,
      [AGENT_NAME, depth]
    );
  } catch {}
}, 30_000);

run().catch((err) => {
  log.error("Fatal router error", { error: err.message });
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await db.end();
  await redis.quit();
  await pub.quit();
  process.exit(0);
});
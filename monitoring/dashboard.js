/**
 * monitoring/dashboard.js
 * Real-time dashboard API for the multi-agent system.
 * Serves live stats via SSE and REST endpoints.
 */

const express = require("express");
const path = require("path");
const { createLogger, createDbPool, createRedisClient, QUEUES } = require("../shared");

const SERVICE_NAME = process.env.SERVICE_NAME || "dashboard";
const PORT = parseInt(process.env.PORT || "4000");

const log = createLogger(SERVICE_NAME);
const db = createDbPool(log);
const redis = createRedisClient(log, "dashboard");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// ─── REST: System Overview ────────────────────────────────────────────────────
app.get("/api/overview", async (_req, res) => {
  try {
    const [taskStats, agentHealth, queueDepths, recentEvents] = await Promise.all([
      db.query(`
        SELECT status, COUNT(*) as count
        FROM tasks
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY status ORDER BY count DESC
      `),
      db.query(`SELECT * FROM agent_health`),
      Promise.all(
        Object.entries(QUEUES).map(async ([name, key]) => ({
          queue: name,
          depth: await redis.llen(key),
        }))
      ),
      db.query(`
        SELECT t.id, t.status, t.classification, t.created_at,
               te.event_type, te.agent_name, te.created_at as event_time
        FROM tasks t
        LEFT JOIN task_events te ON te.task_id = t.id
        ORDER BY te.created_at DESC LIMIT 20
      `),
    ]);

    res.json({
      tasks: taskStats.rows,
      agents: agentHealth.rows,
      queues: queueDepths,
      recentEvents: recentEvents.rows,
    });
  } catch (err) {
    log.error("Overview API error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── REST: Classification stats ───────────────────────────────────────────────
app.get("/api/classifications", async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT ai_class as category,
             COUNT(*) as count,
             AVG(ai_confidence)::NUMERIC(4,3) as avg_confidence,
             AVG(latency_ms)::INTEGER as avg_latency_ms
      FROM classification_history
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY ai_class ORDER BY count DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REST: Task detail ────────────────────────────────────────────────────────
app.get("/api/tasks/:id", async (req, res) => {
  try {
    const [task, events] = await Promise.all([
      db.query(`SELECT * FROM tasks WHERE id = $1`, [req.params.id]),
      db.query(
        `SELECT * FROM task_events WHERE task_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      ),
    ]);
    if (task.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json({ task: task.rows[0], events: events.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REST: Notification log ───────────────────────────────────────────────────
app.get("/api/notifications", async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM notification_log
      ORDER BY created_at DESC LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REST: Metrics ────────────────────────────────────────────────────────────
app.get("/api/metrics", async (_req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT agent_name,
             DATE_TRUNC('minute', recorded_at) as minute,
             AVG(tasks_processed) as processed,
             AVG(tasks_failed) as failed,
             AVG(avg_latency_ms) as latency,
             AVG(queue_depth) as queue_depth
      FROM system_metrics
      WHERE recorded_at > NOW() - INTERVAL '1 hour'
      GROUP BY agent_name, DATE_TRUNC('minute', recorded_at)
      ORDER BY minute ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SSE: Real-time event stream ──────────────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 15000);

  // Poll for updates every 3 seconds
  const poll = setInterval(async () => {
    try {
      const [tasks, queues] = await Promise.all([
        db.query(`
          SELECT status, COUNT(*) as count FROM tasks
          WHERE created_at > NOW() - INTERVAL '5 minutes'
          GROUP BY status
        `),
        Promise.all(
          Object.entries(QUEUES).map(async ([name, key]) => ({
            queue: name,
            depth: await redis.llen(key),
          }))
        ),
      ]);
      sendEvent({ type: "stats", tasks: tasks.rows, queues });
    } catch (err) {
      log.warn("SSE poll error", { error: err.message });
    }
  }, 3000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(poll);
    log.debug("SSE client disconnected");
  });

  sendEvent({ type: "connected", ts: new Date().toISOString() });
});

// ─── Serve dashboard HTML ─────────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => log.info(`Dashboard listening on :${PORT}`));

process.on("SIGTERM", async () => {
  await db.end();
  await redis.quit();
  process.exit(0);
});
/**
 * agents/executor.js
 * Executor Agent — runs the actual task handlers with memory,
 * retry logic, timeout enforcement, and result persistence.
 */

const Anthropic = require("@anthropic-ai/sdk");
const {
  createLogger,
  createDbPool,
  createRedisClient,
  AgentMemory,
  TaskRepository,
  QUEUES,
  withRetry,
} = require("../shared");

const AGENT_NAME = "executor-agent";
const log = createLogger(AGENT_NAME);
const db = createDbPool(log);
const redis = createRedisClient(log, "exec-sub");
const pub = createRedisClient(log, "exec-pub");
const memory = new AgentMemory(db, AGENT_NAME, log);
const tasks = new TaskRepository(db);
const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Handler implementations ───────────────────────────────────────────────────

const handlers = {
  "payment-handler": async ({ taskId, payload, entities, memory: mem }) => {
    log.info("Processing payment event", { taskId });

    // Check for duplicate payment in memory
    const paymentId = entities.payment_id || payload.id;
    if (paymentId) {
      const seen = await mem.get(`payment:${paymentId}`);
      if (seen) {
        return { status: "duplicate", paymentId, skipped: true };
      }
      await mem.set(`payment:${paymentId}`, { processedAt: Date.now() }, ["payment"], 86400);
    }

    // Simulate payment processing logic
    const amount = entities.amount || payload.amount || 0;
    const currency = entities.currency || payload.currency || "USD";

    return {
      status: "processed",
      paymentId,
      amount,
      currency,
      processedAt: new Date().toISOString(),
      webhookAck: true,
    };
  },

  "user-handler": async ({ taskId, payload, entities }) => {
    log.info("Processing user action", { taskId });
    return {
      status: "processed",
      userId: entities.user_id || payload.user_id,
      action: entities.action || payload.action,
      processedAt: new Date().toISOString(),
    };
  },

  "alert-handler": async ({ taskId, payload, entities }) => {
    log.info("Processing system alert", { taskId });
    const severity = entities.severity || payload.severity || "medium";
    const result = {
      status: "acknowledged",
      severity,
      alertType: entities.alert_type || payload.alert_type,
      escalate: severity === "critical",
    };

    if (result.escalate) {
      // Push to notification queue
      await pub.lpush(
        QUEUES.NOTIFICATIONS,
        JSON.stringify({
          taskId,
          channel: "pagerduty",
          urgency: "high",
          title: "Critical System Alert",
          body: JSON.stringify(payload),
        })
      );
    }
    return result;
  },

  "security-handler": async ({ taskId, payload, entities }) => {
    log.info("Processing security event", { taskId });
    // Always notify on security events
    await pub.lpush(
      QUEUES.NOTIFICATIONS,
      JSON.stringify({
        taskId,
        channel: "slack",
        urgency: "critical",
        title: "Security Event Detected",
        body: `Type: ${entities.event_type || "unknown"} | IP: ${entities.ip || "unknown"}`,
      })
    );
    return {
      status: "flagged",
      eventType: entities.event_type,
      requiresReview: true,
      notified: true,
    };
  },

  "report-handler": async ({ taskId, payload, intent }) => {
    log.info("Generating rule-based report", { taskId });
    
    const reportType = payload.report_type || "general"
    const dateRange = payload.date_range || "last_7_days"
    
    return {
      status: "generated",
      report: `## ${reportType} Report\n\n` +
              `**Date Range:** ${dateRange}\n` +
              `**Generated At:** ${new Date().toISOString()}\n\n` +
              `### Summary\n` +
              `Report generated successfully for ${reportType}.\n\n` +
              `### Key Findings\n` +
              `- Data processed for period: ${dateRange}\n` +
              `- Report type: ${reportType}\n` +
              `- Format: ${payload.format || "json"}\n\n` +
              `### Recommended Actions\n` +
              `- Review the data for the specified period\n` +
              `- Share with relevant stakeholders`,
      generatedAt: new Date().toISOString(),
      model: "rule-based"
    };
  },

  "notify-handler": async ({ taskId, payload }) => {
    await pub.lpush(
      QUEUES.NOTIFICATIONS,
      JSON.stringify({
        taskId,
        channel: payload.channel || "slack",
        urgency: payload.urgency || "normal",
        title: payload.title || "Notification",
        body: payload.body || JSON.stringify(payload),
      })
    );
    return { status: "queued", channel: payload.channel };
  },

  "pipeline-handler": async ({ taskId, payload }) => {
    log.info("Data pipeline task", { taskId });
    // Simulate pipeline processing
    await new Promise((r) => setTimeout(r, 500));
    return {
      status: "processed",
      recordsProcessed: payload.records?.length || 0,
      pipelineId: payload.pipeline_id,
    };
  },

  "moderation-handler": async ({ taskId, payload }) => {
    const content = JSON.stringify(payload.content || payload).toLowerCase()
    const flagged = content.includes("spam") || 
                    content.includes("abuse") || 
                    content.includes("hate")
    return { 
      status: "moderated", 
      safe: !flagged, 
      reason: flagged ? "Contains flagged keywords" : "Content appears safe",
      confidence: 0.85,
      model: "rule-based"
    }
  },

  "order-handler": async ({ taskId, payload, entities }) => {
    return {
      status: "processed",
      orderId: entities.order_id || payload.order_id,
      orderStatus: entities.order_status || payload.status,
      processedAt: new Date().toISOString(),
    };
  },

  "fallback-handler": async ({ taskId, payload }) => {
    log.warn("Using fallback handler", { taskId });
    return {
      status: "fallback_processed",
      note: "Handled by fallback — no specific handler matched",
      payloadKeys: Object.keys(payload),
    };
  },
};

// ─── Execute a task ────────────────────────────────────────────────────────────
const executeTask = async (message) => {
  const { taskId, handler, classification, payload, entities, timeout } = message;
  const startMs = Date.now();

  log.info("Executing task", { taskId, handler });
  await tasks.updateStatus(taskId, "executing", { assignedAgent: AGENT_NAME });
  await tasks.logEvent(taskId, "execution_started", AGENT_NAME, { handler });

  const handlerFn = handlers[handler] || handlers["fallback-handler"];

  // Timeout wrapper
  const timeoutMs = timeout || parseInt(process.env.TASK_TIMEOUT_MS || "30000");
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Task timed out after ${timeoutMs}ms`)), timeoutMs)
  );

  const result = await Promise.race([
    handlerFn({ taskId, payload, entities, classification, intent: message.intent, memory }),
    timeoutPromise,
  ]);

  const durationMs = Date.now() - startMs;

  await tasks.updateStatus(taskId, "completed", { result });
  await tasks.logEvent(taskId, "execution_completed", AGENT_NAME, { handler, result }, durationMs);

  // Store execution in agent memory for pattern recognition
  await memory.set(
    `exec:${taskId}`,
    { handler, classification, durationMs, success: true },
    ["execution", classification],
    3600
  );

  // Send success notification for high-priority tasks
  if (message.priority === "high" || message.priority === "critical") {
    await pub.lpush(
      QUEUES.NOTIFICATIONS,
      JSON.stringify({
        taskId,
        channel: "slack",
        urgency: "normal",
        title: `✅ ${classification} task completed`,
        body: `Handler: ${handler} | Duration: ${durationMs}ms`,
      })
    );
  }

  log.info("Task completed", { taskId, handler, durationMs });
};

// ─── Consumer loop ─────────────────────────────────────────────────────────────
const run = async () => {
  log.info("Executor agent started");

  while (true) {
    try {
      const result = await redis.brpop(QUEUES.ROUTED, 5);
      if (!result) continue;

      const [, raw] = result;
      const message = JSON.parse(raw);

      await executeTask(message).catch(async (err) => {
        const { taskId } = message;
        log.error("Execution failed", { taskId, error: err.message });

        const task = await tasks.getById(taskId);
        const maxRetries = parseInt(process.env.MAX_RETRIES || "3");

        if (task && task.retry_count < maxRetries) {
          // Re-queue with delay
          log.info("Scheduling retry", { taskId, attempt: task.retry_count + 1 });
          await new Promise((r) => setTimeout(r, 2000 * (task.retry_count + 1)));
          await tasks.updateStatus(taskId, "received", { incrementRetry: true });
          await pub.lpush(QUEUES.ROUTED, raw);
        } else {
          // Dead-letter
          await tasks.updateStatus(taskId, "dead_letter", {
            errorMessage: `Executor: ${err.message}`,
          });
          await pub.lpush(
            QUEUES.DEAD_LETTER,
            JSON.stringify({ ...message, failedAt: AGENT_NAME, error: err.message })
          );
          await pub.lpush(
            QUEUES.NOTIFICATIONS,
            JSON.stringify({
              taskId,
              channel: "slack",
              urgency: "high",
              title: `❌ Task dead-lettered`,
              body: `Handler: ${message.handler} | Error: ${err.message}`,
            })
          );
        }
      });
    } catch (err) {
      log.error("Executor consumer error", { error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};

// ─── Metrics ───────────────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    const depth = await redis.llen(QUEUES.ROUTED);
    const [processed, failed] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM tasks WHERE assigned_agent = $1 AND status = 'completed' AND updated_at > NOW() - INTERVAL '30 seconds'`,
        [AGENT_NAME]
      ),
      db.query(
        `SELECT COUNT(*) FROM tasks WHERE assigned_agent = $1 AND status = 'failed' AND updated_at > NOW() - INTERVAL '30 seconds'`,
        [AGENT_NAME]
      ),
    ]);
    await db.query(
      `INSERT INTO system_metrics (agent_name, tasks_processed, tasks_failed, queue_depth)
       VALUES ($1, $2, $3, $4)`,
      [AGENT_NAME, parseInt(processed.rows[0].count), parseInt(failed.rows[0].count), depth]
    );
  } catch {}
}, 30_000);

run().catch((err) => {
  log.error("Fatal executor error", { error: err.message });
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await db.end();
  await redis.quit();
  await pub.quit();
  process.exit(0);
});
/**
 * agents/classifier.js
 * AI Classification Agent — uses Claude to classify incoming tasks
 * and extract structured intent from raw webhook payloads.
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

const AGENT_NAME = "classifier-agent";
const log = createLogger(AGENT_NAME);
const db = createDbPool(log);
const redis = createRedisClient(log, "subscriber");
const pub = createRedisClient(log, "publisher");
const memory = new AgentMemory(db, AGENT_NAME, log);
const tasks = new TaskRepository(db);
const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Classification schema ─────────────────────────────────────────────────────
const CATEGORIES = [
  "payment_event",
  "user_action",
  "system_alert",
  "data_pipeline",
  "content_moderation",
  "security_event",
  "order_lifecycle",
  "notification_request",
  "report_generation",
  "unknown",
];

const SYSTEM_PROMPT = `You are a classification agent in a multi-agent AI system.
Your role is to analyze incoming webhook payloads and classify them into the correct category.

Categories: ${CATEGORIES.join(", ")}

Respond ONLY with a valid JSON object in this exact format:
{
  "category": "<one of the listed categories>",
  "confidence": <float 0.0–1.0>,
  "intent": "<one-line description of what this task is asking for>",
  "priority_suggestion": "<low|normal|high|critical>",
  "entities": { "<extracted key entities as key-value pairs>" },
  "routing_hints": ["<relevant routing tags>"]
}

Be conservative with confidence — only use > 0.9 if extremely certain.`;

// ─── Core classification ───────────────────────────────────────────────────────
const classify = async (payload) => {
  const str = JSON.stringify(payload).toLowerCase()
  
  let category = "unknown"
  let confidence = 0.85

  if (str.includes("payment") || str.includes("charge") || str.includes("invoice") || str.includes("pay") || str.includes("amount"))
    category = "payment_event"
  else if (str.includes("security") || str.includes("login") || str.includes("brute"))
    category = "security_event"
  else if (str.includes("user") || str.includes("signup") || str.includes("account"))
    category = "user_action"
  else if (str.includes("alert") || str.includes("cpu") || str.includes("memory"))
    category = "system_alert"
  else if (str.includes("order") || str.includes("ship") || str.includes("deliver"))
    category = "order_lifecycle"
  else if (str.includes("report") || str.includes("summary") || str.includes("analytics"))
    category = "report_generation"
  else if (str.includes("pipeline") || str.includes("data") || str.includes("etl"))
    category = "data_pipeline"

  return {
    category,
    confidence,
    intent: `Rule-based: ${category}`,
    priority_suggestion: category === "security_event" ? "critical" : "normal",
    entities: {},
    routing_hints: [category],
    latencyMs: 1,
    model: "rule-based"
  }
};

// ─── Process a single task ─────────────────────────────────────────────────────
const processTask = async (message) => {
  const { taskId, payload } = message;
  const startMs = Date.now();

  log.info("Classifying task", { taskId });
  await tasks.updateStatus(taskId, "classified");

  const result = await classify(payload);

  // Persist classification
  await db.query(
    `INSERT INTO classification_history
       (task_id, raw_payload, ai_class, ai_confidence, model_used, tokens_used, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      taskId,
      JSON.stringify(payload),
      result.category,
      result.confidence,
      result.model || "unknown",
      result.tokensUsed || 0,
      result.latencyMs,
    ]
  );

  await tasks.updateStatus(taskId, "classified", {
    classification: result.category,
    confidence: result.confidence,
  });

  await tasks.logEvent(taskId, "classification_done", AGENT_NAME, {
    category: result.category,
    confidence: result.confidence,
    intent: result.intent,
    fromCache: result.fromCache,
  }, Date.now() - startMs);

  // Forward to router queue
  const routerMessage = JSON.stringify({
    taskId,
    classification: result.category,
    confidence: result.confidence,
    intent: result.intent,
    prioritySuggestion: result.priority_suggestion,
    entities: result.entities,
    routingHints: result.routing_hints,
    payload,
  });

  await pub.lpush(QUEUES.CLASSIFIED, routerMessage);

  log.info("Task classified and forwarded", {
    taskId,
    category: result.category,
    confidence: result.confidence,
    latencyMs: Date.now() - startMs,
  });
};

// ─── Queue consumer loop ───────────────────────────────────────────────────────
const run = async () => {
  log.info("Classifier agent started, listening for tasks...");

  // Purge old memories on startup
  await memory.purgeExpired();

  // Process high-priority queue first, then normal
  const queues = [QUEUES.INCOMING + ":high", QUEUES.INCOMING];

  while (true) {
    try {
      // Blocking pop (BRPOP) with 5s timeout — checks high-priority first
      const result = await redis.brpop(...queues, 5);
      if (!result) continue;

      const [, raw] = result;
      const message = JSON.parse(raw);

      await processTask(message).catch(async (err) => {
        log.error("Classification failed", {
          taskId: message.taskId,
          error: err.message,
        });

        // Send to dead-letter queue after max retries
        await pub.lpush(
          QUEUES.DEAD_LETTER,
          JSON.stringify({ ...message, failedAt: AGENT_NAME, error: err.message })
        );

        await tasks.updateStatus(message.taskId, "failed", {
          errorMessage: `Classifier: ${err.message}`,
          incrementRetry: true,
        });
      });
    } catch (err) {
      log.error("Consumer loop error", { error: err.message });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
};

// ─── Metrics reporting ─────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    const queueDepth = await redis.llen(QUEUES.INCOMING);
    const memoryCount = await db
      .query(`SELECT COUNT(*) FROM agent_memory WHERE agent_name = $1`, [AGENT_NAME])
      .then((r) => parseInt(r.rows[0].count));

    await db.query(
      `INSERT INTO system_metrics (agent_name, queue_depth, memory_entries)
       VALUES ($1, $2, $3)`,
      [AGENT_NAME, queueDepth, memoryCount]
    );
  } catch (err) {
    log.warn("Metrics reporting failed", { error: err.message });
  }
}, 30_000);

run().catch((err) => {
  log.error("Fatal error in classifier agent", { error: err.message });
  process.exit(1);
});

process.on("SIGTERM", async () => {
  log.info("Graceful shutdown initiated");
  await db.end();
  await redis.quit();
  await pub.quit();
  process.exit(0);
});
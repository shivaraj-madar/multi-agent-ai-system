/**
 * shared/index.js
 * Shared utilities for all agents and services
 */

const { Pool } = require("pg");
const Redis = require("ioredis");
const winston = require("winston");

// ─── Logger ────────────────────────────────────────────────────────────────────
const createLogger = (serviceName) => {
  const transports = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const metaStr = Object.keys(meta).length
            ? " " + JSON.stringify(meta)
            : "";
          return `${timestamp} [${serviceName}] ${level}: ${message}${metaStr}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: `/app/logs/${serviceName}.log`,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: "/app/logs/combined.log",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      maxsize: 50 * 1024 * 1024, // 50 MB
      maxFiles: 3,
    }),
  ];

  return winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    defaultMeta: { service: serviceName },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true })
    ),
    transports,
  });
};

// ─── PostgreSQL Pool ───────────────────────────────────────────────────────────
const createDbPool = (logger) => {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || "postgres",
    port: parseInt(process.env.POSTGRES_PORT || "5432"),
    database: process.env.POSTGRES_DB || "multiagent",
    user: process.env.POSTGRES_USER || "masuser",
    password: process.env.POSTGRES_PASSWORD || "maspassword",
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    logger.error("Unexpected PostgreSQL client error", { error: err.message });
  });

  pool.on("connect", () => {
    logger.debug("New PostgreSQL connection established");
  });

  return pool;
};

// ─── Redis Client ──────────────────────────────────────────────────────────────
const createRedisClient = (logger, name = "default") => {
  const client = new Redis({
    host: process.env.REDIS_HOST || "redis",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD || "redispass",
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: false,
    enableReadyCheck: true,
  });

  client.on("ready", () => logger.info(`Redis [${name}] ready`));
  client.on("error", (err) =>
    logger.error(`Redis [${name}] error`, { error: err.message })
  );
  client.on("reconnecting", () =>
    logger.warn(`Redis [${name}] reconnecting...`)
  );

  return client;
};

// ─── Agent Memory (DB-backed) ──────────────────────────────────────────────────
class AgentMemory {
  constructor(pool, agentName, logger) {
    this.pool = pool;
    this.agentName = agentName;
    this.logger = logger;
    this.ttlSeconds =
      parseInt(process.env.MEMORY_TTL_SECONDS) || 86400; // 24h default
  }

  async set(key, value, tags = [], ttlOverride = null) {
    const ttl = ttlOverride ?? this.ttlSeconds;
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;
    try {
      await this.pool.query(
        `INSERT INTO agent_memory (agent_name, memory_key, memory_value, tags, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agent_name, memory_key)
         DO UPDATE SET memory_value = $3, tags = $4, expires_at = $5, updated_at = NOW()`,
        [this.agentName, key, JSON.stringify(value), tags, expiresAt]
      );
      this.logger.debug(`Memory SET`, { key, ttl });
    } catch (err) {
      this.logger.error(`Memory SET failed`, { key, error: err.message });
      throw err;
    }
  }

  async get(key) {
    try {
      const { rows } = await this.pool.query(
        `SELECT memory_value, expires_at FROM agent_memory
         WHERE agent_name = $1 AND memory_key = $2
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [this.agentName, key]
      );
      if (rows.length === 0) return null;
      return rows[0].memory_value;
    } catch (err) {
      this.logger.error(`Memory GET failed`, { key, error: err.message });
      return null;
    }
  }

  async search(tags) {
    const { rows } = await this.pool.query(
      `SELECT memory_key, memory_value FROM agent_memory
       WHERE agent_name = $1 AND tags && $2
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY updated_at DESC LIMIT 50`,
      [this.agentName, tags]
    );
    return rows;
  }

  async delete(key) {
    await this.pool.query(
      `DELETE FROM agent_memory WHERE agent_name = $1 AND memory_key = $2`,
      [this.agentName, key]
    );
  }

  async purgeExpired() {
    const { rowCount } = await this.pool.query(
      `DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );
    if (rowCount > 0) this.logger.info(`Purged ${rowCount} expired memories`);
    return rowCount;
  }
}

// ─── Queue Channels ────────────────────────────────────────────────────────────
const QUEUES = {
  INCOMING: "queue:incoming",
  CLASSIFIED: "queue:classified",
  ROUTED: "queue:routed",
  NOTIFICATIONS: "queue:notifications",
  DEAD_LETTER: "queue:dead_letter",
};

// ─── Task DB helpers ───────────────────────────────────────────────────────────
class TaskRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async create(data) {
    const { rows } = await this.pool.query(
      `INSERT INTO tasks (external_id, source, payload, priority, metadata)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        data.externalId,
        data.source || "default",
        JSON.stringify(data.payload),
        data.priority || "normal",
        JSON.stringify(data.metadata || {}),
      ]
    );
    return rows[0];
  }

  async updateStatus(id, status, extra = {}) {
    const completedAt =
      status === "completed" || status === "failed" ? "NOW()" : "NULL";
    await this.pool.query(
      `UPDATE tasks SET
         status = $2,
         classification = COALESCE($3, classification),
         confidence = COALESCE($4, confidence),
         assigned_agent = COALESCE($5, assigned_agent),
         result = COALESCE($6, result),
         error_message = COALESCE($7, error_message),
         retry_count = retry_count + COALESCE($8, 0),
         completed_at = CASE WHEN $9 THEN NOW() ELSE completed_at END
       WHERE id = $1`,
      [
        id,
        status,
        extra.classification ?? null,
        extra.confidence ?? null,
        extra.assignedAgent ?? null,
        extra.result ? JSON.stringify(extra.result) : null,
        extra.errorMessage ?? null,
        extra.incrementRetry ? 1 : 0,
        status === "completed" || status === "failed",
      ]
    );
  }

  async logEvent(taskId, eventType, agentName, details = {}, durationMs = null) {
    await this.pool.query(
      `INSERT INTO task_events (task_id, event_type, agent_name, details, duration_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [taskId, eventType, agentName, JSON.stringify(details), durationMs]
    );
  }

  async getById(id) {
    const { rows } = await this.pool.query(
      `SELECT * FROM tasks WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  async getStats() {
    const { rows } = await this.pool.query(
      `SELECT status, COUNT(*) as count FROM tasks
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY status`
    );
    return rows;
  }
}

// ─── Retry helper ──────────────────────────────────────────────────────────────
const withRetry = async (fn, maxRetries = 3, delayMs = 2000, logger) => {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (logger) logger.warn(`Attempt ${attempt}/${maxRetries} failed`, { error: err.message });
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastErr;
};

module.exports = {
  createLogger,
  createDbPool,
  createRedisClient,
  AgentMemory,
  TaskRepository,
  QUEUES,
  withRetry,
};
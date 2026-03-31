-- ═══════════════════════════════════════════════════════════════════
--  Multi-Agent AI System — Database Schema
-- ═══════════════════════════════════════════════════════════════════

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for full-text search on memory

-- ─── Enums ──────────────────────────────────────────────────────────
CREATE TYPE task_status AS ENUM (
  'received', 'classified', 'routed', 'executing', 'completed', 'failed', 'dead_letter'
);

CREATE TYPE task_priority AS ENUM ('low', 'normal', 'high', 'critical');

CREATE TYPE event_type AS ENUM (
  'webhook_received', 'classification_done', 'routing_done',
  'execution_started', 'execution_completed', 'execution_failed',
  'notification_sent', 'retry_attempted', 'dead_lettered'
);

-- ─── Tasks (main work queue) ─────────────────────────────────────────
CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_id     TEXT,                           -- caller's own ID
  source          TEXT NOT NULL,                  -- webhook source tag
  payload         JSONB NOT NULL,
  status          task_status NOT NULL DEFAULT 'received',
  priority        task_priority NOT NULL DEFAULT 'normal',
  classification  TEXT,                           -- AI-assigned class
  confidence      NUMERIC(4,3),                   -- 0.000–1.000
  assigned_agent  TEXT,                           -- which executor handled it
  result          JSONB,
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_tasks_status        ON tasks(status);
CREATE INDEX idx_tasks_priority      ON tasks(priority DESC, created_at ASC);
CREATE INDEX idx_tasks_created_at    ON tasks(created_at DESC);
CREATE INDEX idx_tasks_classification ON tasks(classification);

-- ─── Task Events (audit trail) ───────────────────────────────────────
CREATE TABLE task_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type  event_type NOT NULL,
  agent_name  TEXT,
  details     JSONB DEFAULT '{}',
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_events_task_id    ON task_events(task_id);
CREATE INDEX idx_task_events_created_at ON task_events(created_at DESC);

-- ─── Agent Memory (persistent context across runs) ───────────────────
CREATE TABLE agent_memory (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_name  TEXT NOT NULL,
  memory_key  TEXT NOT NULL,
  memory_value JSONB NOT NULL,
  tags        TEXT[] DEFAULT '{}',
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_name, memory_key)
);

CREATE INDEX idx_memory_agent_key   ON agent_memory(agent_name, memory_key);
CREATE INDEX idx_memory_tags        ON agent_memory USING GIN(tags);
CREATE INDEX idx_memory_expires     ON agent_memory(expires_at) WHERE expires_at IS NOT NULL;
-- Full-text search on memory values
CREATE INDEX idx_memory_value_text  ON agent_memory USING GIN(memory_value jsonb_path_ops);

-- ─── Classification History (for AI model improvement) ───────────────
CREATE TABLE classification_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id         UUID REFERENCES tasks(id),
  raw_payload     JSONB NOT NULL,
  ai_class        TEXT NOT NULL,
  ai_confidence   NUMERIC(4,3),
  human_override  TEXT,
  model_used      TEXT,
  tokens_used     INTEGER,
  latency_ms      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_class_history_class ON classification_history(ai_class);
CREATE INDEX idx_class_history_date  ON classification_history(created_at DESC);

-- ─── Notifications Log ────────────────────────────────────────────────
CREATE TABLE notification_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id     UUID REFERENCES tasks(id),
  channel     TEXT NOT NULL,        -- 'slack', 'email', 'pagerduty'
  recipient   TEXT,
  subject     TEXT,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  sent_at     TIMESTAMPTZ,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notif_task_id   ON notification_log(task_id);
CREATE INDEX idx_notif_created   ON notification_log(created_at DESC);

-- ─── System Metrics (time-series snapshots) ──────────────────────────
CREATE TABLE system_metrics (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  agent_name      TEXT NOT NULL,
  tasks_processed INTEGER DEFAULT 0,
  tasks_failed    INTEGER DEFAULT 0,
  avg_latency_ms  NUMERIC(10,2),
  queue_depth     INTEGER DEFAULT 0,
  memory_entries  INTEGER DEFAULT 0
);

CREATE INDEX idx_metrics_recorded ON system_metrics(recorded_at DESC);
CREATE INDEX idx_metrics_agent    ON system_metrics(agent_name, recorded_at DESC);

-- ─── Webhooks Registry ────────────────────────────────────────────────
CREATE TABLE webhook_sources (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  secret_hash TEXT,                  -- hashed HMAC secret
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  rate_limit  INTEGER DEFAULT 100,   -- requests per minute
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a default source
INSERT INTO webhook_sources (name, description) VALUES
  ('default', 'Default webhook source'),
  ('github',  'GitHub event webhooks'),
  ('stripe',  'Stripe payment webhooks'),
  ('custom',  'Custom integrations');

-- ─── Auto-update timestamps ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_memory_updated_at
  BEFORE UPDATE ON agent_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Helpful views ────────────────────────────────────────────────────
CREATE VIEW task_summary AS
SELECT
  DATE_TRUNC('hour', created_at) AS hour,
  status,
  classification,
  COUNT(*) AS count,
  AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000)::INTEGER AS avg_duration_ms
FROM tasks
GROUP BY 1, 2, 3;

CREATE VIEW agent_health AS
SELECT
  agent_name,
  MAX(recorded_at) AS last_seen,
  SUM(tasks_processed) AS total_processed,
  SUM(tasks_failed) AS total_failed,
  AVG(avg_latency_ms)::NUMERIC(10,1) AS avg_latency_ms,
  AVG(queue_depth)::NUMERIC(10,1) AS avg_queue_depth
FROM system_metrics
WHERE recorded_at > NOW() - INTERVAL '24 hours'
GROUP BY agent_name;
# 🤖 Multi-Agent AI System with Memory

> **Mini Project** — A production-grade multi-agent AI pipeline built with Node.js, PostgreSQL, Redis, Docker, and Claude AI.

![Node.js](https://img.shields.io/badge/Node.js-20-green?style=flat-square&logo=node.js)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue?style=flat-square&logo=postgresql)
![Redis](https://img.shields.io/badge/Redis-7-red?style=flat-square&logo=redis)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker)
![Claude AI](https://img.shields.io/badge/Claude-AI-orange?style=flat-square)

---

## 📌 What Is This?

A fully automated event-processing pipeline where multiple AI agents work together to:

1. **Receive** webhook events from any source (Stripe, GitHub, custom apps)
2. **Classify** them using Claude AI into categories
3. **Route** them to the right handler based on type
4. **Execute** business logic with retry and timeout support
5. **Notify** your team via Slack, Email, or PagerDuty
6. **Monitor** everything on a real-time dashboard

This is how companies like Stripe, Uber, and GitHub process millions of events daily.

---

## 🏗️ Architecture

```
External Sources (Stripe, GitHub, Custom)
              │
              ▼
┌─────────────────────────────┐
│       Webhook API :3000     │  HMAC validation · rate limiting
│                             │  persists to PostgreSQL
└──────────────┬──────────────┘
               │ queue:incoming (Redis)
               ▼
┌─────────────────────────────┐
│     Classifier Agent        │  Claude AI · pattern memory
│                             │  10 categories · confidence scores
└──────────────┬──────────────┘
               │ queue:classified (Redis)
               ▼
┌─────────────────────────────┐
│       Router Agent          │  routing table · priority adjustment
│                             │  handler health checks
└──────────────┬──────────────┘
               │ queue:routed (Redis)
               ▼
┌─────────────────────────────┐
│      Executor Agent         │  9 handlers · retry + backoff
│                             │  timeout enforcement · dead-letter
└──────────────┬──────────────┘
               │ queue:notifications (Redis)
               ▼
┌─────────────────────────────┐
│      Notifier Agent         │  Slack · Email · PagerDuty
│                             │  deduplication · rate limiting
└─────────────────────────────┘

┌─────────────────────────────┐
│    Dashboard :4000          │  Real-time SSE · REST API
│                             │  Agent health · Queue depths
└─────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites
- [Node.js 20+](https://nodejs.org)
- [Docker Desktop](https://www.docker.com/products/docker-desktop)
- [Anthropic API Key](https://console.anthropic.com)

### 1. Clone the repository
```bash
git clone https://github.com/YOUR_USERNAME/multi-agent-ai-system.git
cd multi-agent-ai-system
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### 3. Install dependencies
```bash
npm install
```

### 4. Start all services
```bash
docker compose up -d --build
```

### 5. Verify health
```bash
curl http://localhost:3000/health
```

### 6. Send test webhooks
```bash
node scripts/test-webhook.js
```

### 7. Open the dashboard
```
http://localhost:4000
```

---

## 📁 Project Structure

```
multi-agent-ai/
├── agents/
│   ├── classifier.js          # AI classification agent
│   ├── router.js              # Task routing agent
│   ├── executor.js            # Task execution agent
│   ├── Dockerfile.classifier
│   ├── Dockerfile.router
│   └── Dockerfile.executor
├── api/
│   ├── server.js              # Webhook ingestion API
│   └── Dockerfile
├── db/
│   └── init.sql               # PostgreSQL schema (7 tables)
├── monitoring/
│   ├── dashboard.js           # Dashboard server
│   ├── public/index.html      # Real-time frontend
│   └── Dockerfile
├── notifications/
│   ├── notifier.js            # Slack/Email/PagerDuty agent
│   └── Dockerfile
├── scripts/
│   └── test-webhook.js        # Test suite
├── shared/
│   └── index.js               # Shared utilities
├── .env.example               # Environment template
├── docker-compose.yml         # 8-service orchestration
├── package.json
└── README.md
```

---

## 🔌 Webhook API

### POST `/webhook` — Submit a task

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "source": "stripe",
    "event_type": "payment.succeeded",
    "priority": "high",
    "data": {
      "id": "pay_123",
      "amount": 4999,
      "currency": "usd"
    }
  }'
```

**Response:**
```json
{
  "accepted": true,
  "task_id": "uuid-here",
  "status": "received",
  "estimated_processing": "< 30s"
}
```

### GET `/tasks/:id` — Check task status
```bash
curl http://localhost:3000/tasks/uuid-here
```

### GET `/stats` — Queue and task statistics
```bash
curl http://localhost:3000/stats
```

### POST `/tasks/:id/retry` — Retry a failed task
```bash
curl -X POST http://localhost:3000/tasks/uuid-here/retry
```

---

## 🧠 Task Classifications

| Category | Handler | Timeout | Trigger Keywords |
|---|---|---|---|
| `payment_event` | payment-handler | 15s | payment, charge, amount |
| `security_event` | security-handler | 8s | security, login, brute |
| `user_action` | user-handler | 10s | user, signup, account |
| `system_alert` | alert-handler | 5s | alert, cpu, memory |
| `order_lifecycle` | order-handler | 20s | order, ship, deliver |
| `report_generation` | report-handler | 120s | report, summary, analytics |
| `data_pipeline` | pipeline-handler | 60s | pipeline, data, etl |
| `content_moderation` | moderation-handler | 30s | content, moderate |
| `notification_request` | notify-handler | 5s | notify, notification |
| `unknown` | fallback-handler | 10s | anything else |

---

## 🗄️ Database Schema

```sql
tasks               -- main work queue with full status tracking
task_events         -- complete audit trail per task
agent_memory        -- persistent agent memory (key-value + TTL)
classification_history -- AI model usage and accuracy
notification_log    -- delivery history and errors
system_metrics      -- time-series agent health snapshots
webhook_sources     -- registered webhook sources
```

**Views:**
- `task_summary` — hourly rollup by status and classification
- `agent_health` — 24h agent health overview

---

## 🐳 Docker Services

| Service | Port | Description |
|---|---|---|
| `postgres` | 5432 | PostgreSQL 16 — persistent storage |
| `redis` | 6379 | Redis 7 — message queues |
| `webhook-api` | 3000 | Webhook ingestion API |
| `classifier-agent` | — | AI classification agent |
| `router-agent` | — | Task routing agent |
| `executor-agent` | — | Task execution agent |
| `notifier-agent` | — | Notification delivery agent |
| `dashboard` | 4000 | Real-time monitoring dashboard |

---

## 🔔 Notifications

Configure in `.env`:

| Channel | Variable | When |
|---|---|---|
| Slack | `SLACK_WEBHOOK_URL` | High/critical tasks + failures |
| Email | `SMTP_*` + `NOTIFY_EMAIL` | Failures and completions |
| PagerDuty | `PAGERDUTY_ROUTING_KEY` | Critical alerts only |

---

## 📊 Dashboard

Real-time monitoring at `http://localhost:4000`:

- **Overview** — Completed, Processing, Failed, Queue depth stats
- **Agents** — Health metrics for each agent (latency, throughput)
- **Events** — Full audit trail of every task in real-time
- **Notifications** — Delivery log for all channels

Auto-refreshes every 3 seconds via Server-Sent Events (SSE).

---

## 📋 Useful Commands

```bash
# Start all services
docker compose up -d

# Stop all services
docker compose down

# View all logs
docker compose logs -f

# View specific agent logs
docker compose logs -f classifier-agent

# Rebuild a specific service
docker compose build --no-cache classifier-agent

# Check container status
docker compose ps

# Reset everything (wipes database)
docker compose down -v
docker compose up -d --build

# Run test suite
node scripts/test-webhook.js
```

---

## 🔧 Environment Variables

| Variable | Description | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude AI API key | Yes |
| `POSTGRES_PASSWORD` | Database password | Yes |
| `REDIS_PASSWORD` | Redis password | Yes |
| `WEBHOOK_SECRET` | HMAC signing secret | No |
| `SLACK_WEBHOOK_URL` | Slack notifications | No |
| `SMTP_*` | Email notifications | No |
| `PAGERDUTY_ROUTING_KEY` | PagerDuty alerts | No |

---

## 🛡️ Security Features

- **HMAC-SHA256** webhook signature validation
- **Rate limiting** — 200 requests/minute per IP
- **Environment variables** for all secrets
- **`.env` gitignored** — secrets never committed
- **Timing-safe** signature comparison

---

## 🔄 Resilience Features

- **Retry with exponential backoff** — up to 3 attempts
- **Dead letter queue** — failed tasks preserved for inspection
- **Health checks** — Docker waits for dependencies
- **Graceful shutdown** — SIGTERM handled cleanly
- **Redis reconnection** — automatic on disconnect
- **Pattern caching** — reduces AI API calls

---

## 📚 Tech Stack

| Technology | Purpose |
|---|---|
| Node.js 20 | Runtime for all agents |
| Express.js | Webhook API framework |
| PostgreSQL 16 | Persistent storage + agent memory |
| Redis 7 | Message queue between agents |
| Claude AI (Anthropic) | Task classification |
| Docker Compose | Service orchestration |
| Winston | Structured JSON logging |
| ioredis | Redis client |
| node-postgres (pg) | PostgreSQL client |
| nodemailer | Email notifications |

---

## 👨‍💻 Author

Built as **Day 46 Mini Project** — learning production-grade multi-agent AI systems.

---

## 📄 License

MIT License — free to use and modify.

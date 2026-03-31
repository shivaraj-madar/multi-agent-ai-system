/**
 * scripts/test-webhook.js
 * Send test webhook payloads to validate the full pipeline
 */

const crypto = require("crypto");

const API_URL = process.env.API_URL || "http://localhost:3000";
const WEBHOOK_SECRET = "multiagent_webhook_secret_2024";

const testPayloads = [
  {
    name: "Payment Event",
    body: {
      source: "stripe",
      event_type: "payment.succeeded",
      priority: "high",
      data: {
        id: "pay_test_" + Date.now(),
        amount: 4999,
        currency: "usd",
        customer: "cus_test123",
        status: "succeeded",
      },
    },
  },
  {
    name: "Security Alert",
    body: {
      source: "security-monitor",
      event_type: "suspicious_login",
      priority: "critical",
      data: {
        user_id: "usr_abc123",
        ip: "192.168.1.99",
        location: "Unknown",
        attempts: 5,
        event_type: "brute_force_attempt",
      },
    },
  },
  {
    name: "User Action",
    body: {
      source: "app-backend",
      event_type: "user.signup",
      priority: "normal",
      data: {
        user_id: "usr_new_" + Date.now(),
        email: "test@example.com",
        action: "account_created",
        plan: "pro",
      },
    },
  },
  {
    name: "System Alert",
    body: {
      source: "monitoring",
      event_type: "cpu_spike",
      priority: "high",
      data: {
        severity: "critical",
        alert_type: "cpu_overload",
        host: "worker-01",
        cpu_pct: 98,
        duration_seconds: 120,
      },
    },
  },
  {
    name: "Report Generation",
    body: {
      source: "scheduler",
      event_type: "report.requested",
      priority: "low",
      data: {
        report_type: "daily_summary",
        date_range: "last_7_days",
        format: "json",
        recipient: "team@company.com",
      },
    },
  },
  {
    name: "Order Lifecycle",
    body: {
      source: "ecommerce",
      event_type: "order.shipped",
      priority: "normal",
      data: {
        order_id: "ord_" + Date.now(),
        status: "shipped",
        tracking: "1Z999AA1012345678",
        items: 3,
        total: 129.99,
      },
    },
  },
];

const signPayload = (body) => {
  const str = JSON.stringify(body);
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(str).digest("hex");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sendWebhook = async (test) => {
  const sig = signPayload(test.body);
  try {
    const res = await fetch(`${API_URL}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": sig,
      },
      body: JSON.stringify(test.body),
    });
    const data = await res.json();
    console.log(`✅ ${test.name}: ${res.status} — task_id: ${data.task_id || "error"}`);
    return data.task_id;
  } catch (err) {
    console.error(`❌ ${test.name}: ${err.message}`);
    return null;
  }
};

const checkStatus = async (taskId) => {
  if (!taskId) return;
  await sleep(3000); // give agents time to process
  try {
    const res = await fetch(`${API_URL}/tasks/${taskId}`);
    const data = await res.json();
    const { task } = data;
    console.log(
      `   └── Status: ${task.status} | Class: ${task.classification || "pending"} | Confidence: ${task.confidence || "—"}`
    );
  } catch (err) {
    console.log(`   └── Status check failed: ${err.message}`);
  }
};

const checkStats = async () => {
  try {
    const res = await fetch(`${API_URL}/stats`);
    const data = await res.json();
    console.log("\n📊 Queue depths:");
    data.queues.forEach((q) => {
      if (q.depth > 0) console.log(`   ${q.queue}: ${q.depth}`);
    });
    console.log("\n📋 Task stats (24h):");
    data.taskStats.forEach((s) => console.log(`   ${s.status}: ${s.count}`));
  } catch (err) {
    console.error("Stats error:", err.message);
  }
};

const run = async () => {
  console.log("🚀 Multi-Agent System — Webhook Test Suite");
  console.log("=".repeat(50));

  // Check health first
  try {
    const health = await fetch(`${API_URL}/health`);
    const data = await health.json();
    console.log(`\n🔍 Health: ${data.status}\n`);
  } catch {
    console.error("❌ API not reachable — is docker compose up?");
    process.exit(1);
  }

  const taskIds = [];
  for (const test of testPayloads) {
    const taskId = await sendWebhook(test);
    if (taskId) taskIds.push({ name: test.name, taskId });
    await sleep(500); // small delay between sends
  }

  console.log("\n⏳ Waiting for processing...\n");
  await sleep(5000);

  console.log("📝 Task statuses:");
  for (const { name, taskId } of taskIds) {
    console.log(`\n${name} (${taskId}):`);
    await checkStatus(taskId);
  }

  console.log("\n");
  await checkStats();

  console.log("\n✅ Test complete! View dashboard at http://localhost:4000");
};

run().catch(console.error);
/**
 * notifications/notifier.js
 * Notifier Agent — delivers notifications via Slack, Email, and PagerDuty.
 * Rate-limits, deduplicates, and persists all notification history.
 */

const nodemailer = require("nodemailer");
const {
  createLogger,
  createDbPool,
  createRedisClient,
  AgentMemory,
  QUEUES,
} = require("../shared");

const AGENT_NAME = "notifier-agent";
const log = createLogger(AGENT_NAME);
const db = createDbPool(log);
const redis = createRedisClient(log, "notif-sub");
const memory = new AgentMemory(db, AGENT_NAME, log);

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimiter = new Map(); // channel → { count, resetAt }

const checkRateLimit = (channel) => {
  const now = Date.now();
  const limit = rateLimiter.get(channel) || { count: 0, resetAt: now + 60000 };
  if (now > limit.resetAt) {
    limit.count = 0;
    limit.resetAt = now + 60000;
  }
  if (limit.count >= 10) return false; // max 10/min per channel
  limit.count++;
  rateLimiter.set(channel, limit);
  return true;
};

// ─── Deduplication ────────────────────────────────────────────────────────────
const isDuplicate = async (taskId, channel) => {
  const key = `notif_sent:${taskId}:${channel}`;
  const sent = await memory.get(key);
  if (sent) return true;
  await memory.set(key, { sentAt: Date.now() }, ["notification"], 3600);
  return false;
};

// ─── Slack notification ────────────────────────────────────────────────────────
const sendSlack = async (message) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    log.warn("SLACK_WEBHOOK_URL not configured, skipping");
    return { skipped: true, reason: "not_configured" };
  }

  const color = { critical: "#FF0000", high: "#FF6600", normal: "#36A64F" }[message.urgency] || "#36A64F";

  const payload = {
    username: "Multi-Agent System",
    icon_emoji: ":robot_face:",
    channel: process.env.SLACK_CHANNEL || "#alerts",
    attachments: [
      {
        color,
        title: message.title,
        text: message.body,
        footer: `Task ID: ${message.taskId} | ${new Date().toISOString()}`,
        footer_icon: "https://platform.slack-edge.com/img/default_application_icon.png",
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Slack returned ${res.status}: ${await res.text()}`);
  return { delivered: true, channel: "slack" };
};

// ─── Email notification ────────────────────────────────────────────────────────
let mailerTransport = null;
const getMailer = () => {
  if (!mailerTransport) {
    mailerTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return mailerTransport;
};

const sendEmail = async (message) => {
  if (!process.env.SMTP_USER) {
    log.warn("SMTP not configured, skipping email");
    return { skipped: true, reason: "not_configured" };
  }

  const mailer = getMailer();
  const info = await mailer.sendMail({
    from: `"Multi-Agent System" <${process.env.SMTP_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject: `[${message.urgency?.toUpperCase() || "INFO"}] ${message.title}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px;">
        <h2>${message.title}</h2>
        <p><strong>Task ID:</strong> ${message.taskId}</p>
        <p><strong>Urgency:</strong> ${message.urgency}</p>
        <hr />
        <pre style="background: #f5f5f5; padding: 16px; border-radius: 4px;">${message.body}</pre>
        <p style="color: #888; font-size: 12px;">Sent at ${new Date().toISOString()}</p>
      </div>
    `,
    text: `${message.title}\n\nTask: ${message.taskId}\nUrgency: ${message.urgency}\n\n${message.body}`,
  });

  return { delivered: true, messageId: info.messageId, channel: "email" };
};

// ─── PagerDuty notification ────────────────────────────────────────────────────
const sendPagerDuty = async (message) => {
  const routingKey = process.env.PAGERDUTY_ROUTING_KEY;
  if (!routingKey) {
    log.warn("PAGERDUTY_ROUTING_KEY not configured, skipping");
    return { skipped: true, reason: "not_configured" };
  }

  const payload = {
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: message.taskId,
    payload: {
      summary: message.title,
      severity: message.urgency === "critical" ? "critical" : "error",
      source: "multi-agent-system",
      custom_details: { body: message.body, task_id: message.taskId },
    },
  };

  const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`PagerDuty returned ${res.status}`);
  const data = await res.json();
  return { delivered: true, dedup_key: data.dedup_key, channel: "pagerduty" };
};

// ─── Route notification to channel ───────────────────────────────────────────
const deliverNotification = async (message) => {
  const { taskId, channel, urgency } = message;

  if (await isDuplicate(taskId, channel)) {
    log.debug("Duplicate notification suppressed", { taskId, channel });
    return;
  }

  if (!checkRateLimit(channel)) {
    log.warn("Rate limit hit, dropping notification", { channel });
    return;
  }

  const notifRow = await db.query(
    `INSERT INTO notification_log (task_id, channel, subject, body)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [taskId, channel, message.title, message.body]
  );
  const notifId = notifRow.rows[0].id;

  let result;
  try {
    switch (channel) {
      case "slack":     result = await sendSlack(message);     break;
      case "email":     result = await sendEmail(message);     break;
      case "pagerduty": result = await sendPagerDuty(message); break;
      default:
        log.warn("Unknown notification channel", { channel });
        result = { skipped: true, reason: "unknown_channel" };
    }

    await db.query(
      `UPDATE notification_log SET status = 'sent', sent_at = NOW() WHERE id = $1`,
      [notifId]
    );

    log.info("Notification delivered", { taskId, channel, urgency, ...result });
  } catch (err) {
    await db.query(
      `UPDATE notification_log SET status = 'failed', error = $2 WHERE id = $1`,
      [notifId, err.message]
    );
    log.error("Notification failed", { taskId, channel, error: err.message });
    throw err;
  }
};

// ─── Consumer loop ─────────────────────────────────────────────────────────────
const run = async () => {
  log.info("Notifier agent started");

  while (true) {
    try {
      const result = await redis.brpop(QUEUES.NOTIFICATIONS, 5);
      if (!result) continue;

      const [, raw] = result;
      const message = JSON.parse(raw);

      await deliverNotification(message).catch((err) => {
        log.error("Notification delivery failed permanently", { error: err.message });
      });
    } catch (err) {
      log.error("Notifier consumer error", { error: err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};

run().catch((err) => {
  log.error("Fatal notifier error", { error: err.message });
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await db.end();
  await redis.quit();
  process.exit(0);
});
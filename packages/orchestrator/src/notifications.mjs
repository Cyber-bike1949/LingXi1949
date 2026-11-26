const secretPatterns = [
  /(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
  /(?:token|secret|password|webhook)\s*[:=]\s*[^\s,;]+/gi
];

export function notificationConfig(runtime, env = process.env) {
  const variable = runtime?.notifications?.feishuWebhookEnv;
  if (!variable) return { enabled: false, reason: 'FEISHU_WEBHOOK_ENV_NOT_CONFIGURED' };
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(variable)) throw new Error('FEISHU_WEBHOOK_ENV_NAME_INVALID');
  const urlValue = env[variable];
  if (!urlValue) return { enabled: false, reason: 'FEISHU_WEBHOOK_SECRET_MISSING' };
  let url;
  try { url = new URL(urlValue); } catch { throw new Error('FEISHU_WEBHOOK_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)(feishu\.cn|larksuite\.com)$/i.test(url.hostname)) throw new Error('FEISHU_WEBHOOK_HOST_NOT_ALLOWED');
  return { enabled: true, url: urlValue };
}

function safeText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(secretPatterns[0], '[redacted]').replace(secretPatterns[1], '[redacted]').slice(0, 500);
}

export function feishuText(payload) {
  const parts = [
    `LingXi 研发任务：${safeText(payload.title)}`,
    `任务：${safeText(payload.taskId)}`,
    `状态：${safeText(payload.state)}`,
    payload.reason ? `原因：${safeText(payload.reason)}` : '',
    payload.retryAt ? `预计唤醒：${safeText(payload.retryAt)}` : ''
  ].filter(Boolean);
  return parts.join('\n');
}

export async function flushNotificationOutbox(store, { config, fetchImpl = fetch, now = Date.now(), maxAttempts = 8 } = {}) {
  if (!config?.enabled) return { skipped: true, reason: config?.reason ?? 'NOTIFICATION_DISABLED', sent: 0, failed: 0 };
  let sent = 0; let failed = 0;
  for (const item of store.pendingNotifications(now)) {
    try {
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: feishuText(item.payload) } }),
        signal: AbortSignal.timeout(10_000)
      });
      let body = {};
      try { body = await response.json(); } catch {}
      if (!response.ok || (body.code !== undefined && body.code !== 0)) throw new Error(`FEISHU_HTTP_${response.status}_CODE_${body.code ?? 'UNKNOWN'}`);
      store.markNotificationSent(item.id);
      store.event(item.task_id, 'NOTIFICATION_SENT', { eventType: item.event_type, outboxId: item.id });
      sent += 1;
    } catch (error) {
      const delay = Math.min(60 * 60_000, 1000 * (2 ** Math.min(item.attempts, 12)));
      const retryAt = new Date(now + delay).toISOString();
      const result = store.markNotificationFailed(item.id, error instanceof Error ? error.message : 'NOTIFICATION_FAILED', retryAt, maxAttempts);
      store.event(item.task_id, result.dead ? 'NOTIFICATION_DEAD' : 'NOTIFICATION_RETRY_SCHEDULED', { eventType: item.event_type, outboxId: item.id, attempts: result.attempts, retryAt });
      failed += 1;
    }
  }
  return { sent, failed };
}

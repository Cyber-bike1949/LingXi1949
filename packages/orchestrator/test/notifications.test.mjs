import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationConfig, flushNotificationOutbox } from '../src/notifications.mjs';
import { OrchestratorStore } from '../src/store.mjs';

function taskStore() {
  const store = new OrchestratorStore(':memory:');
  const task = store.createTask({ id: 'RND-NOTIFY', title: 'Notification test', repository: 'owner/repo', branch: 'feat/notify', baseSha: 'abc', requirementHash: 'r', testCaseHash: 't' });
  store.transition(task.id, 'IMPLEMENTING');
  return { store, task };
}

test('loads Feishu hook only from a valid secret environment variable', () => {
  assert.equal(notificationConfig({ notifications: {} }, {}).enabled, false);
  assert.throws(() => notificationConfig({ notifications: { feishuWebhookEnv: 'HOOK' } }, { HOOK: 'http://example.com/x' }), /HOST_NOT_ALLOWED/);
  assert.equal(notificationConfig({ notifications: { feishuWebhookEnv: 'FEISHU_HOOK' } }, { FEISHU_HOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/example' }).enabled, true);
});

test('retries an Outbox delivery without blocking task progress and records success', async () => {
  const { store, task } = taskStore();
  const event = store.events(task.id).find(item => item.type === 'STATE_CHANGED');
  assert.equal(event.data.state, 'IMPLEMENTING');
  let count = 0;
  const failed = await flushNotificationOutbox(store, { config: { enabled: true, url: 'https://open.feishu.cn/hook' }, now: Date.now(), fetchImpl: async () => { count += 1; throw new Error('temporary'); } });
  assert.equal(failed.failed, 1);
  const pending = store.pendingNotifications(Date.now() + 2000);
  assert.equal(pending.length, 1);
  const sent = await flushNotificationOutbox(store, { config: { enabled: true, url: 'https://open.feishu.cn/hook' }, now: Date.now() + 2000, fetchImpl: async (_url, request) => { count += 1; assert.equal(JSON.parse(request.body).msg_type, 'text'); return { ok: true, status: 200, json: async () => ({ code: 0 }) }; } });
  assert.equal(sent.sent, 1);
  assert.equal(store.notifications(task.id)[0].status, 'SENT');
  assert.equal(count, 2);
  store.close();
});

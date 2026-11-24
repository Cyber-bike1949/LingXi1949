import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorStore } from '../src/store.mjs';
import { approvedTaskInput, serve } from '../src/server.mjs';

test('serves a loopback-only read-only dashboard and task API', async () => {
  const store = new OrchestratorStore(':memory:');
  store.createTask({ id: 'RND-DASH', title: 'Dashboard', repository: 'owner/repo', branch: 'feat/dashboard', baseSha: 'abc', requirementHash: 'req', testCaseHash: 'tc' });
  const server = await serve(store, 0); const port = server.address().port;
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(await page.text(), /LingXi 编排器/);
  store.event('RND-DASH', 'DIAGNOSTIC', { stdout: 'private agent output', reason: 'QUOTA_WAIT', nested: { authorization: 'Bearer secret' } });
  const detail = await fetch(`http://127.0.0.1:${port}/tasks/RND-DASH`).then(response => response.json());
  const publicEvent = detail.events.at(-1);
  assert.equal(publicEvent.data.reason, 'QUOTA_WAIT');
  assert.equal('stdout' in publicEvent.data, false);
  assert.equal('authorization' in publicEvent.data.nested, false);
  const tasks = await fetch(`http://127.0.0.1:${port}/tasks`);
  assert.equal((await tasks.json())[0].id, 'RND-DASH');
  const write = await fetch(`http://127.0.0.1:${port}/tasks`, { method: 'POST' });
  assert.equal(write.status, 405);
  await new Promise(resolve => server.close(resolve)); store.close();
});

test('protects task creation and execution behind a bearer token and explicit approval', async () => {
  const store = new OrchestratorStore(':memory:');
  const token = 'test-token-with-more-than-thirty-two-characters';
  let runCalls = 0;
  const server = await serve(store, {
    port: 0,
    authToken: token,
    createTask: input => store.createTask(approvedTaskInput({ id: 'RND-WEB', repository: 'owner/repo', branch: 'feat/RND-WEB', baseSha: 'a'.repeat(40), ...input })),
    runTask: async id => { runCalls++; return { id, started: true }; }
  });
  const root = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(root)).status, 200);
  assert.equal((await fetch(`${root}/tasks`)).status, 401);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const unapproved = await fetch(`${root}/tasks`, { method: 'POST', headers, body: JSON.stringify({ title: 'Demo', approvedBy: 'owner', requirement: 'R', testCases: 'T' }) });
  assert.equal(unapproved.status, 400);
  const created = await fetch(`${root}/tasks`, { method: 'POST', headers, body: JSON.stringify({ title: 'Demo', approvedBy: 'owner', requirement: 'R', testCases: 'T', confirmed: true }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).id, 'RND-WEB');
  assert.equal((await fetch(`${root}/tasks/RND-WEB/run`, { method: 'POST', headers })).status, 202);
  assert.equal(runCalls, 1);
  await new Promise(resolve => server.close(resolve)); store.close();
});

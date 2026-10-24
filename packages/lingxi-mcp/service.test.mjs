import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from './store.mjs';
import { TaskService } from './service.mjs';
import { callTool, serveStdio } from './protocol.mjs';
import { PassThrough } from 'node:stream';
import { LingxiTransportAdapter } from '../remote-sdk/dist/index.mjs';

const binding = { deviceId: 'device-c', agentFingerprint: 'device-c', sessionId: 'session-1', bindingVersion: 'v1', workDir: '/workspace/demo', shell: '/bin/sh' };
function setup(request) {
  const store = new TaskStore(':memory:');
  const adapter = { connected: true, request, close() { this.connected = false; } };
  return { store, service: new TaskService(adapter, store, binding, 'selection-1') };
}

test('idempotency persists results and rejects different payloads', async () => {
  let count = 0;
  const { store, service } = setup(async () => { count++; return { status: 'SUCCESS' }; });
  const input = { action: 'fs.write', requestId: 'r1', path: 'file', content: 'hello' };
  const first = await service.run(input);
  const second = await service.run(input);
  assert.equal(first.task_id, second.task_id); assert.equal(count, 1);
  await assert.rejects(service.run({ ...input, content: 'changed' }), /REQUEST_ID_CONFLICT/);
  store.close();
});

test('disconnect preserves partial UTF-8 output and never retries', async () => {
  let count = 0;
  const { store, service } = setup(async (_, { onOutput }) => {
    count++; const bytes = Buffer.from('你好');
    onOutput('stdout', bytes.subarray(0, 2)); onOutput('stdout', bytes.subarray(2));
    throw new Error('disconnected');
  });
  const input = { action: 'command.run', requestId: 'r2', command: 'test' };
  const task = await service.run(input);
  assert.equal(task.status, 'UNKNOWN'); assert.equal(task.stdout, '你好');
  await service.run(input); assert.equal(count, 1); store.close();
});

test('recovery marks pending tasks unknown within their own selection', () => {
  const store = new TaskStore(':memory:');
  const a = store.begin('a', binding, { requestId: 'a', action: 'command.run' }).task;
  const b = store.begin('b', binding, { requestId: 'b', action: 'command.run' }).task;
  store.running(a.task_id); store.running(b.task_id); store.recover('a');
  assert.equal(store.get('a', a.task_id).status, 'UNKNOWN');
  assert.equal(store.get('b', b.task_id).status, 'RUNNING'); store.close();
});

test('cancel waits for remote confirmation and does not expose another session', async () => {
  const { store, service } = setup((_, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'CANCELLED' }))));
  const pending = service.run({ action: 'command.run', requestId: 'cancel', command: 'sleep 10' });
  const task = store.list('selection-1')[0];
  assert.equal(service.cancel(task.task_id).status, 'RUNNING');
  assert.equal((await pending).status, 'CANCELLED');
  assert.throws(() => service.cancel('other-task'), /UNKNOWN_TASK/); store.close();
});

test('MCP tools forbid overriding device or binding and validate optional inputs', async () => {
  const { store, service } = setup(async () => ({ status: 'SUCCESS' }));
  for (const args of [
    { requestId: 'r', command: 'pwd', deviceId: 'device-d' },
    { requestId: 'r', command: 'pwd', timeoutMs: -1 },
    { requestId: 'r', command: '' },
  ]) await assert.rejects(callTool(service, 'remote_exec', args));
  assert.equal(JSON.parse((await callTool(service, 'remote_target')).content[0].text).deviceId, 'device-c');
  store.close();
});

test('stdio negotiates, lists tools and handles malformed input without polluting stdout', async () => {
  const { store, service } = setup(async () => ({ status: 'SUCCESS' }));
  const input = new PassThrough(); const output = new PassThrough(); let bytes = '';
  output.on('data', chunk => { bytes += chunk; });
  const ended = serveStdio(service, input, output);
  input.write('bad json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  input.end(); await ended;
  const messages = bytes.trim().split('\n').map(JSON.parse);
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[1].result.protocolVersion, '2025-11-25');
  assert.equal(messages[2].result.tools.length, 8); store.close();
});

test('SDK checks authenticated peer before any request', () => {
  assert.throws(() => new LingxiTransportAdapter({ remoteId: () => ({ toString: () => 'wrong-device' }) }, 'device-c'), /DEVICE_ID_MISMATCH/);
});

import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
const exec = promisify(execFile);
const cliPath = resolve('packages/lingxi-mcp/cli.mjs');
const agentPath = resolve('agent/target/debug/lingxi1949');
const root = await mkdtemp(join(tmpdir(), 'lingxi-mcp-e2e-'));
const children = [];
let operations = 0;

async function agent(name) {
  const config = join(root, `config-${name}`); const work = join(root, `work-${name}`);
  const runtime = join(root, `runtime-${name}`);
  await mkdir(work);
  await mkdir(runtime, { mode: 0o700 });
  const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime };
  await exec(agentPath, ['config', 'set-receive-root', work], { env });
  const child = spawn(agentPath, ['run', '--loopback'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let logs = ''; child.stderr.on('data', b => { logs += b; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Agent startup timed out: ${logs}`)), 20000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { const value = line.trim(); if (value.startsWith('endpoint')) { clearTimeout(timer); resolve(value); } });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Agent exited ${code}: ${logs}`)); });
  });
  return { child, code, work };
}
async function cli(home, ...args) {
  const { stdout } = await exec(process.execPath, [cliPath, ...args, '--home', home, '--loopback', 'true'], { timeout: 40000 });
  return JSON.parse(stdout);
}
async function prepare(target, name) {
  const home = join(root, `model-${name}`); const ticket = join(root, `${name}.ticket`);
  await writeFile(ticket, target.code);
  await cli(home, 'init');
  const paired = await cli(home, 'pair', '--name', name, '--ticket-file', ticket);
  const selected = await cli(home, 'select', '--device', paired.deviceId, '--workdir', target.work, '--shell', '/bin/sh');
  assert.equal(selected.deviceId, paired.deviceId);
  const child = spawn(process.execPath, [cliPath, 'serve', '--session', selected.session, '--home', home, '--loopback', 'true'], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let logs = ''; child.stderr.on('data', bytes => { logs += bytes; });
  const pending = new Map(); let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) { const wait = pending.get(message.id); if (wait) { clearTimeout(wait.timer); pending.delete(message.id); message.error ? wait.reject(new Error(JSON.stringify(message.error))) : wait.resolve(message.result); } }
  });
  child.on('exit', code => { for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error(`MCP exited ${code}: ${logs}`)); } pending.clear(); });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout ${method}: ${logs}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lingxi-e2e', version: '1' } });
  assert.equal((await rpc('tools/list')).tools.length, 8);
  const call = async (name, args = {}) => {
    operations++;
    const result = await rpc('tools/call', { name, arguments: args });
    return JSON.parse(result.content[0].text);
  };
  return { home, child, call, session: selected.session };
}
try {
  const [c, d] = await Promise.all([agent('c'), agent('d')]);
  const [b1, b2] = await Promise.all([prepare(c, 'c'), prepare(d, 'd')]);
  const [tc, td] = await Promise.all([b1.call('remote_target'), b2.call('remote_target')]);
  assert.notEqual(tc.deviceId, td.deviceId);
  const writes = await Promise.all([b1.call('remote_write', { requestId: 'write', path: 'test.txt', content: '设备 C' }), b2.call('remote_write', { requestId: 'write', path: 'test.txt', content: 'device D' })]);
  assert.equal(writes[0].status, 'SUCCESS'); assert.equal(writes[1].status, 'SUCCESS');
  assert.equal(await readFile(join(c.work, 'test.txt'), 'utf8'), '设备 C');
  assert.equal(await readFile(join(d.work, 'test.txt'), 'utf8'), 'device D');
  const duplicate = await b1.call('remote_write', { requestId: 'write', path: 'test.txt', content: '设备 C' });
  assert.equal(duplicate.task_id, writes[0].task_id);
  const read = await b1.call('remote_read', { requestId: 'read', path: 'test.txt' });
  assert.equal(read.result.result.content, '设备 C');
  const command = await b1.call('remote_exec', { requestId: 'exec', command: 'printf stdout; printf stderr >&2; exit 7' });
  assert.equal(command.status, 'FAILED'); assert.equal(command.stdout, 'stdout'); assert.equal(command.stderr, 'stderr'); assert.equal(command.result.exitCode, 7);
  const timed = await b1.call('remote_exec', { requestId: 'timeout', command: 'sleep 10', timeoutMs: 30 });
  assert.equal(timed.status, 'TIMED_OUT');
  const waiting = b1.call('remote_exec', { requestId: 'cancel', command: 'sleep 10' });
  let active;
  for (let i = 0; i < 50 && !active; i++) {
    active = (await b1.call('remote_tasks')).find(t => t.request_id === 'cancel' && t.status === 'RUNNING');
    if (!active) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(active); await b1.call('remote_cancel', { taskId: active.task_id }); assert.equal((await waiting).status, 'CANCELLED');
  const listing = await b1.call('remote_list', { requestId: 'list', path: '.' }); assert.equal(listing.status, 'SUCCESS');
  const snapshot = JSON.parse(await readFile(join(b1.home, 'tasks.json'), 'utf8')); assert.ok(snapshot.tasks.some(t => t.status === 'CANCELLED'));
  const deletion = await b2.call('remote_delete', { requestId: 'delete', path: 'test.txt' }); assert.equal(deletion.status, 'SUCCESS');
  const lost = b1.call('remote_exec', { requestId: 'disconnect', command: 'printf started; sleep 30' });
  for (let i = 0; i < 50; i++) {
    const task = (await b1.call('remote_tasks')).find(t => t.request_id === 'disconnect');
    if (task?.stdout.includes('started')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const exited = [once(b1.child, 'exit'), once(b2.child, 'exit')];
  b1.child.stdin.end(); assert.equal((await lost).status, 'UNKNOWN');
  b2.child.stdin.end();
  await Promise.all(exited);
  console.log(`PASS: ${operations} MCP calls across two real Rust Agents; identity, isolation, files, exit, cancellation, timeout, disconnect, SQLite and snapshot verified.`);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000))]); }
  await rm(root, { recursive: true, force: true });
}

// Run with Node 24+ after building the remote SDK and Agent.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import * as iroh from '@number0/iroh';
import { DeviceConnectionManager } from '../src/services/remote/deviceConnections.ts';
import { PairedDeviceStore } from '../src/services/remote/pairedDeviceStore.ts';
import { decodeAiCliBindingOsc } from '../src/services/remote/aiCliBinding.ts';
import { aiBindingStartSequence } from '../../remote/packages/lingxi-mcp/terminal-binding.mjs';
import { LingxiTransportAdapter } from '../../remote/packages/remote-sdk/dist/index.mjs';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'lingxi-tree-binding-'));
const agentPath = process.env.LINGXI_AGENT_BINARY ?? fileURLToPath(new URL('../../remote/agent/target/debug/lingxi1949', import.meta.url));
const workDir = join(root, 'workspace');
const runtime = join(root, 'runtime');
const config = join(root, 'config');
const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, APPDATA: config, LOCALAPPDATA: config };
let child, endpoint, manager;
try {
  await mkdir(workDir);
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(join(workDir, 'notes'));
  await writeFile(join(workDir, 'notes', 'example.md'), '# Example');
  await exec(agentPath, ['config', 'set-receive-root', workDir], { env });
  child = spawn(agentPath, ['run', '--loopback'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', bytes => { logs += bytes; });
  const ticket = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error(`Agent startup timeout: ${logs}`)), 20000);
    const done = (error, value) => {
      clearTimeout(timer);
      lines.close();
      error ? reject(error) : resolve(value);
    };
    lines.on('line', line => { if (line.trim().startsWith('endpoint')) done(null, line.trim()); });
    child.once('error', error => done(error));
    child.once('exit', code => done(new Error(`Agent exited ${code}: ${logs}`)));
  });
  const addr = iroh.EndpointTicket.fromString(ticket).endpointAddr();
  const deviceId = addr.id().toString();
  const builder = iroh.Endpoint.builder();
  iroh.presetMinimal(builder);
  builder.relayMode(iroh.RelayMode.disabled());
  builder.bindAddr('127.0.0.1:0');
  endpoint = await builder.bind();
  const connection = await endpoint.connect(addr, Array.from(Buffer.from('termy/terminal/1')));
  const controller = new LingxiTransportAdapter(connection, deviceId);
  await controller.bind(workDir, '/bin/sh');

  // The plugin has its own identity and no record of the controller's device.
  const store = new PairedDeviceStore();
  const identity = iroh.SecretKey.generate().toBytes();
  manager = new DeviceConnectionManager({
    loadIroh: async () => iroh, store, identitySeed: identity, profile: 'loopback',
    onIdentityCreated: () => assert.fail('Existing plugin identity must be preserved'),
  });
  const osc = aiBindingStartSequence({ session: 'session-1', deviceId, workDir, ticket });
  const binding = decodeAiCliBindingOsc(osc.slice('\x1b]1949;'.length, -1));
  assert.ok(binding?.ticket);
  await manager.connect(binding.deviceId, binding.ticket);
  const source = manager.createDirectoryTreeSource(binding.deviceId, binding.workDir);
  assert.ok((await source.list(binding.workDir)).some(entry => entry.name === 'notes' && entry.isDirectory));
  assert.ok((await source.list(join(binding.workDir, 'notes'))).some(entry => entry.name === 'example.md'));
  assert.equal(store.count(), 0);
  assert.equal((await controller.request({ action: 'probe', requestId: 'tree-check', timeoutMs: 15000 })).status, 'SUCCESS');
  console.log('PASS: AI session ticket browses real remote directories while the controller remains connected; plugin pairing and identity preserved.');
} finally {
  await manager?.dispose();
  await endpoint?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}

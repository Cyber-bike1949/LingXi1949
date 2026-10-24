#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as iroh from '@number0/iroh';
import { LingxiTransportAdapter, PairedDeviceStore, pairDevice, normalizeControllerIdentitySeed } from '../remote-sdk/dist/index.mjs';
import { TaskStore } from './store.mjs';
import { TaskService } from './service.mjs';
import { serveStdio } from './protocol.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const options = {};
while (args.length) {
  const key = args.shift();
  if (!key.startsWith('--') || !args.length) throw new Error(`Expected --option value: ${key}`);
  options[key.slice(2)] = args.shift();
}
const home = resolve(options.home ?? join(homedir(), '.lingxi-mcp'));
mkdirSync(home, { recursive: true, mode: 0o700 });
const profilePath = join(home, 'profile.json');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, data) => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
};
const required = key => { if (!options[key]) throw new Error(`Missing --${key}`); return options[key]; };
const print = data => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);

async function connect(profile, device) {
  const seed = normalizeControllerIdentitySeed(profile.seed);
  if (!seed) throw new Error('INVALID_CONTROLLER_IDENTITY');
  const address = iroh.EndpointTicket.fromString(device.ticket).endpointAddr();
  if (address.id().toString() !== device.nodeId) throw new Error('TICKET_ID_MISMATCH');
  const builder = iroh.Endpoint.builder();
  if (options.loopback === 'true') { iroh.presetMinimal(builder); builder.relayMode(iroh.RelayMode.disabled()); builder.bindAddr('127.0.0.1:0'); }
  else iroh.presetN0(builder);
  builder.secretKey(seed);
  const endpoint = await builder.bind();
  let timer;
  try {
    const connection = await Promise.race([endpoint.connect(address, Array.from(Buffer.from('termy/terminal/1'))), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CONNECT_TIMEOUT')), 30000); })]);
    return { endpoint, adapter: new LingxiTransportAdapter(connection, device.nodeId) };
  } catch (e) { await endpoint.close(); throw e; } finally { clearTimeout(timer); }
}

function sessionPath(id) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('INVALID_SESSION_NAME');
  return join(home, `session-${id}.json`);
}

function lock(id) {
  const path = `${sessionPath(id)}.lock`;
  try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('INVALID_SESSION_LOCK');
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') { unlinkSync(path); return lock(id); }
      throw error;
    }
    throw new Error('SESSION_ALREADY_RUNNING');
  }
  return () => unlinkSync(path);
}

async function main() {
  if (command === 'init') {
    try { read(profilePath); throw new Error('PROFILE_ALREADY_EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    save(profilePath, { seed: iroh.SecretKey.generate().toBytes(), devices: [] });
    print({ initialized: true, home }); return;
  }
  if (command === 'tasks') {
    const store = new TaskStore(join(home, 'tasks.sqlite'));
    try { print(store.list(options.session)); } finally { store.close(); }
    return;
  }
  if (command === 'config') {
    const id = required('session'); read(sessionPath(id));
    const argv = [fileURLToPath(import.meta.url), 'serve', '--home', home, '--session', id];
    print({ mcpServers: { lingxi: { command: process.execPath, args: argv } }, codex: { mcp_servers: { lingxi: { command: process.execPath, args: argv, startup_timeout_sec: 180, tool_timeout_sec: 3660 } } } }); return;
  }
  const profile = read(profilePath);
  const devices = PairedDeviceStore.fromJSON(profile.devices);
  if (command === 'pair') {
    const code = readFileSync(required('ticket-file'), 'utf8').trim();
    const paired = pairDevice(devices, ticket => ({ nodeId: iroh.EndpointTicket.fromString(ticket).endpointAddr().id().toString() }), code, required('name'));
    if (!paired.ok) throw new Error(paired.code);
    save(profilePath, { ...profile, devices: devices.toJSON() });
    print({ deviceId: paired.device.nodeId, name: paired.device.name }); return;
  }
  if (command === 'devices') {
    const result = [];
    for (const device of devices.list()) {
      let status = 'not-probed'; let error;
      if (options.probe === 'true') {
        try {
          const { endpoint, adapter } = await connect(profile, device);
          try {
            await adapter.request({ action: 'probe', requestId: randomUUID() });
            status = 'online';
          } finally { adapter.close(); await endpoint.close(); }
        } catch (e) { status = 'unavailable'; error = e.message; }
      }
      result.push({ deviceId: device.nodeId, name: device.name, status, error });
    }
    print(result); return;
  }
  if (command === 'select') {
    const device = devices.get(required('device'));
    if (!device) throw new Error('DEVICE_NOT_PAIRED');
    const { endpoint, adapter } = await connect(profile, device);
    try {
      const binding = await adapter.bind(required('workdir'), required('shell'));
      const id = randomUUID();
      save(sessionPath(id), { id, deviceId: device.nodeId, workDir: binding.workDir, shell: binding.shell });
      print({ session: id, ...binding });
    } finally { adapter.close(); await endpoint.close(); }
    return;
  }
  if (command === 'serve') {
    const id = required('session');
    const config = read(sessionPath(id));
    const device = devices.get(config.deviceId);
    if (!device || config.id !== id) throw new Error('INVALID_SESSION');
    const unlock = lock(id);
    let endpoint, adapter, store;
    try {
      ({ endpoint, adapter } = await connect(profile, device));
      const binding = await adapter.bind(config.workDir, config.shell);
      if (binding.workDir !== config.workDir || binding.shell !== config.shell) throw new Error('BINDING_CHANGED');
      store = new TaskStore(join(home, 'tasks.sqlite'));
      const service = new TaskService(adapter, store, binding, id);
      process.stderr.write(`LingXi target ${device.name} (${device.nodeId}), ${binding.workDir}\n`);
      const stop = () => { service.close(); process.stdin.destroy(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      await serveStdio(service);
    } finally { adapter?.close(); await endpoint?.close(); store?.close(); unlock(); }
    return;
  }
  throw new Error('Usage: init | pair --name NAME --ticket-file FILE | devices [--probe true] | select --device ID --workdir PATH --shell PATH | serve --session ID | tasks | config --session ID; all accept --home PATH');
}

main().catch(error => { process.stderr.write(`lingxi-mcp: ${error.message}\n`); process.exitCode = 1; });

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
import { runManual, shell } from './manual.mjs';
import { createInterface } from 'node:readline/promises';
import { launchStrictAi } from './strict-ai.mjs';

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

const activeBindingPath = join(home, 'active-ai-binding.json');

function saveActiveBinding(config) {
  save(activeBindingPath, {
    session: config.id,
    deviceId: config.deviceId,
    workDir: config.workDir,
    shell: config.shell,
    createdAt: new Date().toISOString(),
  });
}

function activeBinding() {
  let active;
  try { active = read(activeBindingPath); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('NO_ACTIVE_AI_BINDING: run control.sh ai and select a device first');
    throw error;
  }
  if (!active || typeof active.session !== 'string') throw new Error('INVALID_ACTIVE_AI_BINDING');
  const config = read(sessionPath(active.session));
  if (config.id !== active.session || config.deviceId !== active.deviceId || config.workDir !== active.workDir || config.shell !== active.shell) {
    throw new Error('ACTIVE_AI_BINDING_CHANGED: run control.sh ai again');
  }
  return active;
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
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write('lingxi-mcp (Node.js 24+)\nCommands: shell [--session ID], ai, codex, claude, exec --session ID --command TEXT, list --session ID [--path DIR], upload/download --session ID --local FILE --path REMOTE [--overwrite true], init, pair --name NAME --ticket-file FILE, devices [--probe true], select --device ID [--workdir PATH] [--shell PATH], serve --session ID, tasks [--session ID], config --session ID\nAll commands accept --home PATH. See REMOTE_TASKS.md for setup and limits.\n');
    return;
  }
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
      let status = 'not-probed'; let error; let defaults;
      if (options.probe === 'true') {
        try {
          const { endpoint, adapter } = await connect(profile, device);
          try {
            const probe = await adapter.request({ action: 'probe', requestId: randomUUID() });
            if (probe.status !== 'SUCCESS') throw new Error(probe.error ?? probe.status);
            defaults = probe.defaults;
            status = 'online';
          } finally { adapter.close(); await endpoint.close(); }
        } catch (e) { status = 'unavailable'; error = e.message; }
      }
      result.push({ deviceId: device.nodeId, name: device.name, status, error, defaults });
    }
    print(result); return;
  }
  if (command === 'select') {
    const device = devices.get(required('device'));
    if (!device) throw new Error('DEVICE_NOT_PAIRED');
    const { endpoint, adapter } = await connect(profile, device);
    try {
      const defaults = options.workdir && options.shell ? undefined :
        (await adapter.request({ action: 'probe', requestId: randomUUID() })).defaults;
      const workdir = options.workdir || defaults?.workDir;
      const program = options.shell || defaults?.shell;
      if (!workdir || !program) throw new Error('请升级被控制端，或通过 --workdir 和 --shell 指定路径');
      const binding = await adapter.bind(workdir, program);
      const id = randomUUID();
      save(sessionPath(id), { id, deviceId: device.nodeId, workDir: binding.workDir, shell: binding.shell });
      print({ session: id, ...binding });
    } finally { adapter.close(); await endpoint.close(); }
    return;
  }
  if (command === 'shell' && !options.session) {
    if (!devices.count()) throw new Error('NO_DEVICES: run setup or pair first');
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const list = devices.list();
      list.forEach((d, i) => process.stdout.write(`${i + 1}. ${d.name} (${d.nodeId})\n`));
      const device = list[Number(await reader.question('选择设备编号: ')) - 1];
      if (!device) throw new Error('INVALID_DEVICE_SELECTION');
      const { endpoint, adapter } = await connect(profile, device);
      try {
        const { defaults } = await adapter.request({ action: 'probe', requestId: randomUUID() });
        const workdir = (await reader.question(`被控制端工作目录 [${defaults?.workDir ?? '请输入绝对路径'}]: `)).trim() || defaults?.workDir;
        if (defaults?.shells?.length) process.stdout.write(`可用 Shell：${defaults.shells.join('、')}\n`);
        const program = (await reader.question(`被控制端 Shell [${defaults?.shell ?? '请输入绝对路径'}]: `)).trim() || defaults?.shell;
        if (!workdir || !program) throw new Error('请指定被控制端工作目录和 Shell');
        const binding = await adapter.bind(workdir, program);
        const id = randomUUID();
        save(sessionPath(id), { id, deviceId: device.nodeId, workDir: binding.workDir, shell: binding.shell });
        options.session = id;
      } finally { adapter.close(); await endpoint.close(); }
    } finally { reader.close(); }
  }
  if (command === 'ai') {
    if (!devices.count()) throw new Error('NO_DEVICES: run setup or pair first');
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const list = devices.list();
      process.stdout.write('选择要让 AI 操作的设备：\n');
      list.forEach((d, i) => process.stdout.write(`${i + 1}. ${d.name}（身份 ${d.nodeId.slice(0, 12)}）\n`));
      const device = list[Number(await reader.question('设备编号: ')) - 1];
      if (!device) throw new Error('INVALID_DEVICE_SELECTION');
      const { endpoint, adapter } = await connect(profile, device);
      let binding;
      try {
        const probe = await adapter.request({ action: 'probe', requestId: randomUUID() });
        if (probe.status !== 'SUCCESS') throw new Error(probe.error ?? probe.status);
        const defaults = probe.defaults;
        const workdir = (await reader.question(`被控制端工作目录 [${defaults?.workDir ?? '请输入绝对路径'}]: `)).trim() || defaults?.workDir;
        if (defaults?.shells?.length) process.stdout.write(`可用 Shell：${defaults.shells.join('、')}\n`);
        const program = (await reader.question(`被控制端 Shell [${defaults?.shell ?? '请输入绝对路径'}]: `)).trim() || defaults?.shell;
        if (!workdir || !program) throw new Error('请指定被控制端工作目录和 Shell');
        binding = await adapter.bind(workdir, program);
      } finally { adapter.close(); await endpoint.close(); }
      const id = randomUUID();
      const config = { id, deviceId: device.nodeId, workDir: binding.workDir, shell: binding.shell };
      save(sessionPath(id), config);
      saveActiveBinding(config);
      let setupResult = {};
      try { setupResult = read(join(home, 'setup-result.json')); } catch {}
      save(join(home, 'setup-result.json'), {
        ...setupResult, status: 'configured', session: id, deviceId: device.nodeId,
        activeBinding: { session: id, deviceId: device.nodeId, workDir: binding.workDir, shell: binding.shell }, transport: 'ready',
      });
      process.stdout.write(`AI 已固定到“${device.name}”的 ${binding.workDir}。请运行 control.sh codex 或 control.sh claude 启动严格远端 AI。\n`);
    } finally { reader.close(); }
    return;
  }
  if (command === 'codex' || command === 'claude') {
    const binding = activeBinding();
    await launchStrictAi({ kind: command, home, session: binding.session, cli: fileURLToPath(import.meta.url) });
    return;
  }
  if (['serve', 'shell', 'exec', 'list', 'upload', 'download'].includes(command)) {
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
      if (command === 'shell') { await shell(service); return; }
      if (command !== 'serve') { const result = await runManual(service, command, options); print(result); return; }
      const stop = () => { service.close(); process.stdin.destroy(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      await serveStdio(service);
    } finally { adapter?.close(); await endpoint?.close(); store?.close(); unlock(); }
    return;
  }
  throw new Error('Usage: init | pair --name NAME --ticket-file FILE | devices [--probe true] | select --device ID [--workdir PATH] [--shell PATH] | shell | ai | codex | claude | serve --session ID | tasks | config --session ID; all accept --home PATH');
}

main().catch(error => { process.stderr.write(`lingxi-mcp: ${error.message}\n`); process.exitCode = 1; });

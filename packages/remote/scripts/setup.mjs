import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, copyFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: options } = parseArgs({ options: Object.fromEntries([
  'role', 'agent', 'home', 'ticket-file', 'name', 'workdir', 'shell', 'ai', 'loopback', 'receive-root', 'codex', 'claude',
].map(key => [key, { type: 'string' }])) });
const home = resolve(options.home ?? join(homedir(), '.lingxi-mcp'));
const cli = join(root, 'packages/lingxi-mcp/cli.mjs');
const agent = resolve(options.agent ?? join(root, 'bin', process.platform === 'win32' ? 'lingxi1949.exe' : 'lingxi1949'));
const reader = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (key, prompt, fallback) => {
  if (options[key] !== undefined) return options[key];
  if (!process.stdin.isTTY) { if (fallback !== undefined) return fallback; throw new Error(`Missing --${key} for non-interactive setup`); }
  const value = (await reader.question(`${prompt}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  if (!value && fallback === undefined) throw new Error(`${key} cannot be empty`);
  return value || fallback;
};
const run = (file, args, extra = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 120000, ...extra });
const invoke = (...args) => JSON.parse(run(process.execPath, [cli, ...args, '--home', home, ...(options.loopback === 'true' ? ['--loopback', 'true'] : [])]));
const backup = path => { if (existsSync(path)) copyFileSync(path, `${path}.lingxi-${Date.now()}.bak`); };
const save = (name, value) => writeFileSync(join(home, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

async function startAgent() {
  if (!existsSync(agent)) throw new Error(`Agent not found: ${agent}. Use the complete platform bundle, or --agent PATH.`);
  if (options['receive-root']) run(agent, ['config', 'set-receive-root', resolve(options['receive-root'])]);
  const status = run(agent, ['status']);
  if (/\(running\)/.test(status)) { console.log('复用正在运行的 Agent；身份不变。'); return; }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = openSync(join(home, 'agent.log'), 'a', 0o600);
  const child = spawn(agent, ['run', ...(options.loopback === 'true' ? ['--loopback'] : [])], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  const launched = new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
  closeSync(log);
  await launched;
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Agent exited ${child.exitCode}; inspect ${join(home, 'agent.log')}`);
    const state = run(agent, ['status']);
    if (/\(running\)/.test(state) && /code\s+endpoint/.test(state)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Agent startup timed out; inspect ${join(home, 'agent.log')}`);
}

async function configureAI(kind, session, serverName) {
  const packages = { codex: '@openai/codex@0.166.0', claude: '@anthropic-ai/claude-code@2.1.316' };
  let executable = options[kind] ?? kind;
  let prefixArgs = [];
  try { run(executable, ['--version']); } catch {
    const prefix = join(home, 'ai-tools');
    let npm = process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    if (!existsSync(npm) && process.platform !== 'win32') {
      for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        const candidate = join(dir, 'npm');
        if (existsSync(candidate)) { npm = realpathSync(candidate); break; }
      }
    }
    if (!existsSync(npm)) throw new Error(`Cannot install ${kind}: npm unavailable. Rerun setup.sh/setup.ps1 or supply --${kind} PATH.`);
    run(process.execPath, [npm, 'install', '--prefix', prefix, '--no-audit', '--no-fund', packages[kind]], { timeout: 600000, stdio: 'inherit' });
    executable = process.execPath;
    prefixArgs = [join(prefix, 'node_modules', ...(kind === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js']))];
  }
  const args = [cli, 'serve', '--home', home, '--session', session, ...(options.loopback === 'true' ? ['--loopback', 'true'] : [])];
  if (kind === 'codex') {
    backup(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'));
    run(executable, [...prefixArgs, 'mcp', 'add', serverName, '--', process.execPath, ...args]);
  } else {
    backup(join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json'));
    // A stable per-session name avoids touching unrelated server definitions.
    let exists = false;
    try { run(executable, [...prefixArgs, 'mcp', 'get', serverName]); exists = true; } catch {}
    if (!exists) run(executable, [...prefixArgs, 'mcp', 'add-json', '--scope', 'user', serverName, JSON.stringify({ type: 'stdio', command: process.execPath, args })]);
  }
  return { executable, args: prefixArgs, serverName, login: 'manual' };
}

try {
  const role = await ask('role', '设备角色 controller（主控）/target（被控）');
  if (!['controller', 'target'].includes(role)) throw new Error('role must be controller or target');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  backup(join(home, 'setup-result.json'));
  save('setup-result.json', { status: 'in-progress', role });
  console.log('1/4 检查并启动 Agent');
  await startAgent();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (role === 'target') {
    save('setup-result.json', { status: 'ready', role });
    console.log(run(agent, ['status']));
    console.log('被控端已就绪。把上面的连接码复制到主控端；关闭此脚本后 Agent 继续运行。');
  } else {
    console.log('2/4 初始化控制端并配对（保留已有身份）');
    if (!existsSync(join(home, 'profile.json'))) invoke('init');
    const ticket = options['ticket-file'] ? readFileSync(options['ticket-file'], 'utf8').trim() : await ask('ticket', '粘贴被控端连接码');
    const ticketPath = join(home, 'setup.ticket');
    writeFileSync(ticketPath, ticket + '\n', { mode: 0o600 });
    const paired = invoke('pair', '--ticket-file', ticketPath, '--name', await ask('name', '设备名称', '工作设备'));
    const probe = invoke('devices', '--probe', 'true').find(d => d.deviceId === paired.deviceId);
    if (probe?.status !== 'online') throw new Error(`Device unavailable: ${probe?.error ?? 'unknown'}`);
    console.log('3/4 验证远程目录与 Shell');
    const workdir = await ask('workdir', '远程工作目录（绝对路径）');
    const shell = await ask('shell', '远程 Shell 绝对路径（Windows 如 C:\\Windows\\System32\\cmd.exe）');
    const selected = invoke('select', '--device', paired.deviceId, '--workdir', workdir, '--shell', shell);
    const config = invoke('config', '--session', selected.session);
    save('mcp-config.json', config);
    console.log('4/4 配置 AI CLI 接入');
    const ai = await ask('ai', '配置 codex / claude / both / none（仅手动控制）', 'both');
    if (!['codex','claude','both','none'].includes(ai)) throw new Error('INVALID_AI_CHOICE');
    const tools = {};
    for (const kind of ai === 'both' ? ['codex','claude'] : ai === 'none' ? [] : [ai]) {
      tools[kind] = await configureAI(kind, selected.session, `lingxi-${selected.session.slice(0, 8)}`);
    }
    save('setup-result.json', { status: 'configured', session: selected.session, deviceId: paired.deviceId, tools, transport: 'ready', accountLogin: ai === 'none' ? 'not-requested' : 'manual' });
    console.log(`设备连接与工具配置已完成。手动入口：\n${JSON.stringify([process.execPath, cli, 'shell', '--home', home, '--session', selected.session])}`);
    if (ai !== 'none') console.log('模型账号登录仍需你在相应 CLI 中完成；本脚本未验证模型调用。AI 工具启动信息保存在 setup-result.json。');
  }
} catch (error) {
  if (existsSync(home)) save('setup-result.json', { status: 'incomplete', error: error.message });
  console.error(`配置未完成：${error.message}`);
  process.exitCode = 1;
} finally { reader.close(); }

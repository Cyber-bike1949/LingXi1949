import { _electron as electron } from 'playwright';
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const { values: args } = parseArgs({ options: Object.fromEntries(['obsidian','agent','plugin','output'].map(k => [k,{type:'string'}])) });
const output = resolve(args.output ?? 'test-results/obsidian');
await mkdir(output, { recursive: true });
const cases = ['插件加载','打开本地终端','界面输入命令与输出','连接远程设备','断开后重连'].map(name => ({ name, status: 'not-run' }));
const report = { platform: process.platform, arch: process.arch, node: process.version, startedAt: new Date().toISOString(), cases };
let application, page, agent;
let current = 0;
const logs = [];
const record = async (index, fn) => {
  current = index;
  const start = Date.now();
  await fn();
  cases[index].status = 'passed'; cases[index].durationMs = Date.now() - start;
  await page.screenshot({ path: join(output, `${index + 1}-passed.png`) });
};

try {
  if (!args.obsidian || !args.agent) throw new Error('Required: --obsidian ABSOLUTE_EXECUTABLE --agent ABSOLUTE_EXECUTABLE; run in a desktop session (Linux may use Xvfb).');
  const fixture = await mkdtemp(join(tmpdir(), 'lingxi-obsidian-ui-'));
  report.fixture = fixture;
  const vault = join(fixture, 'vault'); const config = join(fixture, 'config');
  const userData = join(config, 'obsidian'); const agentConfig = join(fixture, 'agent-config'); const runtime = join(fixture, 'runtime');
  const work = join(fixture, 'remote-work');
  for (const dir of [vault, userData, agentConfig, runtime, work]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const plugin = resolve(args.plugin ?? 'plugin-package');
  const manifest = JSON.parse(await readFile(join(plugin, 'manifest.json'), 'utf8'));
  report.pluginVersion = manifest.version;
  const pluginDir = join(vault, '.obsidian', 'plugins', manifest.id);
  await cp(plugin, pluginDir, { recursive: true, dereference: true });
  await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify([manifest.id]));
  await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ safeMode: false }));
  await writeFile(join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify(['command-palette']));
  await writeFile(join(pluginDir, 'data.json'), JSON.stringify({ lastSeenChangelogVersion: manifest.version, offlineMode: true,
    platformShells: { linux: 'bash', windows: 'cmd', darwin: 'zsh' }, preferredRenderer: 'dom' }));
  await writeFile(join(userData, 'obsidian.json'), JSON.stringify({ vaults: { '1234567890abcdef': { path: vault, ts: Date.now(), open: true } }, updateDisabled: true }));
  const agentEnv = { ...process.env, XDG_CONFIG_HOME: agentConfig, XDG_RUNTIME_DIR: runtime, APPDATA: agentConfig, LOCALAPPDATA: agentConfig };
  execFileSync(resolve(args.agent), ['config','set-receive-root',work], { env: agentEnv });
  execFileSync(resolve(args.agent), ['config','set-shell',process.platform === 'win32' ? process.env.ComSpec : '/bin/bash'], { env: agentEnv });
  agent = spawn(resolve(args.agent), ['run','--loopback'], { env: agentEnv, stdio: ['ignore','pipe','pipe'] });
  agent.stderr.on('data', b => logs.push(`agent: ${b}`));
  const ticket = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('Test Agent did not print a ticket')), 30000);
    const lines = createInterface({ input: agent.stdout });
    lines.on('line', line => { if (line.trim().startsWith('endpoint')) { clearTimeout(timer); res(line.trim()); } });
    agent.once('error', error => { clearTimeout(timer); rej(error); });
    agent.once('exit', code => { clearTimeout(timer); rej(new Error(`Test Agent exited ${code}`)); });
  });
  application = await electron.launch({ executablePath: resolve(args.obsidian),
    args: [`--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config }, timeout: 60000 });
  application.on('window', p => p.on('console', message => logs.push(`console: ${message.text()}`)));
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => logs.push(`pageerror: ${error.message}`));
  const home = async () => {
    const name = await page.evaluate(id => window.app.commands.commands[`${id}:open-terminal`].name, manifest.id);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
    await page.locator('.prompt-input').fill(name);
    await page.locator('.suggestion-item').first().click();
    await page.locator('.termesh-device-card.is-local').waitFor({ state: 'visible' });
  };
  const command = async marker => {
    const input = page.locator('.xterm-helper-textarea:visible').last();
    await input.focus();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press('Enter');
    // Read the real renderer buffer; commands are sent only through keyboard events.
    await page.waitForFunction(({id,marker}) => {
      const terminals = window.app.plugins.plugins[id].getTerminalService().getAllTerminals();
      return terminals.some(instance => {
        const buffer = instance.getXterm().buffer.active;
        for (let i = 0; i < buffer.length; i++) if (buffer.getLine(i)?.translateToString(true).trim() === marker) return true;
        return false;
      });
    }, { id: manifest.id, marker }, { timeout: 30000 });
  };
  await record(0, async () => {
    await page.waitForFunction(id => !!window.app?.plugins?.plugins?.[id], manifest.id);
    report.obsidianVersion = await application.evaluate(({ app }) => app.getVersion());
    await home();
  });
  await record(1, async () => {
    await page.locator('.termesh-device-card.is-local').click();
    await page.locator('.xterm-helper-textarea:visible').last().waitFor();
  });
  await record(2, async () => { await command(`LINGXI_LOCAL_${randomBytes(6).toString('hex')}`); });
  await record(3, async () => {
    await home();
    await page.locator('.termesh-device-card.is-add').click();
    await page.locator('.termesh-add-device-modal input').fill('UI test target');
    await page.locator('.termesh-add-device-modal textarea').fill(ticket);
    await page.locator('.termesh-add-device-modal .mod-cta').click();
    await page.locator('.termesh-device-card.is-remote').click();
    await command(`LINGXI_REMOTE_${randomBytes(6).toString('hex')}`);
  });
  await record(4, async () => {
    await home();
    await page.locator('.termesh-device-card.is-remote.status-connected .termesh-device-more').click();
    // The disconnect action is the first menu item when connected.
    await page.locator('.menu .menu-item').first().click();
    await page.locator('.termesh-device-card.is-remote:not(.status-connected)').waitFor();
    await page.locator('.termesh-device-card.is-remote').click();
    await command(`LINGXI_RECONNECTED_${randomBytes(6).toString('hex')}`);
  });
} catch (error) {
  cases[current].status = 'failed'; cases[current].error = error.stack ?? String(error);
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(error => logs.push(`close: ${error.message}`));
  if (agent && agent.exitCode === null) {
    const exited = once(agent, 'exit'); agent.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(() => { agent.kill('SIGKILL'); resolve(); }, 3000))]);
  }
  report.finishedAt = new Date().toISOString();
  report.passed = cases.every(c => c.status === 'passed');
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(output, 'runtime.log'), logs.join('\n'));
  console.log(JSON.stringify(report, null, 2));
}

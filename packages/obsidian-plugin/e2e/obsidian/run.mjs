import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, cp, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createServer } from 'node:net';

const { values: args } = parseArgs({ options: Object.fromEntries(['obsidian','agent','plugin','output'].map(k => [k,{type:'string'}])) });
const output = resolve(args.output ?? 'test-results/obsidian');
await mkdir(output, { recursive: true });
const cases = ['插件加载','打开本地终端','界面输入命令与输出','添加并连接远程设备','断开后重连','研发任务进度与测试报告'].map(name => ({ name, status: 'not-run' }));
const report = { platform: process.platform, arch: process.arch, node: process.version, startedAt: new Date().toISOString(), cases }; report.host = { cpuModel: cpus()[0]?.model, logicalCpuCount: cpus().length, totalMemoryBytes: totalmem() };
let application, page, agent, obsidianProcess;
let current = 0;
const logs = [];
const record = async (index, fn) => {
  current = index;
  const start = Date.now();
  try {
    await fn();
    cases[index].status = 'passed'; cases[index].durationMs = Date.now() - start;
    await page.screenshot({ path: join(output, `${index + 1}-passed.png`) });
  } catch (error) {
    cases[index].status = 'failed'; cases[index].durationMs = Date.now() - start;
    cases[index].error = error.stack ?? String(error);
    logs.push(`${cases[index].name} failed: ${cases[index].error}`);
    logs.push(`${cases[index].name} page: ${await page.locator('body').innerText().catch(() => '<unavailable>')}`);
    await page.screenshot({ path: join(output, `${index + 1}-failed.png`) }).catch(() => {});
  }
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
  const nativeRuntime = process.platform === 'win32'
    ? ['iroh-win32-x64-msvc', 'iroh.win32-x64-msvc.node']
    : ['iroh-linux-x64-gnu', 'iroh.linux-x64-gnu.node'];
  const runtimeDir = join(pluginDir, 'native', 'iroh');
  await mkdir(runtimeDir, { recursive: true });
  await cp(
    join(pluginDir, 'node_modules', '@number0', nativeRuntime[0], nativeRuntime[1]),
    join(runtimeDir, `iroh-runtime-${manifest.version}.node`),
  );
  await writeFile(join(runtimeDir, 'version.json'), JSON.stringify({ version: manifest.version }));
  await writeFile(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify([manifest.id]));
  await writeFile(join(vault, '.obsidian', 'app.json'), JSON.stringify({ safeMode: false }));
  await writeFile(join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify(['command-palette']));
  await writeFile(join(pluginDir, 'data.json'), JSON.stringify({ lastSeenChangelogVersion: manifest.version, serverConnection: { offlineMode: true },
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
  const iroh = createRequire(join(plugin, 'package.json'))('@number0/iroh');
  const nodeId = iroh.EndpointTicket.fromString(ticket).endpointAddr().id().toString();
  const pluginSettings = JSON.parse(await readFile(join(pluginDir, 'data.json'), 'utf8'));
  pluginSettings.pairedDevices = [{ name: 'UI test target', ticket, nodeId, lastConnectedAt: null, lastKnownOnline: false }];
  await writeFile(join(pluginDir, 'data.json'), JSON.stringify(pluginSettings));
  const portServer = createServer();
  await new Promise((res, rej) => portServer.listen(0, '127.0.0.1', res).once('error', rej));
  const debugPort = portServer.address().port;
  await new Promise((res, rej) => portServer.close(error => error ? rej(error) : res()));
  obsidianProcess = spawn(resolve(args.obsidian), [
    `--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu',
  ], { env: { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config }, stdio: ['ignore', 'pipe', 'pipe'] });
  obsidianProcess.stdout.on('data', b => logs.push(`obsidian: ${b}`));
  obsidianProcess.stderr.on('data', b => logs.push(`obsidian: ${b}`));
  const endpoint = `http://127.0.0.1:${debugPort}`;
  const deadline = Date.now() + 90000;
  let browser;
  while (!browser && Date.now() < deadline) {
    if (obsidianProcess.exitCode !== null) throw new Error(`Obsidian exited ${obsidianProcess.exitCode}: ${logs.join('\n')}`);
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    } catch { await new Promise(res => setTimeout(res, 500)); }
  }
  if (!browser) throw new Error(`Obsidian DevTools endpoint did not start: ${logs.join('\n')}`);
  const context = browser.contexts()[0];
  page = context.pages()[0];
  if (!page) throw new Error('Obsidian opened without a renderer page');
  application = { close: async () => browser.close() };
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => logs.push(`pageerror: ${error.message}`));
  const startupState = await Promise.race([
    page.waitForFunction(id => !!window.app?.plugins?.plugins?.[id], manifest.id, { timeout: 30000 }).then(() => 'plugin-loaded'),
    page.getByText(/Do you trust the author of this vault|信任这个仓库的作者/i).waitFor({ state: 'visible', timeout: 30000 }).then(() => 'vault-trust'),
  ]);
  if (startupState === 'vault-trust') {
    const trustPrompt = page.getByText(/Do you trust the author of this vault|信任这个仓库的作者/i).last();
    const trustButton = page.getByText(/Trust author and enable plugins|信任仓库作者并启用插件/i).last();
    await trustButton.waitFor({ state: 'visible' });
    await trustButton.click();
    await trustPrompt.waitFor({ state: 'hidden', timeout: 10000 });
    logs.push('accepted the first-run vault trust prompt');
  }
  const home = async () => {
    const commandId = `${manifest.id}:open-terminal`;
    const name = await (await page.waitForFunction(id => window.app?.commands?.commands?.[id]?.name, commandId)).jsonValue();
    const launchers = page.getByText(name, { exact: true });
    let launched = false;
    for (let index = 0; index < await launchers.count(); index += 1) {
      const launcher = launchers.nth(index);
      if (await launcher.isVisible().catch(() => false)) {
        await launcher.click();
        launched = true;
        break;
      }
    }
    if (!launched) {
      await page.evaluate(id => window.app.commands.executeCommandById(id), commandId);
    }
    await page.locator('.termesh-device-card.is-local').waitFor({ state: 'visible' });
  };
  const command = async (marker, shellCommand = `echo ${marker}`) => {
    const input = page.locator('.xterm-helper-textarea:visible').last();
    await input.focus();
    await page.keyboard.type(shellCommand);
    await page.keyboard.press('Enter');
    // Read the real renderer buffer; commands are sent only through keyboard events.
    await page.waitForFunction(async ({id,marker}) => {
      const service = await window.app.plugins.plugins[id].getTerminalService();
      const terminals = service.getAllTerminals();
      return terminals.some(instance => {
        const buffer = instance.getXterm().buffer.active;
        for (let i = 0; i < buffer.length; i++) if (buffer.getLine(i)?.translateToString(true).trim() === marker) return true;
        return false;
      });
    }, { id: manifest.id, marker }, { timeout: 30000 });
  };
  await record(0, async () => {
    await page.waitForFunction(id => !!window.app?.plugins?.plugins?.[id], manifest.id);
    report.electronVersion = await page.evaluate(() => process.versions.electron).catch(() => 'unknown');
    const runtimePath = await page.evaluate(id => {
      const plugin = window.app.plugins.plugins[id];
      const directory = plugin.getPluginDir();
      const runtime = `${directory}/native/iroh/iroh-runtime-${plugin.manifest.version}.node`;
      return {
        directory,
        manifestDirectory: plugin.manifest.dir,
        runtime,
        exists: require('node:fs').existsSync(runtime),
      };
    }, manifest.id);
    report.electronPluginRuntime = runtimePath;
    await home();
  });
  await record(1, async () => {
    const settings = page.locator('.mod-settings:visible');
    if (await settings.isVisible()) {
      await settings.locator('.modal-close-button').click();
      await settings.waitFor({ state: 'hidden' });
    }
    await page.locator('.termesh-device-card.is-local').click();
    await page.locator('.xterm-helper-textarea:visible').last().waitFor();
  });
  await record(2, async () => { await command(`LINGXI_LOCAL_${randomBytes(6).toString('hex')}`); });
  await record(3, async () => {
    await home();
    await page.bringToFront();
    const addDeviceCard = page.locator('.termesh-device-card.is-add');
    await addDeviceCard.click();
    const pairingView = page.locator('.termesh-add-device-view');
    await pairingView.waitFor({ state: 'visible' });
    await pairingView.locator('input').fill('UI test target');
    await pairingView.locator('textarea').fill(ticket);
    await pairingView.getByRole('button', { name: /添加设备|Add device/i }).click();
    await page.locator('.termesh-device-card.is-remote').waitFor({ state: 'visible' });
    await page.locator('.termesh-device-card.is-remote').click();
    await command(`LINGXI_REMOTE_${randomBytes(6).toString('hex')}`);
  });
  await record(4, async () => {
    await home();
    const remoteCard = page.locator('.termesh-device-card.is-remote').first();
    await remoteCard.click();
    await page.locator('.termesh-device-card.is-remote.status-connected').waitFor({ state: 'visible' });
    await page.locator('.termesh-device-card.is-remote.status-connected .termesh-device-more').click();
    // The disconnect action is the first menu item when connected.
    await page.locator('.menu .menu-item').first().click();
    await page.locator('.termesh-device-card.is-remote:not(.status-connected)').waitFor();
    await page.locator('.termesh-device-card.is-remote').click();
    await command(`LINGXI_RECONNECTED_${randomBytes(6).toString('hex')}`);
  });
  await record(5, async () => {
    const snapshot = {
      schemaVersion: 1,
      source: 'lingxi-orchestrator',
      repository: 'example/web-app',
      updatedAt: new Date().toISOString(),
      tasks: [{
        id: 'RND-UI-001',
        title: '任务列表支持状态筛选',
        state: 'CI_VERIFYING',
        branch: 'feat/ai-RND-UI-001',
        updatedAt: new Date().toISOString(),
        currentNode: 'e2e',
        nodes: [
          { kind: 'develop', state: 'SUCCEEDED', data: { deliverySha: 'a'.repeat(40) } },
          { kind: 'test', state: 'SUCCEEDED', data: { passed: true } },
          { kind: 'ci', state: 'SUCCEEDED', data: { passed: true } },
          { kind: 'e2e', state: 'RUNNING', data: {} },
        ],
        workflows: [
          { name: 'Web Demo CI', status: 'completed', conclusion: 'success', url: 'https://github.com/example/web-app/actions/runs/1' },
        ],
        artifacts: [{ kind: 'test-report', sha: 'b'.repeat(64) }],
        testReport: { url: 'https://github.com/example/web-app/blob/main/TEST-HANDOFF.md', results: '用例 8 项，通过 8 项，失败 0 项。' },
        events: Array.from({ length: 2000 }, (_, index) => ({
          id: 'UI-EVENT-' + index,
          type: index === 1999 ? 'NODE_FAILED' : 'TRACE',
          createdAt: new Date(1700000000000 + index * 1000).toISOString(),
          data: { reason: index === 1999 ? 'UI_DIAGNOSTIC_MARKER' : 'TRACE_MARKER_' + index },
        })),
        eventCount: 2000,
        eventsTruncated: false,
      }],
    };
    const fixturePath = join(work, 'orchestrator-status', 'tasks.json');
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, JSON.stringify(snapshot));
    await home();
    await page.bringToFront();
    await page.locator('.termesh-home-actions button').filter({ hasText: '研发任务' }).click();
    const tasksView = page.locator('.termesh-remote-tasks-view');
    await tasksView.waitFor({ state: 'visible' });
    await tasksView.locator('input[type="text"]').fill(fixturePath);
    await tasksView.getByRole('button', { name: '刷新任务' }).click();
    const task = tasksView.locator('details').filter({ hasText: /^RND-UI-001/ });
    await task.waitFor();
    await task.locator(':scope > summary').click();
    await task.getByText('端到端测试：执行中').waitFor();
    await task.getByText('用例 8 项，通过 8 项，失败 0 项。').waitFor();
    await task.getByText('打开交接报告').waitFor();
    await task.getByText('Web Demo CI · success').waitFor();
    const history = task.locator('.termesh-task-events');
    const themeResults = {};
    for (const theme of ['theme-dark', 'theme-light']) {
      await page.evaluate(value => {
        document.body.classList.remove('theme-dark', 'theme-light');
        document.body.classList.add(value);
      }, theme);
      const colors = await tasksView.evaluate(el => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, color: style.color, width: el.getBoundingClientRect().width, scrollWidth: el.scrollWidth };
      });
      if (!colors.color || colors.width <= 0) throw new Error('Task view is not visible in ' + theme);
      themeResults[theme] = colors;
      await page.screenshot({ path: join(output, theme + '.png') });
    }
    await page.evaluate(() => document.body.classList.remove('theme-dark', 'theme-light'));
    await page.setViewportSize({ width: 720, height: 900 });
    const narrow = await tasksView.evaluate(el => ({ width: el.getBoundingClientRect().width, scrollWidth: el.scrollWidth }));
    if (narrow.scrollWidth > narrow.width + 2) throw new Error('Task view overflows at narrow width: ' + JSON.stringify(narrow));
    report.themeCoverage = themeResults;
    report.narrowLayout = narrow;
    await history.getByRole('button', { name: /加载更多/ }).click();
    if (await history.locator('.termesh-task-event').count() !== 100) throw new Error('Event pagination lost rows');
    await history.getByLabel('事件类别').selectOption('error');
    if (await history.locator('.termesh-task-event').count() !== 1) throw new Error('Error filter mixed unrelated events');
    await history.locator('.termesh-task-event summary').click();
    await history.getByText('事件 ID：UI-EVENT-1999', { exact: true }).waitFor();
    await history.getByLabel('事件类别').selectOption('all');
    await history.getByLabel('搜索事件').fill('TRACE_MARKER_1042');
    if (await history.locator('.termesh-task-event').count() !== 1) throw new Error('Search did not isolate requested event');
    await history.getByLabel('搜索事件').fill('NO_MATCH_MARKER');
    await history.getByText('没有符合筛选条件的事件。').waitFor();
    await history.getByLabel('搜索事件').fill('');
    report.taskEventCoverage = ['pagination', 'error-filter', 'event-id', 'search', 'empty-results'];
    const secondTask = structuredClone(snapshot.tasks[0]);
    secondTask.id = 'RND-UI-002';
    secondTask.title = '持续 TRACE 写入期间的切换目标';
    secondTask.events = [];
    secondTask.eventCount = 0;
    secondTask.eventsTruncated = false;
    snapshot.tasks.push(secondTask);
    await writeFile(fixturePath, JSON.stringify(snapshot));
    await tasksView.getByRole('button', { name: '刷新任务' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.termesh-remote-tasks-view details')].some(el => el.textContent.includes('RND-UI-002')));
    const otherTask = tasksView.locator('details').filter({ hasText: /^RND-UI-002/ });

    // Fixed before the run: simulate 100 TRACE/s for 10 seconds. During writes,
    // refresh and exercise scrolling, filtering, searching, details and task switching.
    const criteria = { durationMs: 10000, eventsPerSecond: 100, minimumRatePerSecond: 80, p95InteractionMsMax: 500, maxRunnerRssGrowthBytes: 128 * 1024 * 1024, maxRendererHeapGrowthBytes: 64 * 1024 * 1024, maxRunnerCpuPercent: 100 };
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const rendererHeapBefore = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const interactionSamples = [];
    const measureInteraction = async (name, fn) => {
      const startedAt = Date.now();
      await fn();
      interactionSamples.push({ name, durationMs: Date.now() - startedAt });
    };
    const setTaskOpen = async (locator, open) => {
      if (await locator.evaluate(el => el.open) !== open) await locator.locator(':scope > summary').click();
    };
    let generatedEvents = 0;
    let writerError;
    let pendingWrite = Promise.resolve();
    const startedAt = Date.now();
    const writer = setInterval(() => {
      pendingWrite = pendingWrite.then(async () => {
        const base = generatedEvents;
        const batch = Array.from({ length: 10 }, (_, index) => ({
          id: 'LOAD-' + (base + index), type: 'TRACE', createdAt: new Date().toISOString(),
          data: { reason: 'TRACE_LOAD_' + (base + index) },
        }));
        snapshot.tasks[0].events.push(...batch);
        snapshot.tasks[0].eventCount = snapshot.tasks[0].events.length;
        generatedEvents += batch.length;
        const temporaryPath = fixturePath + '.stress';
        await writeFile(temporaryPath, JSON.stringify(snapshot));
        await rename(temporaryPath, fixturePath);
      }).catch(error => { writerError = error; clearInterval(writer); });
    }, 100);
    try {
      for (let cycle = 0; cycle < 10; cycle += 1) {
        await page.waitForTimeout(1000);
        await pendingWrite;
        if (writerError) throw writerError;
        const expectedCount = snapshot.tasks[0].eventCount;
        await measureInteraction('refresh', async () => {
          await tasksView.getByRole('button', { name: '刷新任务' }).click();
          await page.waitForFunction(count => [...document.querySelectorAll('.termesh-task-events h4')].some(el => Number(el.textContent.match(/共 (\d+) 条/)?.[1] ?? 0) >= count), expectedCount);
        });
        await setTaskOpen(task, true);
        await measureInteraction('scroll', () => history.evaluate(el => el.scrollIntoView({ block: 'end' })));
        await measureInteraction('filter', async () => {
          await history.getByLabel('事件类别').selectOption('error');
          if (await history.locator('.termesh-task-event').count() !== 1) throw new Error('TRACE stress error filter lost its failure event');
          await history.getByLabel('事件类别').selectOption('all');
        });
        const heading = await history.locator('h4').innerText();
        const loadedCount = Number(heading.match(/共 (\d+) 条/)?.[1]);
        const marker = 'TRACE_LOAD_' + (loadedCount - 2001);
        await measureInteraction('search', async () => {
          await history.getByLabel('搜索事件').fill(marker);
          if (await history.locator('.termesh-task-event').count() !== 1) throw new Error('TRACE stress search did not isolate the latest written event');
          await history.getByLabel('搜索事件').fill('');
        });
        await measureInteraction('event-details', async () => {
          const summary = history.locator('.termesh-task-event').first().locator('summary');
          await summary.click();
          await summary.click();
        });
        await measureInteraction('task-switch', async () => {
          await setTaskOpen(task, false);
          await setTaskOpen(otherTask, true);
          await setTaskOpen(otherTask, false);
          await setTaskOpen(task, true);
        });
      }
    } finally {
      clearInterval(writer);
      await pendingWrite;
    }
    const durationMs = Date.now() - startedAt;
    const sortedInteractions = interactionSamples.map(sample => sample.durationMs).sort((a, b) => a - b);
    const p95InteractionMs = sortedInteractions[Math.ceil(sortedInteractions.length * 0.95) - 1] ?? null;
    const rendererHeapAfter = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const rendererHeapGrowthBytes = rendererHeapBefore === null || rendererHeapAfter === null ? null : rendererHeapAfter - rendererHeapBefore;
    const runnerCpuUsageMicros = process.cpuUsage(cpuBefore);
    const runnerCpuPercent = (runnerCpuUsageMicros.user + runnerCpuUsageMicros.system) / (durationMs * 1000) * 100;
    const rssGrowthBytes = process.memoryUsage().rss - rssBefore;
    report.traceStress = {
      initialEvents: 2000, generatedEvents, durationMs, generationRatePerSecond: generatedEvents * 1000 / durationMs,
      refreshCount: 10, interactionSamples, p95InteractionMs, runnerRssGrowthBytes: rssGrowthBytes,
      runnerCpuUsageMicros, runnerCpuPercent,
      rendererHeapGrowthBytes, criteria,
    };
    if (generatedEvents < criteria.minimumRatePerSecond * durationMs / 1000) throw new Error('TRACE generator fell below the fixed minimum event rate');
    if (p95InteractionMs > criteria.p95InteractionMsMax) throw new Error('TRACE interaction p95 exceeded the fixed response limit');
    if (runnerCpuPercent > criteria.maxRunnerCpuPercent) throw new Error('TRACE test runner CPU use exceeded the fixed single-core limit');
    if (rssGrowthBytes > criteria.maxRunnerRssGrowthBytes) throw new Error('TRACE test runner RSS growth exceeded the fixed resource limit');
    if (rendererHeapGrowthBytes !== null && rendererHeapGrowthBytes > criteria.maxRendererHeapGrowthBytes) throw new Error('TRACE renderer heap growth exceeded the fixed resource limit');
    // Keep the rendered snapshot visible while ensuring screenshots contain no absolute paths.
    await tasksView.locator('input[type="text"]').fill('');
    await tasksView.locator('input[type="text"]').blur();
    await tasksView.locator('input[type="text"]').evaluate(input => input.setAttribute('placeholder', ''));
    await page.evaluate(() => {
      for (const leaf of window.app.workspace.getLeavesOfType('terminal-view')) leaf.detach();
    });
    await tasksView.waitFor({ state: 'visible' });
  });
} catch (error) {
  cases[current].status = 'failed'; cases[current].error = error.stack ?? String(error);
  if (page) logs.push(`page text: ${await page.locator('body').innerText().catch(() => '<unavailable>')}`);
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(error => logs.push(`close: ${error.message}`));
  if (obsidianProcess && obsidianProcess.exitCode === null) {
    obsidianProcess.kill('SIGTERM');
    await Promise.race([once(obsidianProcess, 'exit'), new Promise(resolve => setTimeout(() => { obsidianProcess.kill('SIGKILL'); resolve(); }, 3000))]);
  }
  if (agent && agent.exitCode === null) {
    const exited = once(agent, 'exit'); agent.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(() => { agent.kill('SIGKILL'); resolve(); }, 3000))]);
  }
  report.finishedAt = new Date().toISOString();
  report.passed = cases.every(c => c.status === 'passed');
  if (!report.passed) process.exitCode = 1;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(output, 'runtime.log'), logs.join('\n'));
  console.log(JSON.stringify(report, null, 2));
}

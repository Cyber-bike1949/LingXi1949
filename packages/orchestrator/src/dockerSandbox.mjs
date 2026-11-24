import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentConfigArgs, runAgent } from './agent.mjs';
import { runProcess } from './process.mjs';

export function validateDockerSandbox(config, platform = process.platform) {
  if (config?.enabled !== true) return;
  if (platform !== 'linux') throw new Error('DOCKER_SANDBOX_REQUIRES_LINUX');
  if (config.provider !== 'docker' || config.trustedProject !== true) throw new Error('DOCKER_SANDBOX_REQUIRES_TRUSTED_PROJECT');
  if (!/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[0-9a-f]{64}$/.test(config.image ?? '')) throw new Error('DOCKER_SANDBOX_REQUIRES_PINNED_IMAGE');
  for (const key of ['dockerExecutable', 'authFile']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error('DOCKER_SANDBOX_PATH_REQUIRED: ' + key);
  }
}

function mount(source, target, readOnly = false) {
  if (source.includes(',')) throw new Error('DOCKER_SANDBOX_MOUNT_PATH_INVALID');
  return ['--mount', 'type=bind,src=' + source + ',dst=' + target + (readOnly ? ',readonly' : '')];
}

export async function checkRootlessDocker(config) {
  const response = await runProcess(config.dockerExecutable, ['info', '--format', '{{json .SecurityOptions}}']);
  if (response.exitCode !== 0) throw new Error('DOCKER_SANDBOX_ENGINE_UNAVAILABLE');
  const security = JSON.parse(response.stdout);
  if (!Array.isArray(security) || !security.some(option => option === 'name=rootless')) throw new Error('DOCKER_SANDBOX_ENGINE_NOT_ROOTLESS');
}

export async function runDockerAgent({ config, agent, args, prompt, remote, stateRoot, taskId, role, onSession }) {
  validateDockerSandbox(config);
  if (!agent.mcp || agent.target !== 'local') throw new Error('DOCKER_SANDBOX_REQUIRES_LOCAL_LINGXI_MCP');
  await checkRootlessDocker(config);
  const id = createHash('sha256').update(taskId).update('\0').update(role).digest('hex');
  const state = join(stateRoot, 'docker-sessions', id);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  await (await open(join(state, 'auth.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)).close();
  const name = 'lingxi-task-' + randomUUID();
  const stage = await mkdtemp(join(tmpdir(), 'lingxi-docker-'));
  let bridge;
  try {
    const settings = dirname(remote.lingxiCli);
    const { startAiBridge } = await import(pathToFileURL(join(settings, 'ai-bridge.mjs')).href);
    const proxy = join(stage, 'proxy.mjs');
    await copyFile(join(settings, 'mcp-socket-proxy.mjs'), proxy);
    const socketDir = join(stage, 'bridge');
    const homeIndex = agent.mcp.serverArgs.indexOf('--home');
    bridge = await startAiBridge({
      socketPath: join(socketDir, 'mcp.sock'), node: process.execPath, cli: remote.lingxiCli,
      home: homeIndex < 0 ? join(homedir(), '.lingxi-mcp') : agent.mcp.serverArgs[homeIndex + 1],
      session: remote.session,
    });
    const mcp = { ...agent.mcp, command: '/usr/local/bin/node', serverArgs: ['/lingxi/proxy.mjs', '--socket', '/bridge/mcp.sock'] };
    const containerArgs = [...args];
    const promptIndex = containerArgs.lastIndexOf('-');
    containerArgs.splice(promptIndex < 0 ? containerArgs.length : promptIndex, 0,
      '--skip-git-repo-check', '-c', 'features.code_mode_host=true');
    return await runAgent({
      executable: config.dockerExecutable,
      args: [
        'run', '--rm', '--name', name, '--interactive', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp', '--workdir', '/tmp',
        '--env', 'HOME=/state', '--env', 'CODEX_HOME=/state',
        ...mount(state, '/state'), ...mount(config.authFile, '/state/auth.json', true),
        ...mount(proxy, '/lingxi/proxy.mjs', true), ...mount(socketDir, '/bridge', true),
        config.image, '/usr/local/bin/codex', ...agentConfigArgs({ args: containerArgs, mcp }),
      ],
      prompt,
      onSession,
    });
  } finally {
    try {
      await runProcess(config.dockerExecutable, ['rm', '-f', name]);
    } finally {
      try { if (bridge) await bridge.close(); }
      finally { await rm(stage, { recursive: true, force: true }); }
    }
  }
}

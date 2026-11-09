import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startAiBridge } from './ai-bridge.mjs';

const exists = async path => access(path, constants.F_OK).then(() => true, () => false);
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code ?? 'unknown'}`)));
});

function executable(name) {
  const result = spawnSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function copyIfPresent(source, destination) {
  if (await exists(source)) { await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(source, destination); }
}

export async function launchStrictAi({ kind, home, session, cli }) {
  if (process.platform !== 'linux') throw new Error('STRICT_AI_RUNTIME_UNAVAILABLE: strict AI currently requires Linux bubblewrap');
  const bwrap = executable('bwrap');
  if (!bwrap) throw new Error('STRICT_AI_RUNTIME_UNAVAILABLE: install bubblewrap before starting strict AI');
  const tool = executable(kind);
  if (!tool) throw new Error(`AI_CLI_NOT_FOUND: ${kind}`);

  const stage = await mkdtemp(join(tmpdir(), 'lingxi-strict-ai-'));
  const app = join(stage, 'app');
  const sandboxHome = join(stage, 'home', 'lingxi');
  const bridgeDirectory = join(stage, 'bridge');
  const socketPath = join(bridgeDirectory, 'mcp.sock');
  try {
    await mkdir(app, { recursive: true, mode: 0o700 });
    await mkdir(sandboxHome, { recursive: true, mode: 0o700 });
    await mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
    await copyFile(process.execPath, join(app, 'node'));
    await copyFile(fileURLToPath(new URL('./mcp-socket-proxy.mjs', import.meta.url)), join(app, 'mcp-socket-proxy.mjs'));
    await copyFile(tool, join(app, kind));

    // Preserve only the provider login material needed by the selected CLI.
    // Pairing data remains outside the sandbox in `home`.
    if (kind === 'codex') {
      await copyIfPresent(join(homedir(), '.codex', 'auth.json'), join(sandboxHome, '.codex', 'auth.json'));
      await mkdir(join(sandboxHome, '.codex'), { recursive: true, mode: 0o700 });
      await writeFile(join(sandboxHome, '.codex', 'config.toml'), `[mcp_servers.lingxi]\ncommand = \"/app/node\"\nargs = [\"/app/mcp-socket-proxy.mjs\", \"--socket\", \"/bridge/mcp.sock\"]\n`, { mode: 0o600 });
    } else {
      await copyIfPresent(join(homedir(), '.claude.json'), join(sandboxHome, '.claude.json'));
    }
    const bridge = await startAiBridge({ socketPath, node: process.execPath, cli, home, session });
    const base = [
      '--die-with-parent', '--new-session', '--unshare-user', '--uid', '0', '--gid', '0',
      // Network sharing is the Bubblewrap default. Do not pass --share-net:
      // Ubuntu's 0.9 implementation only documents it as an override after
      // --unshare-net/--unshare-all. Cgroup isolation is not required for the
      // filesystem boundary and is unavailable on some user-namespace setups.
      '--unshare-pid', '--unshare-ipc', '--unshare-uts',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/workspace',
      '--ro-bind', app, '/app', '--bind', join(stage, 'home'), '/home', '--ro-bind', bridgeDirectory, '/bridge',
      '--setenv', 'HOME', '/home/lingxi', '--setenv', 'PATH', '/usr/bin:/bin', '--chdir', '/workspace',
    ];
    try {
      if (kind === 'claude') await run(bwrap, [...base, '--', '/app/claude', 'mcp', 'add', '--transport', 'stdio', 'lingxi', '--', '/app/node', '/app/mcp-socket-proxy.mjs', '--socket', '/bridge/mcp.sock']);
      await run(bwrap, [...base, '--', `/app/${kind}`]);
    } finally { await bridge.close(); }
  } finally { await rm(stage, { recursive: true, force: true }); }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const windows = process.platform === 'win32';

test('standalone npm install loads the native runtime without a pnpm store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-runtime-'));
  try {
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
    for (const [path, entry] of Object.entries(lock.packages)) {
      assert.ok(!path.includes('.pnpm') && !entry.link, `Non-portable lock entry: ${path}`);
    }
    for (const name of ['package.json', 'package-lock.json']) await copyFile(name, join(root, name));
    await exec(windows ? process.env.ComSpec : 'npm', windows ? ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund'] : ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, timeout: 180000 });
    await exec(process.execPath, ['--input-type=module', '-e', "import * as iroh from '@number0/iroh'; if (!iroh.SecretKey.generate().toBytes().length) process.exit(1)"], { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('manual launcher finds bundled Node and passes paths with spaces from any directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingxi control '));
  try {
    const name = windows ? 'control.cmd' : 'control.sh';
    const launcher = join(root, name);
    await copyFile(resolve(name), launcher);
    const cli = join(root, 'packages/lingxi-mcp');
    await mkdir(cli, { recursive: true });
    await writeFile(join(cli, 'cli.mjs'), 'console.log(JSON.stringify({args:process.argv.slice(2),node:process.execPath,cwd:process.cwd()}));');
    const run = (args) => exec(windows ? process.env.ComSpec : 'bash', windows ? ['/d', '/s', '/c', `""${launcher}" ${args.map(arg => `"${arg}"`).join(' ')}"`] : [launcher, ...args], { cwd: tmpdir(), timeout: 10000, windowsVerbatimArguments: windows });
    const fallback = JSON.parse((await run(['--home', 'profile with spaces'])).stdout);
    assert.deepEqual(fallback.args, ['shell', '--home', 'profile with spaces']);
    const runtime = join(root, '.runtime', windows ? 'node-v24.22.1-win-x64' : 'node-v24.22.1-linux-x64/bin');
    await mkdir(runtime, { recursive: true });
    const node = join(runtime, windows ? 'node.exe' : 'node');
    await copyFile(process.execPath, node);
    const bundled = JSON.parse((await run(['--home', 'profile with spaces'])).stdout);
    assert.deepEqual(bundled.args, fallback.args);
    assert.equal(bundled.node.toLowerCase(), node.toLowerCase());
    assert.equal(bundled.cwd, fallback.cwd);
    const ai = JSON.parse((await run(['ai', '--kind', 'codex'])).stdout);
    assert.deepEqual(ai.args, ['ai', '--kind', 'codex']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

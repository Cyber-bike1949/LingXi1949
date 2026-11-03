import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const windows = process.platform === 'win32';
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
const installer = resolve(`scripts/install-remote.${windows ? 'ps1' : 'sh'}`);

test('bootstrap verifies downloads, reuses installs, preserves config and fails safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingxi-bootstrap-'));
  try {
    const fixture = join(root, 'fixture'); const pack = join(root, 'pack'); const bin = join(root, 'mock-bin');
    for (const dir of [fixture, bin, join(pack, 'scripts'), join(pack, 'bin')]) await mkdir(dir, { recursive: true });
    await writeFile(join(pack, 'scripts/setup.mjs'), '');
    await writeFile(join(pack, 'bin', windows ? 'lingxi1949.exe' : 'lingxi1949'), 'fixture');
    await writeFile(join(pack, 'scripts/setup.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$TEST_OUTPUT"\n');
    await writeFile(join(pack, 'scripts/setup.ps1'), 'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$SetupArgs)\n$SetupArgs | Set-Content $env:TEST_OUTPUT\n');
    const asset = `lingxi-remote-${version}-${process.platform}-x64.tar.gz`;
    await exec(windows ? 'tar.exe' : 'tar', ['-czf', join(fixture, asset), '-C', pack, '.']);
    const checksum = createHash('sha256').update(await readFile(join(fixture, asset))).digest('hex');
    const checksumPath = join(fixture, `${asset}.sha256`);
    await writeFile(checksumPath, `${checksum}  ${asset}\n`);
    await writeFile(join(bin, 'curl'), `#!/usr/bin/env bash
set -eu
while [[ $# -gt 0 ]]; do
  case "$1" in
    https://*) url="$1" ;;
    -o) shift; output="$1" ;;
  esac
  shift
done
cp "$TEST_FIXTURE/\${url##*/}" "$output"
`, { mode: 0o755 });
    const harness = join(root, 'harness.ps1');
    await writeFile(harness, `$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  Copy-Item (Join-Path $env:TEST_FIXTURE ($Uri.Split('/')[-1])) $OutFile
}
& $env:TEST_INSTALLER --role target --name 'test device'
`);
    const base = join(root, 'install with spaces');
    const output = join(root, 'args');
    const env = { ...process.env, LINGXI_REMOTE_HOME: base, LINGXI_REMOTE_VERSION: version, TEST_FIXTURE: fixture, TEST_OUTPUT: output, TEST_INSTALLER: installer, PATH: `${bin}${delimiter}${process.env.PATH}` };
    const run = (overrides = {}) => exec(windows ? 'powershell.exe' : 'bash', windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness] : [installer, '--role', 'target', '--name', 'test device'], { env: { ...env, ...overrides }, timeout: 30000 });
    await run({ LINGXI_REMOTE_VERSION: '' });
    assert.match(await readFile(output, 'utf8'), /--role\r?\ntarget\r?\n--name\r?\ntest device/);
    const preserved = join(base, version, 'user-config'); await writeFile(preserved, 'preserved');
    await rm(join(fixture, asset));
    await run();
    assert.equal(await readFile(preserved, 'utf8'), 'preserved');
    await assert.rejects(run({ LINGXI_REMOTE_HOME: join(root, 'no-release') }), /Download failed|下载失败/);
    await exec(windows ? 'tar.exe' : 'tar', ['-czf', join(fixture, asset), '-C', pack, '.']);
    await writeFile(checksumPath, `${'0'.repeat(64)}  ${asset}\n`);
    const badBase = join(root, 'bad-checksum');
    await assert.rejects(run({ LINGXI_REMOTE_HOME: badBase }));
    await assert.rejects(access(join(badBase, version)));
    await assert.rejects(access(join(badBase, `${version}.lock`)));
    const unmanaged = join(root, 'unmanaged'); await mkdir(join(unmanaged, version), { recursive: true });
    await assert.rejects(run({ LINGXI_REMOTE_HOME: unmanaged }), /not managed|已存在/);
    await assert.rejects(run({ LINGXI_REMOTE_VERSION: '../escape' }), /Invalid LINGXI_REMOTE_VERSION/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, readlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const installer = resolve('scripts/install.sh');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lingxi-installer-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'tools');
  const assets = join(root, 'assets');
  const prefix = join(root, 'install with spaces');
  mkdirSync(bin); mkdirSync(assets);
  const executable = '#!/bin/sh\nprintf "fake agent %s\\n" "$*"\n';
  writeFileSync(join(assets, 'lingxi1949-linux-x64'), executable);
  writeFileSync(join(assets, 'lingxi1949-linux-x64.sha256'), `${createHash('sha256').update(executable).digest('hex')}  lingxi1949-linux-x64\n`);
  writeFileSync(join(bin, 'curl'), '#!/bin/bash\nset -eu\nwhile (($#)); do case "$1" in https://*) url="$1"; shift;; -o) out="$2"; shift 2;; *) shift;; esac; done\ncp "$FIXTURE_ASSETS/${url##*/}" "$out"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo "${FIXTURE_ARCH:-x86_64}";; esac\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ASSETS: assets };
  const run = (...args) => spawnSync('bash', [installer, '--prefix', prefix, ...args], { env, encoding: 'utf8' });
  return { root, bin, assets, prefix, env, run };
}
const linux = process.platform === 'linux';
test('Linux installer rejects invalid role and unsupported architecture before writing installation', { skip: !linux }, t => {
  const f = fixture(t);
  assert.notEqual(f.run('--role', 'invalid').status, 0);
  f.env.FIXTURE_ARCH = 'aarch64';
  assert.match(f.run('--role', 'c').stderr, /only Linux x64/);
  assert.ok(!readdirSync(f.root).includes('install with spaces'));
});
test('C install and reinstall preserve configuration and launch correctly with spaces', { skip: !linux }, t => {
  const f = fixture(t);
  mkdirSync(f.prefix);
  writeFileSync(join(f.prefix, 'identity-sentinel'), 'keep identity');
  for (let n = 0; n < 2; n++) {
    const result = f.run('--role', 'c');
    assert.equal(result.status, 0, result.stderr);
    const agent = spawnSync(join(f.prefix, 'bin/lingxi1949'), ['--version'], { encoding: 'utf8' });
    assert.equal(agent.status, 0, agent.stderr);
    assert.match(agent.stdout, /fake agent --version/);
  }
  assert.equal(readFileSync(join(f.prefix, 'identity-sentinel'), 'utf8'), 'keep identity');
  assert.equal(readdirSync(join(f.prefix, 'bundles')).length, 2);
});
test('checksum failure keeps previous active install and cleans staging', { skip: !linux }, t => {
  const f = fixture(t);
  assert.equal(f.run('--role', 'c').status, 0);
  const active = readlinkSync(join(f.prefix, 'current'));
  writeFileSync(join(f.assets, 'lingxi1949-linux-x64.sha256'), `${'0'.repeat(64)}  asset\n`);
  const result = f.run('--role', 'c');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(readlinkSync(join(f.prefix, 'current')), active);
  assert.equal(readdirSync(join(f.prefix, 'bundles')).length, 1);
  assert.ok(!readdirSync(f.prefix).includes('.install-lock'));
});
test('installer refuses an unmanaged launcher and symlinked storage', { skip: !linux }, t => {
  const f = fixture(t);
  mkdirSync(join(f.prefix, 'bin'), { recursive: true });
  writeFileSync(join(f.prefix, 'bin/lingxi1949'), 'do not overwrite');
  assert.match(f.run('--role', 'c').stderr, /unmanaged launcher/);
  assert.equal(readFileSync(join(f.prefix, 'bin/lingxi1949'), 'utf8'), 'do not overwrite');
  rmSync(join(f.prefix, 'bundles'), { recursive: true });
  symlinkSync(f.assets, join(f.prefix, 'bundles'));
  assert.match(f.run('--role', 'c').stderr, /must not be symlinks/);
  const result = spawnSync('bash', [installer, '--role', 'c', '--prefix', '/'], { env: f.env, encoding: 'utf8' });
  assert.match(result.stderr, /dedicated absolute directory/);
});
test('B rejects old Node before installing anything', { skip: !linux }, t => {
  const f = fixture(t);
  writeFileSync(join(f.bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(f.bin, 'npm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  assert.match(f.run('--role', 'b').stderr, /requires Node.js 24/);
  assert.ok(!readdirSync(f.root).includes('install with spaces'));
});
test('concurrent installer lock is respected', { skip: !linux }, t => {
  const f = fixture(t);
  mkdirSync(join(f.prefix, '.install-lock'), { recursive: true });
  assert.match(f.run('--role', 'c').stderr, /another installer is running/);
  assert.equal(readdirSync(join(f.prefix, 'bundles')).length, 0);
});

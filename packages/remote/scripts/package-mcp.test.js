import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('standalone MCP archive starts without repository source files', () => {
  execFileSync(process.execPath, ['scripts/package-mcp.mjs']);
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const dir = mkdtempSync(join(tmpdir(), 'lingxi-mcp-package-test-'));
  try {
    execFileSync('tar', ['-xzf', resolve(`release-assets/lingxi-mcp-${version}.tar.gz`), '-C', dir]);
    // Reuse the exact installed native runtime instead of downloading it again.
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const cli = join(dir, 'packages/lingxi-mcp/cli.mjs');
    const home = join(dir, 'test-profile');
    const initialized = JSON.parse(execFileSync(process.execPath, [cli, 'init', '--home', home], { encoding: 'utf8' }));
    assert.equal(initialized.initialized, true);
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, [cli, 'devices', '--home', home], { encoding: 'utf8' })), []);
    assert.equal(JSON.parse(readFileSync(join(home, 'profile.json'), 'utf8')).seed.length, 32);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityCommand, worktreeCommand } from '../src/pipeline.mjs';

test('quotes task paths and produces fail-fast commands', () => {
  assert.match(worktreeCommand({ baseSha: 'abc', branch: 'feat/ai-1', worktree: '/tmp/my worktree' }), /git worktree add/);
  assert.doesNotMatch(worktreeCommand({ baseSha: 'abc', worktree: '/tmp/test worktree' }), /switch -c/);
  assert.match(qualityCommand({ worktree: '/tmp/my worktree', commands: ['pnpm test', 'pnpm build'] }), /pnpm test && pnpm build/);
});

test('creates Windows worktrees and quality runners through encoded PowerShell', () => {
  const command = worktreeCommand({ baseSha: 'a'.repeat(40), branch: 'feat/demo', worktree: 'D:\\work trees\\demo', repositoryRoot: 'D:\\repos\\demo', shellKind: 'cmd' });
  assert.match(command, /^powershell\.exe .* -EncodedCommand /);
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
  assert.match(script, /fetch origin/);
  assert.match(script, /cat-file -e 'a{40}\^\{commit\}'/);
  assert.match(script, /git -c http\.version=HTTP\/1\.1 -c http\.proxy= -C/);
  assert.match(script, /git -c http\.version=HTTP\/1\.1 -c http\.proxy= -C 'D:\\repos\\demo' fetch origin/);
  assert.match(script, /D:\\work trees\\demo/);
  assert.match(script, /switch -c 'feat\/demo'/);

  const quality = qualityCommand({ worktree: 'D:\\work trees\\demo', commands: ['npm test', 'npm run build'], shellKind: 'cmd' });
  const qualityScript = Buffer.from(quality.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(qualityScript, /Set-Location -LiteralPath 'D:\\work trees\\demo'/);
  assert.match(qualityScript, /cmd\.exe \/D \/S \/C/);
  const commandData = qualityScript.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.deepEqual(JSON.parse(Buffer.from(commandData, 'base64').toString('utf8')), ['npm test', 'npm run build']);
});

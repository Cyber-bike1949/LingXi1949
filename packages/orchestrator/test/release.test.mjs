import test from 'node:test';
import assert from 'node:assert/strict';
import { formalTagCommand, validFormalTag } from '../src/release.mjs';

test('only accepts stable, unit-specific formal release tags', () => {
  assert.equal(validFormalTag('obsidian-plugin', '5.1.0'), true);
  assert.equal(validFormalTag('obsidian-plugin', '5.1.0-rc.1'), false);
  assert.equal(validFormalTag('remote', 'remote-5.1.0'), true);
  assert.equal(validFormalTag('remote', '5.1.0'), false);
});

test('creates a guarded remote tag command bound to the verified SHA', () => {
  const command = formalTagCommand({ worktree: '/worktrees/RND-1', sha: 'a'.repeat(40), tag: '5.1.0' });
  assert.match(command, /TAG_ALREADY_EXISTS/);
  assert.match(command, /rev-parse HEAD/);
  assert.match(command, /push origin 'refs\/tags\/5.1.0'/);
});

test('creates a Windows PowerShell release command with the delivery SHA guard', () => {
  const command = formalTagCommand({ worktree: 'D:\\work trees\\task', sha: 'b'.repeat(40), tag: 'remote-1.2.3', shellKind: 'cmd' });
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /DELIVERY_SHA_MISMATCH/);
  assert.match(script, /git -c http\.version=HTTP\/1\.1 -c http\.proxy= -C 'D:\\work trees\\task' push origin 'refs\/tags\/remote-1\.2\.3'/);
});

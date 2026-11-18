import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerification, verificationCommand } from '../src/git.mjs';

test('requires a full SHA and a clean worktree', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(parseVerification(`HEAD:${sha}\n`, sha), { sha, clean: true, dirty: [] });
  assert.equal(parseVerification(`HEAD:${sha}\nDIRTY: M index.js\n`, sha).clean, false);
  assert.throws(() => parseVerification('short\n'), /INVALID_GIT_SHA/);
  assert.throws(() => parseVerification(`HEAD:${sha}\n`, 'not-a-sha'), /INVALID_REMOTE_GIT_SHA/);
  assert.throws(() => parseVerification(`HEAD:${sha}\n`, 'b'.repeat(40)), /GIT_BRANCH_NOT_PUSHED/);
});

test('checks only the detached Windows worktree; authenticated controller code checks the remote ref', () => {
  const command = verificationCommand('D:\\work\\task', 'feat/ai-1', 'cmd');
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /rev-parse HEAD/);
  assert.match(script, /status --porcelain/);
  assert.doesNotMatch(script, /ls-remote/);
});

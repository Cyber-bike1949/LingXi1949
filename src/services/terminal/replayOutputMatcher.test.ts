import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReplayOutput, outputAfterShellEcho } from './replayOutputMatcher.ts';

test('normalizes terminal output for fuzzy replay matching', () => {
  const output = '\u001b[32mOPENAI\u001b[0m\r\n  Codex\tReady';
  assert.equal(normalizeReplayOutput(output).includes(normalizeReplayOutput('OpenAI Codex')), true);
});

test('does not match unrelated terminal output', () => {
  assert.equal(normalizeReplayOutput('command completed').includes(normalizeReplayOutput('permission prompt')), false);
});

test('excludes the echoed shell command from replay output', () => {
  const output = '\u001b[32mexample@host\u001b[0m$ codex\r\nloading\r\nAsk Codex to do anything';
  const afterEcho = outputAfterShellEcho(output, 'codex');
  assert.equal(normalizeReplayOutput(afterEcho).includes(normalizeReplayOutput('codex')), true);
  assert.equal(normalizeReplayOutput(outputAfterShellEcho('\u001b[32mexample@host\u001b[0m$ codex\r\nloading', 'codex')).includes(normalizeReplayOutput('codex')), false);
});

test('waits for a shell echo before exposing output', () => {
  assert.equal(outputAfterShellEcho('Codex startup banner', 'codex'), '');
});
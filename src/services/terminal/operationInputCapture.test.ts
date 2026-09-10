import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterTerminalControlSequences,
  startsInteractiveCli,
  type ControlSequenceFilterState,
} from './operationInputCapture.ts';

test('filters terminal replies without mixing them into submitted text', () => {
  const state: ControlSequenceFilterState = { pending: '' };
  const result = filterTerminalControlSequences(
    '\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b[?1;2c/permissions\r',
    state,
  );
  assert.equal(result.text, '/permissions\r');
  assert.equal(result.removedControlSequence, true);
  assert.equal(state.pending, '');
});

test('buffers a split control reply across xterm data chunks', () => {
  const state: ControlSequenceFilterState = { pending: '' };
  assert.equal(filterTerminalControlSequences('\x1b]10;rgb:ffff/', state).text, '');
  assert.equal(filterTerminalControlSequences('ffff/ffff\x07/permissions\r', state).text, '/permissions\r');
});

test('recognizes supported AI TUI launch commands', () => {
  assert.equal(startsInteractiveCli('codex'), true);
  assert.equal(startsInteractiveCli('sudo /usr/local/bin/codex --resume'), true);
  assert.equal(startsInteractiveCli('env DEBUG=1 opencode .'), true);
  assert.equal(startsInteractiveCli('echo codex'), false);
});

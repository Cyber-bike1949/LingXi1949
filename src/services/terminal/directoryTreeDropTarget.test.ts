import * as assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDirectoryTreeDropTarget } from './directoryTreeDropTarget.ts';

test('uses a directory row as the drop destination', () => {
  assert.equal(
    resolveDirectoryTreeDropTarget('/workspace', '/workspace/notes', true),
    '/workspace/notes',
  );
});

test('uses the containing directory when dropping onto a file row', () => {
  assert.equal(
    resolveDirectoryTreeDropTarget('/workspace/notes', '/workspace/notes/example.md', false),
    '/workspace/notes',
  );
});

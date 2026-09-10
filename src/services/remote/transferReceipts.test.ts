import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedTransferPaths } from './transferReceipts.ts';

const entries = [{ index: 0, relativePath: 'a.md', size: 1 }, { index: 1, relativePath: 'b.md', size: 1 }];

test('partial failure keeps confirmed files and rejects mismatched receipts', () => {
  assert.deepEqual(confirmedTransferPaths({ success: false, code: 'WRITE_FAILED', message: '', files: [
    { fileIndex: 0, relativePath: 'a.md', status: 'success' },
    { fileIndex: 1, relativePath: 'b.md', status: 'failed' },
    { fileIndex: 2, relativePath: '../unexpected', status: 'success' },
    { fileIndex: 1, relativePath: 'other.md', status: 'success' },
    { fileIndex: 0, relativePath: 'a.md', status: 'success' },
  ] }, entries), ['a.md']);
});

test('legacy failure confirms nothing and legacy success confirms the manifest', () => {
  assert.deepEqual(confirmedTransferPaths({ success: false, code: null, message: '' }, entries), []);
  assert.deepEqual(confirmedTransferPaths({ success: true, code: null, message: '' }, entries), ['a.md', 'b.md']);
});

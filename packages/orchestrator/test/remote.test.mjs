import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLingxiResult } from '../src/remote.mjs';

test('extracts the final formatted LingXi JSON result after progress output', () => {
  const output = 'progress\n' + JSON.stringify({ stdout: 'abc\n', exitCode: 0 }, null, 2) + '\n';
  assert.deepEqual(decodeLingxiResult(output), { stdout: 'abc\n', exitCode: 0 });
});

test('preserves command stdout emitted before the LingXi result envelope', () => {
  const output = 'HEAD:' + 'a'.repeat(40) + '\r\n' + JSON.stringify({ event: 'result', status: 'SUCCESS', exitCode: 0 });
  assert.equal(decodeLingxiResult(output).stdout, 'HEAD:' + 'a'.repeat(40));
});

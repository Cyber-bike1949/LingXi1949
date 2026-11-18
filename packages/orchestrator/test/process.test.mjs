import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/process.mjs';

test('captures a child process result', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.log("ok")']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok\n');
});

import * as assert from 'node:assert/strict';
import test from 'node:test';

import { decodeAiCliBindingOsc } from './aiCliBinding.ts';

test('decodes the remote AI binding marker and its end marker', () => {
  const binding = { session: 'session-1', deviceId: 'device_12345678', workDir: '/workspace/demo' };
  const encoded = Buffer.from(JSON.stringify(binding)).toString('base64url');

  assert.deepEqual(decodeAiCliBindingOsc(`LingXi1949;ai-binding;${encoded}`), binding);
  assert.equal(decodeAiCliBindingOsc('LingXi1949;ai-binding-end'), null);
  assert.equal(decodeAiCliBindingOsc('unrelated;osc'), undefined);
});

test('rejects malformed and unsafe AI binding markers', () => {
  assert.equal(decodeAiCliBindingOsc('LingXi1949;ai-binding;%%%'), undefined);
  const invalid = Buffer.from(JSON.stringify({ session: 's', deviceId: 'device_12345678', workDir: '/tmp\nfile' })).toString('base64url');
  assert.equal(decodeAiCliBindingOsc(`LingXi1949;ai-binding;${invalid}`), undefined);
});

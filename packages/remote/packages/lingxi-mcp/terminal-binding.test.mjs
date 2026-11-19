import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { aiBindingEndSequence, aiBindingStartSequence, announceAiBinding, clearAiBinding } from './terminal-binding.mjs';

test('AI binding OSC markers carry the immutable session target and clear it afterward', () => {
  const binding = { session: 'session-1', deviceId: 'device-123', workDir: '/workspace/demo' };
  const start = aiBindingStartSequence(binding);
  const encoded = start.split(';').at(-1).slice(0, -1);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), binding);
  assert.equal(aiBindingEndSequence(), '\u001b]1949;LingXi1949;ai-binding-end\u0007');
});

test('AI binding markers are emitted only to an interactive terminal', () => {
  const stream = new PassThrough();
  assert.equal(announceAiBinding(stream, { session: 'session-1', deviceId: 'device-123', workDir: '/workspace/demo' }), false);
  clearAiBinding(stream);
  assert.equal(stream.read(), null);
});


test('AI binding sends the connection ticket without controller credentials', () => {
  const binding = { session: 'session-1', deviceId: 'device-123', workDir: '/workspace/demo', ticket: 'endpoint-example' };
  const start = aiBindingStartSequence({ ...binding, seed: [1, 2, 3], shell: '/bin/sh' });
  const encoded = start.split(';').at(-1).slice(0, -1);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), binding);
});

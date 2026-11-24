import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaFailure, quotaRetryAt } from '../src/quota.mjs';

test('recognizes explicit quota evidence and rejects unrelated errors', () => {
  assert.equal(quotaFailure({ exitCode: 0, stderr: 'usage limit reached' }), null);
  assert.equal(quotaFailure({ exitCode: 1, stderr: 'network timeout' }), null);
  assert.equal(quotaFailure({ exitCode: 1, stderr: 'authentication failed' }), null);
  assert.equal(quotaFailure({ exitCode: 1, stderr: 'usage_limit_reached; retry after 30 minutes' }).retryAfterMs, 1800000);
});

test('bounds quota wake time and respects a trusted reset timestamp', () => {
  const failure = { retryAfterMs: 90_000 };
  assert.equal(quotaRetryAt(failure, { now: 1000 }), new Date(91000).toISOString());
  assert.equal(quotaRetryAt({ retryAfterMs: 99_000_000 }, { now: 1000, maxWaitMs: 5000 }), new Date(6000).toISOString());
  assert.equal(quotaRetryAt({ resetAt: '2026-11-23T23:00:00.000Z' }, { now: Date.parse('2026-11-23T22:00:00Z') }), '2026-11-23T23:00:00.000Z');
});

test('uses documented default and bounded exponential backoff when no reset time is supplied', () => {
  const now = 1000;
  assert.equal(quotaRetryAt({}, { now }), new Date(now + 30 * 60_000).toISOString());
  assert.equal(quotaRetryAt({}, { now, attempt: 1 }), new Date(now + 60 * 60_000).toISOString());
  assert.equal(quotaRetryAt({}, { now, attempt: 5, maxWaitMs: 90 * 60_000 }), new Date(now + 90 * 60_000).toISOString());
});

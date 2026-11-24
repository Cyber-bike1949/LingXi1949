const quotaPatterns = [
  /usage[_ -]limit[_ -](?:reached|exceeded)/i,
  /quota[_ -](?:exceeded|exhausted)/i,
  /rate[_ -]limit[_ -](?:reached|exceeded)/i,
  /insufficient[_ -]credits/i,
  /you(?:'| a)?re out of (?:credits|quota)/i,
  /monthly (?:usage )?limit (?:reached|exceeded)/i
];

export function quotaFailure(result = {}) {
  if (result.exitCode === 0) return null;
  const evidence = [result.stderr, result.stdout].filter(Boolean).join('\n').slice(-12000);
  const match = quotaPatterns.find(pattern => pattern.test(evidence));
  if (!match) return null;
  const seconds = evidence.match(/retry (?:again )?after\s+(\d+)\s*(seconds?|minutes?|hours?)/i);
  const after = seconds ? Number(seconds[1]) * (/hour/i.test(seconds[2]) ? 3600_000 : /minute/i.test(seconds[2]) ? 60_000 : 1000) : null;
  const reset = evidence.match(/(?:reset|available) at\s+(20\d\d-\d\d-\d\dT[^\s"'<>]+)/i);
  const resetAt = reset && Number.isFinite(Date.parse(reset[1])) ? new Date(reset[1]).toISOString() : null;
  return { code: match.source, retryAfterMs: after, resetAt };
}

export function quotaRetryAt(failure, { now = Date.now(), defaultWaitMs = 30 * 60_000, baseDelayMs = defaultWaitMs, maxWaitMs = 2 * 60 * 60_000, attempt = 0 } = {}) {
  if (!failure) throw new Error('QUOTA_EVIDENCE_REQUIRED');
  const fallback = Math.min(maxWaitMs, baseDelayMs * (2 ** Math.min(8, Math.max(0, attempt))));
  const candidate = failure.resetAt ? Date.parse(failure.resetAt) - now : failure.retryAfterMs ?? fallback;
  const delay = Math.min(maxWaitMs, Math.max(1000, candidate));
  return new Date(now + delay).toISOString();
}

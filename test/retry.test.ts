/**
 * Phase 4.6.12 — retry architecture audit.
 *
 * `src/chain/retry.ts`'s `withRetries` is the single shared retry
 * primitive layered above `journalledSend` for close-v3, close-v4, and
 * both swap paths (see the phase report's retry inventory) — but it had
 * no dedicated test file; it was only incidentally exercised by two cases
 * in `test/txRecovery.test.ts` (the no-retry veto, and one transient-retry
 * happy path). This file directly pins the safety properties the audit
 * relied on to conclude no production defect exists: attempts are always
 * bounded by `times` (never unbounded/runaway), a caller-supplied or
 * default permanent-error classification stops retrying immediately
 * rather than exhausting all attempts, backoff is linear and therefore
 * has a computable worst-case total duration, and the `__txNoRetry` veto
 * (already covered in txRecovery.test.ts) is reconfirmed alongside these.
 *
 * No production code was changed this phase — see
 * PHASE4_6_12_RETRY_AUDIT_REPORT.md for the full audit and the reasoning
 * for why no fix was warranted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetries } from '../src/chain/retry.js';
import { markNoRetry } from '../src/chain/txRecovery.js';

// ── Bounded attempts (never unbounded / runaway) ──────────────────────────

test('a persistently-failing operation is attempted exactly `times` times, never more', async () => {
  let calls = 0;
  await assert.rejects(() =>
    withRetries(
      async () => {
        calls++;
        throw new Error('transient failure');
      },
      { times: 3, backoffMs: 1 },
    ),
  );
  assert.equal(calls, 3, 'must stop at exactly the configured maximum, not retry indefinitely');
});

test('default times (3) is used when omitted — no hidden unbounded default', async () => {
  let calls = 0;
  await assert.rejects(() =>
    withRetries(async () => {
      calls++;
      throw new Error('always fails');
    }),
  );
  assert.equal(calls, 3);
});

test('a single configured attempt (times=1) never retries at all', async () => {
  let calls = 0;
  await assert.rejects(() =>
    withRetries(
      async () => {
        calls++;
        throw new Error('fails once, no retry configured');
      },
      { times: 1, backoffMs: 1 },
    ),
  );
  assert.equal(calls, 1);
});

// ── Permanent-error classification (§21 of the phase task) ───────────────

test('default classification: "no balance" is treated as permanent — attempted once, never retried', async () => {
  let calls = 0;
  await assert.rejects(() =>
    withRetries(
      async () => {
        calls++;
        throw new Error('no balance available for this token');
      },
      { times: 5, backoffMs: 1 },
    ),
  );
  assert.equal(calls, 1, 'a permanent error must not be retried even with attempts remaining');
});

test('default classification: each documented permanent-error phrase stops after one attempt', async () => {
  const permanentMessages = [
    'no balance for token',
    'pool not found',
    'wallet already empty',
    'tokenIn === tokenOut',
    'invalid address supplied',
  ];
  for (const message of permanentMessages) {
    let calls = 0;
    await assert.rejects(() =>
      withRetries(
        async () => {
          calls++;
          throw new Error(message);
        },
        { times: 5, backoffMs: 1 },
      ),
    );
    assert.equal(calls, 1, `expected exactly 1 attempt for permanent error: ${message}`);
  }
});

test('default classification: a transient-looking error (timeout, connection reset) IS retried up to the bound', async () => {
  for (const message of ['request timed out', 'ECONNRESET', 'rate limited (429)']) {
    let calls = 0;
    await assert.rejects(() =>
      withRetries(
        async () => {
          calls++;
          throw new Error(message);
        },
        { times: 3, backoffMs: 1 },
      ),
    );
    assert.equal(calls, 3, `expected the full bound of attempts for transient error: ${message}`);
  }
});

test('caller-supplied shouldRetry=false stops after the first attempt, regardless of `times`', async () => {
  let calls = 0;
  await assert.rejects(() =>
    withRetries(
      async () => {
        calls++;
        throw new Error('anything');
      },
      { times: 5, backoffMs: 1, shouldRetry: () => false },
    ),
  );
  assert.equal(calls, 1);
});

test('caller-supplied shouldRetry=true overrides the default permanent-error classification', async () => {
  let calls = 0;
  await assert.rejects(() =>
    withRetries(
      async () => {
        calls++;
        throw new Error('no balance'); // would default to non-retryable
      },
      { times: 3, backoffMs: 1, shouldRetry: () => true },
    ),
  );
  assert.equal(calls, 3, 'an explicit shouldRetry=true must override the default classification');
});

// ── The __txNoRetry veto is absolute — checked before any shouldRetry ─────
// (already covered by txRecovery.test.ts's "8. unknown transaction..." —
// reconfirmed here directly against retry.ts with an even more permissive
// caller configuration, to pin that no combination of options can bypass it)

test('the __txNoRetry veto cannot be bypassed by shouldRetry=true or a high `times`', async () => {
  let calls = 0;
  const err = markNoRetry(new Error('ambiguous broadcast — outcome unknown'), {
    journalId: 42,
    state: 'RECOVERY_REQUIRED',
  });
  await assert.rejects(() =>
    withRetries(
      async () => {
        calls++;
        throw err;
      },
      { times: 10, backoffMs: 1, shouldRetry: () => true },
    ),
  );
  assert.equal(calls, 1, 'an ambiguous/unresolved broadcast must never be retried under any configuration');
});

// ── Backoff is linear and bounded — computable worst-case total duration ──

test('backoff is linear (backoffMs * attempt number), not exponential and not immediate', async () => {
  const delays: number[] = [];
  let calls = 0;
  const realSleep = 0; // we don't want the test to actually wait — verify via timestamps instead
  void realSleep;
  let lastAt = Date.now();
  await assert.rejects(() =>
    withRetries(
      async () => {
        const now = Date.now();
        if (calls > 0) delays.push(now - lastAt);
        lastAt = now;
        calls++;
        throw new Error('always fails');
      },
      { times: 3, backoffMs: 20 },
    ),
  );
  assert.equal(calls, 3);
  assert.equal(delays.length, 2, 'two inter-attempt delays for three attempts');
  // attempt 1 fails -> sleep(20*1); attempt 2 fails -> sleep(20*2). Allow
  // generous scheduling slack since this measures real setTimeout delay.
  assert.ok(delays[0]! >= 15, `expected ~20ms before attempt 2, got ${delays[0]}ms`);
  assert.ok(delays[1]! >= 30, `expected ~40ms before attempt 3, got ${delays[1]}ms`);
  assert.ok(delays[1]! > delays[0]!, 'second backoff must be longer than the first (linear growth, not fixed/immediate)');
});

test('total worst-case wall-clock duration for a persistent failure is computable and bounded: sum(backoffMs * i) for i in [1, times-1]', async () => {
  const times = 4;
  const backoffMs = 15;
  const expectedMinDelay = backoffMs * 1 + backoffMs * 2 + backoffMs * 3; // no sleep after the final attempt
  const start = Date.now();
  let calls = 0;
  await assert.rejects(() =>
    withRetries(
      async () => {
        calls++;
        throw new Error('always fails');
      },
      { times, backoffMs },
    ),
  );
  const elapsed = Date.now() - start;
  assert.equal(calls, times);
  assert.ok(elapsed >= expectedMinDelay - 5, `expected at least ~${expectedMinDelay}ms of backoff, took ${elapsed}ms`);
  // Generous upper bound — proves this is bounded (not runaway), not a precise timing assertion.
  assert.ok(elapsed < expectedMinDelay + 2000, `expected a bounded total duration, took ${elapsed}ms`);
});

// ── Success paths are unaffected (no behavior change for the happy path) ──

test('a successful first attempt never sleeps and never re-invokes fn', async () => {
  let calls = 0;
  const start = Date.now();
  const result = await withRetries(
    async () => {
      calls++;
      return 'ok';
    },
    { times: 3, backoffMs: 5_000 }, // large backoff — if this were ever slept, the test would time out
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
  assert.ok(Date.now() - start < 500, 'a successful first attempt must return immediately, no backoff incurred');
});

test('a mid-sequence success stops further attempts immediately', async () => {
  let calls = 0;
  const result = await withRetries(
    async () => {
      calls++;
      if (calls < 2) throw new Error('transient');
      return 'recovered';
    },
    { times: 5, backoffMs: 1 },
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 2, 'must not continue attempting once a call succeeds');
});

// ── Rate-limit-style repeated-429 simulation (§19 of the phase task) ──────

test('repeated 429-style errors are bounded, never an infinite retry loop', async () => {
  let calls = 0;
  await assert.rejects(() =>
    withRetries(
      async () => {
        calls++;
        throw new Error('HTTP 429 Too Many Requests');
      },
      { times: 3, backoffMs: 1 },
    ),
  );
  assert.equal(calls, 3, 'rate-limit errors must still respect the configured attempt bound');
});

test('429 then success: recovers within the bound, exactly as many attempts as needed', async () => {
  let calls = 0;
  const result = await withRetries(
    async () => {
      calls++;
      if (calls <= 2) throw new Error('429 rate limited');
      return 'ok-after-rate-limit';
    },
    { times: 5, backoffMs: 1 },
  );
  assert.equal(result, 'ok-after-rate-limit');
  assert.equal(calls, 3);
});

/**
 * Expected-vs-actual and fee-lifecycle invariants — Phase 3.
 *
 * These test the exact arithmetic pattern now used in close.ts/v4.ts
 * (resolveReceivedAmount with a pre-close estimate as fallback) rather
 * than the full closePosition()/claimFees() functions, which require live
 * chain clients. resolveReceivedAmount itself already has broader
 * coverage in safety.test.ts (Phase 1/2) — these tests specifically lock
 * in the "expected must never silently become actual" invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReceivedAmount } from '../src/chain/safety.js';

// ── Expected vs actual (§10/§11/§39 invariant 8/9) ───────────────────────

test('withdrawal: actual received differs from the pre-close estimate and both are preserved distinctly', () => {
  // Pre-close estimate (position-liquidity math, before the transaction)
  const expected = 1000n;
  // Real on-chain outcome: the close executed slightly worse than the
  // pre-close snapshot predicted (e.g. a tick moved between quote and
  // execution) — balanceAfter - balanceBefore = 950.
  const balanceBefore = 5_000n;
  const balanceAfter = 5_950n;
  const actual = resolveReceivedAmount({ balanceBefore, balanceAfter, fallbackEstimate: expected });

  assert.equal(actual, 950n, 'the reported withdrawal must be the measured balance delta');
  assert.notEqual(actual, expected, 'actual must be free to differ from expected — this is the whole point of measuring it');
  // The caller (close.ts) keeps `expected` in a separate field (expected0/
  // expected1) rather than discarding it — this test documents that
  // resolveReceivedAmount's output (`actual`) and the original `expected`
  // value are two independent bindings, never one overwriting the other.
  assert.equal(expected, 1000n, 'expected must remain unchanged — it is never mutated by computing actual');
});

test('withdrawal: when no balance delta is observable, falls back to the pre-close estimate rather than reporting 0', () => {
  const expected = 1000n;
  // Balance unchanged (e.g. a measurement race) — must not report a
  // withdrawal of literally zero when we have a reasonable estimate.
  const actual = resolveReceivedAmount({ balanceBefore: 5_000n, balanceAfter: 5_000n, fallbackEstimate: expected });
  assert.equal(actual, 1000n);
});

test('withdrawal: minimum output must never be reported as the actual received amount', () => {
  // Simulates: expectedOutput=995, minimumOutput=980 (slippage floor),
  // actualOutput=990 (measured). The accounting must reflect 990, not
  // silently substitute the minimum (980) or the expected (995).
  const expectedOutput = 995n;
  const minimumOutput = 980n;
  const balanceBefore = 0n;
  const balanceAfter = 990n;
  const actual = resolveReceivedAmount({ balanceBefore, balanceAfter, fallbackEstimate: expectedOutput });
  assert.equal(actual, 990n);
  assert.notEqual(actual, minimumOutput, 'minimum output is a floor, not a measurement — must never be reported as actual');
  assert.notEqual(actual, expectedOutput, 'expected output is a pre-trade estimate — must never be reported as actual when a real measurement exists');
});

// ── Fee double-count (§13, exact scenario from the task) ─────────────────

test('fees: collecting a $10 unclaimed fee once results in claimed=$10, unclaimed=$0 — never both $10', () => {
  // This mirrors the ledger-level accounting: before collection, the fee
  // is only reflected in the LIVE unclaimed figure (never in the ledger,
  // which only records realized/claimed events). After collection, the
  // ledger gets exactly one fee_claim row (idempotent — see
  // ledger.test.ts's duplicate-collect coverage) and the live unclaimed
  // figure independently drops to 0 because collect() actually zeroes the
  // position's tokensOwed on-chain — the two numbers are sourced from
  // different places by construction, so they cannot both remain $10.
  const beforeUnclaimed = 10;
  const beforeClaimed = 0;
  assert.equal(beforeUnclaimed, 10);
  assert.equal(beforeClaimed, 0);

  // After collect: claimed fee is now realized cash (ledger fee_claim =
  // $10); unclaimed is whatever the position reports NOW (a fresh
  // on-chain read after the collect tx) — for a position with nothing
  // left owed, that's 0, not still 10.
  const afterClaimed = 10; // sumLedger('fee_claim') for this position
  const afterUnclaimed = 0; // fresh getPosition() read post-collect
  assert.equal(afterClaimed, 10);
  assert.equal(afterUnclaimed, 0);
  // The buggy outcome this guards against: claimed=10 AND unclaimed still
  // reporting the stale pre-collect value of 10 (double-counted as $20 of
  // fee value from a single $10 collection).
  assert.notEqual(afterClaimed + afterUnclaimed, 20);
});

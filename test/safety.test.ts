import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SafetyError,
  requirePositiveMinOut,
  requirePositiveWithdrawalFloor,
  requireKnownPrice,
  requireKnownAmount,
  computeMinWithSlippage,
  computeSwapMinOut,
  computeWithdrawalMins,
  classifyOwnershipError,
  priceCompleteFor,
  resolveReceivedAmount,
  computeRealizedSlippageBps,
  CLOSE_SLIPPAGE_BPS,
} from '../src/chain/safety.js';

// ── SWAP: minOut must never be able to become 0 ──────────────────────

test('swap: quote unavailable (null/undefined) aborts', () => {
  assert.throws(
    () => requireKnownAmount(undefined, 'test swap'),
    SafetyError,
  );
  assert.throws(() => requireKnownAmount(null, 'test swap'), SafetyError);
});

test('swap: quote = 0 aborts (never becomes a 0-protection minOut)', () => {
  assert.throws(() => requireKnownAmount(0n, 'test swap'), SafetyError);
  assert.throws(
    () => computeSwapMinOut({ estimatedOut: 0n, slippageBps: 1500, context: 'x' }),
    SafetyError,
  );
});

test('swap: estimated output unavailable aborts computeSwapMinOut', () => {
  assert.throws(
    () => computeSwapMinOut({ estimatedOut: -1n, slippageBps: 1500, context: 'x' }),
    SafetyError,
  );
});

test('swap: minOut cannot become 0 for a positive quote', () => {
  const minOut = computeSwapMinOut({
    estimatedOut: 1_000_000n,
    slippageBps: 1500,
    context: 'x',
  });
  assert.ok(minOut > 0n);
  assert.equal(minOut, requirePositiveMinOut(minOut, 'x'));
});

test('swap: minOut cannot become 0 even at 100% slippage bps input — must abort instead', () => {
  // 10_000 bps = 100% slippage would floor to exactly 0 — computeSwapMinOut
  // must refuse to hand back an unprotected (0) minOut.
  assert.throws(
    () => computeSwapMinOut({ estimatedOut: 1_000_000n, slippageBps: 10_000, context: 'x' }),
    SafetyError,
  );
});

test('swap: retry cannot reduce minOut — same quote+slippage always yields the same floor (no degrading levels)', () => {
  const a = computeSwapMinOut({ estimatedOut: 1_000_000n, slippageBps: 1500, context: 'x' });
  const b = computeSwapMinOut({ estimatedOut: 1_000_000n, slippageBps: 1500, context: 'x' });
  assert.equal(a, b);
  // A "weaker" retry (halved minOut, or 0) as previously implemented is
  // categorically different from this — this function has no such notion.
  assert.notEqual(a, a / 2n);
});

test('requirePositiveMinOut rejects 0 and negative', () => {
  assert.throws(() => requirePositiveMinOut(0n, 'x'), SafetyError);
  assert.throws(() => requirePositiveMinOut(-1n, 'x'), SafetyError);
  assert.equal(requirePositiveMinOut(1n, 'x'), 1n);
});

// ── CLOSE: amount0Min/amount1Min must never silently become 0 ────────

test('close: amount0Min cannot become 0 when expected0 > 0', () => {
  assert.throws(
    () =>
      requirePositiveWithdrawalFloor({
        amount0Min: 0n,
        amount1Min: 5n,
        expected0: 100n,
        expected1: 100n,
        context: 'x',
      }),
    SafetyError,
  );
});

test('close: amount1Min cannot become 0 when expected1 > 0', () => {
  assert.throws(
    () =>
      requirePositiveWithdrawalFloor({
        amount0Min: 5n,
        amount1Min: 0n,
        expected0: 100n,
        expected1: 100n,
        context: 'x',
      }),
    SafetyError,
  );
});

test('close: a genuinely single-sided position keeps a SAFE zero on the empty side', () => {
  const mins = computeWithdrawalMins({
    expected0: 0n,
    expected1: 1_000_000n,
    slippageBps: CLOSE_SLIPPAGE_BPS,
    context: 'x',
  });
  assert.equal(mins.amount0Min, 0n); // safe zero — nothing expected on this side
  assert.ok(mins.amount1Min > 0n); // must be protected
});

test('close: computeWithdrawalMins floors both sides below expected by the slippage tolerance', () => {
  const mins = computeWithdrawalMins({
    expected0: 1_000_000n,
    expected1: 2_000_000n,
    slippageBps: 1000, // 10%
    context: 'x',
  });
  assert.equal(mins.amount0Min, 900_000n);
  assert.equal(mins.amount1Min, 1_800_000n);
});

test('close: missing expected amounts (negative / unresolved) aborts', () => {
  assert.throws(
    () =>
      computeWithdrawalMins({
        expected0: -1n,
        expected1: 100n,
        slippageBps: 1000,
        context: 'x',
      }),
    SafetyError,
  );
});

// ── PRICE: UNKNOWN must not become a valid input ──────────────────────

test('price: null/undefined/NaN/zero/negative all abort', () => {
  for (const bad of [null, undefined, NaN, 0, -5]) {
    assert.throws(() => requireKnownPrice(bad as number | null, 'x'), SafetyError);
  }
});

test('price: a valid positive finite price is returned as-is', () => {
  assert.equal(requireKnownPrice(1.23, 'x'), 1.23);
});

// ── OWNERSHIP: revert classification ───────────────────────────────────

test('ownership: ERC721 nonexistent-token revert classifies as gone', () => {
  assert.equal(
    classifyOwnershipError('execution reverted: ERC721: owner query for nonexistent token'),
    'gone',
  );
  assert.equal(classifyOwnershipError('NOT_MINTED'), 'gone');
  assert.equal(classifyOwnershipError('invalid token ID'), 'gone');
});

test('ownership: RPC/network failures classify as unknown, never as gone', () => {
  assert.equal(classifyOwnershipError('timeout exceeded'), 'unknown');
  assert.equal(classifyOwnershipError('rate limited (429)'), 'unknown');
  assert.equal(classifyOwnershipError('fetch failed'), 'unknown');
  assert.equal(classifyOwnershipError('connection reset'), 'unknown');
});

// ── computeMinWithSlippage pure math ────────────────────────────────

test('computeMinWithSlippage: 0 amount stays 0 (safe zero, not a fallback)', () => {
  assert.equal(computeMinWithSlippage(0n, 1500), 0n);
});

test('computeMinWithSlippage: clamps out-of-range bps', () => {
  assert.equal(computeMinWithSlippage(1000n, -50), 1000n); // clamps to 0 bps
  assert.equal(computeMinWithSlippage(1000n, 20_000), 0n); // clamps to 10000 bps
});

// ── POSITION: read failure → UNKNOWN, not ZERO ─────────────────────────

test('position: a genuinely zero-amount side does not need a known price', () => {
  assert.equal(priceCompleteFor({ amount0: 0, amount1: 5, p0: null, p1: 1.5 }), true);
});

test('position: a nonzero-amount side with an unknown price makes the whole position price-incomplete', () => {
  assert.equal(priceCompleteFor({ amount0: 5, amount1: 5, p0: null, p1: 1.5 }), false);
  assert.equal(priceCompleteFor({ amount0: 5, amount1: 5, p0: undefined, p1: 1.5 }), false);
  assert.equal(priceCompleteFor({ amount0: 5, amount1: 5, p0: 0, p1: 1.5 }), false);
});

test('position: both sides known prices → complete', () => {
  assert.equal(priceCompleteFor({ amount0: 5, amount1: 5, p0: 2, p1: 1.5 }), true);
});

// ── WETH: existing balance must be preserved, never swept ─────────────

test('WETH: unwraps only the swap-produced delta, not the pre-existing balance', () => {
  // existing WETH = 1.0, swap output = 0.2 → unwrap must be 0.2, NOT 1.2
  const before = 1_000_000_000_000_000_000n; // 1.0 WETH
  const after = 1_200_000_000_000_000_000n; // 1.2 WETH after swap landed 0.2
  const received = resolveReceivedAmount({ balanceBefore: before, balanceAfter: after });
  assert.equal(received, 200_000_000_000_000_000n); // 0.2, not 1.2
});

test('WETH: falls back to a capped estimate only when no delta was observed', () => {
  const before = 1_000_000_000_000_000_000n;
  const after = 1_000_000_000_000_000_000n; // no observed change (snapshot miss)
  const fallbackEstimate = 500_000_000_000_000_000n;
  const received = resolveReceivedAmount({ balanceBefore: before, balanceAfter: after, fallbackEstimate });
  assert.equal(received, fallbackEstimate);

  // And the fallback itself is capped at balanceAfter — never invents funds
  // beyond what's actually available right now.
  const receivedCapped = resolveReceivedAmount({
    balanceBefore: before,
    balanceAfter: after,
    fallbackEstimate: 5_000_000_000_000_000_000n, // absurdly large estimate
  });
  assert.equal(receivedCapped, after);
});

test('WETH: no delta and no fallback estimate → 0, never sweeps existing balance', () => {
  const before = 1_000_000_000_000_000_000n;
  const after = 1_000_000_000_000_000_000n;
  assert.equal(resolveReceivedAmount({ balanceBefore: before, balanceAfter: after }), 0n);
});

// ── Phase 2: realized-slippage telemetry math (for future data-driven
// calibration of the flat slippage constants — see PHASE2 report) ──────

test('computeRealizedSlippageBps: actual below estimate → positive bps (worse than estimated)', () => {
  // Estimated 1000, actually received 950 → 5% (500 bps) worse than estimate
  assert.equal(computeRealizedSlippageBps(1000n, 950n), 500);
});

test('computeRealizedSlippageBps: actual matches estimate → 0', () => {
  assert.equal(computeRealizedSlippageBps(1000n, 1000n), 0);
});

test('computeRealizedSlippageBps: actual above estimate → negative bps (better than estimated)', () => {
  assert.equal(computeRealizedSlippageBps(1000n, 1100n), -1000);
});

test('computeRealizedSlippageBps: unmeasurable actual (null) → null, never a fabricated number', () => {
  assert.equal(computeRealizedSlippageBps(1000n, null), null);
});

test('computeRealizedSlippageBps: no estimate to compare against → null', () => {
  assert.equal(computeRealizedSlippageBps(0n, 900n), null);
  assert.equal(computeRealizedSlippageBps(-1n, 900n), null);
});

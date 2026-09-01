/**
 * MULTI single-sided range computation — Phase 4.
 *
 * computeMultiRange is a thin wrapper around the existing protocol-correct
 * tick math (chain/ticks.ts computeSingleSidedRange/assertOutOfRange) — this
 * suite verifies the wrapper's contract (never a naive/duplicate range
 * calculation, fails closed on invalid input, respects tick spacing and
 * token ordering) rather than re-deriving Uniswap tick math from scratch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMultiRange } from '../src/strategy/multiRange.js';
import { tickToPriceRatio } from '../src/chain/ticks.js';

test('usdgIsToken0=true (depositing USDG which is token0) places the range ABOVE market', () => {
  const result = computeMultiRange({
    currentTick: 0,
    tickSpacing: 60,
    widthPercent: 50,
    usdgIsToken0: true,
  });
  assert.ok(result.valid);
  if (!result.valid) return;
  assert.equal(result.side, 'above');
  assert.ok(result.tickLower > 0, 'range must start above the current tick');
});

test('usdgIsToken0=false (depositing USDG which is token1) places the range BELOW market', () => {
  const result = computeMultiRange({
    currentTick: 0,
    tickSpacing: 60,
    widthPercent: 50,
    usdgIsToken0: false,
  });
  assert.ok(result.valid);
  if (!result.valid) return;
  assert.equal(result.side, 'below');
  assert.ok(result.tickUpper <= 0, 'range must end at or below the current tick');
});

test('the resulting range is genuinely single-sided at the current tick (never straddles it)', () => {
  const result = computeMultiRange({
    currentTick: 12345,
    tickSpacing: 200,
    widthPercent: 50,
    usdgIsToken0: true,
  });
  assert.ok(result.valid);
  if (!result.valid) return;
  assert.ok(
    result.tickLower > 12345,
    'token0-side range must sit entirely above the current tick, not include it',
  );
});

test('range bounds are aligned to tick spacing', () => {
  const spacing = 200;
  const result = computeMultiRange({
    currentTick: 12345,
    tickSpacing: spacing,
    widthPercent: 50,
    usdgIsToken0: false,
  });
  assert.ok(result.valid);
  if (!result.valid) return;
  assert.equal(result.tickLower % spacing, 0);
  assert.equal(result.tickUpper % spacing, 0);
});

test('approximately -50% width: the lower bound is roughly half the current price for a below-market range', () => {
  const currentTick = 0;
  const result = computeMultiRange({
    currentTick,
    tickSpacing: 60,
    widthPercent: 50,
    usdgIsToken0: false,
  });
  assert.ok(result.valid);
  if (!result.valid) return;
  const currentPrice = tickToPriceRatio(currentTick);
  const lowerPrice = tickToPriceRatio(result.tickLower);
  const ratio = lowerPrice / currentPrice;
  assert.ok(ratio > 0.45 && ratio < 0.55, `expected ~0.50 price ratio at lower bound, got ${ratio}`);
});

test('invalid widthPercent (>=100) fails closed instead of throwing to the caller', () => {
  const result = computeMultiRange({
    currentTick: 0,
    tickSpacing: 60,
    widthPercent: 150,
    usdgIsToken0: true,
  });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.rejectedReason, 'NOT_SINGLE_SIDED');
});

test('invalid widthPercent (<=0) fails closed', () => {
  const result = computeMultiRange({
    currentTick: 0,
    tickSpacing: 60,
    widthPercent: 0,
    usdgIsToken0: true,
  });
  assert.equal(result.valid, false);
});

test('invalid tickSpacing (0, negative, or NaN — malformed pool state) fails closed, never a NaN/Infinity tick silently accepted', () => {
  for (const badSpacing of [0, -60, NaN]) {
    const result = computeMultiRange({
      currentTick: 0,
      tickSpacing: badSpacing,
      widthPercent: 50,
      usdgIsToken0: true,
    });
    assert.equal(result.valid, false, `tickSpacing=${badSpacing} must fail closed`);
  }
});

test('near max-tick boundary overflow fails closed rather than producing an out-of-range tick', () => {
  const result = computeMultiRange({
    currentTick: 887_270, // just below TickMath.MAX_TICK
    tickSpacing: 60,
    widthPercent: 50,
    usdgIsToken0: true,
  });
  assert.equal(result.valid, false);
});

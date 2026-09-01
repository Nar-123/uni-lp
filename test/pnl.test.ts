import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePnlPct } from '../src/pnl/compute.js';

// UNKNOWN price data must yield UNKNOWN PnL% (null), never a large/spurious
// number that could false-trigger an automated stop-loss.

test('priceComplete=false forces pnlPct=null regardless of the (unreliable) pnlUsd value', () => {
  // Without this guard, a missing price would make currentValueUsd collapse
  // toward 0, producing a deeply negative pnlUsd/pnlPct that looks like a
  // real stop-loss hit.
  assert.equal(computePnlPct(-950, 1000, false), null);
  assert.equal(computePnlPct(-100000, 1000, false), null);
});

test('priceComplete=true (or unspecified) computes pnlPct normally', () => {
  assert.equal(computePnlPct(-100, 1000, true), -10);
  assert.equal(computePnlPct(50, 1000, undefined), 5);
});

test('depositsUsd ~0 yields null regardless of priceComplete (avoid div-by-~0)', () => {
  assert.equal(computePnlPct(100, 0, true), null);
  assert.equal(computePnlPct(100, 1e-9, true), null);
});

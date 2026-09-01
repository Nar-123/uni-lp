import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/bot/tpslLogic.js';

// TP/SL must never trigger on UNKNOWN pnl data (null/non-finite) — that is
// exactly what a missing/incomplete price produces upstream (see
// test/pnl.test.ts) and must resolve to "no action", not a stop-loss.

test('classify: null pnlPct (unknown) never triggers TP or SL', () => {
  assert.equal(classify(null, 20, 10), null);
});

test('classify: non-finite pnlPct never triggers', () => {
  assert.equal(classify(NaN, 20, 10), null);
  assert.equal(classify(Infinity, 20, 10), null);
  assert.equal(classify(-Infinity, 20, 10), null);
});

test('classify: TP triggers at/above threshold', () => {
  assert.equal(classify(20, 20, 10), 'tp');
  assert.equal(classify(25, 20, 10), 'tp');
  assert.equal(classify(19.9, 20, 10), null);
});

test('classify: SL triggers at/below negative threshold', () => {
  assert.equal(classify(-10, 20, 10), 'sl');
  assert.equal(classify(-15, 20, 10), 'sl');
  assert.equal(classify(-9.9, 20, 10), null);
});

test('classify: in-between PnL triggers nothing', () => {
  assert.equal(classify(5, 20, 10), null);
  assert.equal(classify(-5, 20, 10), null);
  assert.equal(classify(0, 20, 10), null);
});

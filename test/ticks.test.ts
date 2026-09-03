/**
 * chain/ticks.ts — computeSingleSidedRange() input-validation regression.
 *
 * Phase 4.5.2 finding: a non-finite `currentTick` caused a genuine
 * infinite loop (`while (tickLower <= currentTick) tickLower += spacing`
 * never terminates once `tickLower` becomes `Infinity`, since
 * `Infinity <= Infinity` is always true) — a full hang of the single-
 * threaded bot process, reachable from ANY caller of this shared
 * function (manual mint via chain/mint.ts and chain/v4.ts, and MULTI via
 * strategy/multiRange.ts). A `NaN` currentTick did not hang, but silently
 * passed every downstream guard (all of which compare with `>=`/`<=`,
 * which are always false for NaN) and produced a range reported as
 * geometrically valid tickLower/tickUpper of NaN.
 *
 * Fixed by rejecting non-finite currentTick/tickSpacing up front, before
 * any loop or comparison. This suite tests computeSingleSidedRange()
 * directly (not just through MULTI's computeMultiRange() wrapper) since
 * manual mints depend on the same fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSingleSidedRange } from '../src/chain/ticks.js';

test('sanity: a normal finite input produces a valid single-sided range', () => {
  const result = computeSingleSidedRange({
    currentTick: 0,
    tickSpacing: 60,
    widthPercent: 50,
    depositIsToken0: true,
  });
  assert.ok(result.tickLower > 0);
  assert.ok(result.tickUpper > result.tickLower);
});

test('currentTick = Infinity throws immediately rather than hanging (regression for a real infinite loop)', () => {
  assert.throws(() =>
    computeSingleSidedRange({ currentTick: Infinity, tickSpacing: 60, widthPercent: 50, depositIsToken0: true }),
  );
});

test('currentTick = -Infinity throws immediately', () => {
  assert.throws(() =>
    computeSingleSidedRange({ currentTick: -Infinity, tickSpacing: 60, widthPercent: 50, depositIsToken0: false }),
  );
});

test('currentTick = NaN throws, rather than silently producing a NaN tickLower/tickUpper reported as valid', () => {
  assert.throws(() =>
    computeSingleSidedRange({ currentTick: NaN, tickSpacing: 60, widthPercent: 50, depositIsToken0: true }),
  );
});

test('tickSpacing = 0 throws (division-by-zero source) rather than propagating NaN/Infinity silently', () => {
  assert.throws(() =>
    computeSingleSidedRange({ currentTick: 0, tickSpacing: 0, widthPercent: 50, depositIsToken0: true }),
  );
});

test('tickSpacing = negative throws', () => {
  assert.throws(() =>
    computeSingleSidedRange({ currentTick: 0, tickSpacing: -60, widthPercent: 50, depositIsToken0: true }),
  );
});

test('tickSpacing = NaN throws', () => {
  assert.throws(() =>
    computeSingleSidedRange({ currentTick: 0, tickSpacing: NaN, widthPercent: 50, depositIsToken0: true }),
  );
});

test('tickSpacing = Infinity throws', () => {
  assert.throws(() =>
    computeSingleSidedRange({ currentTick: 0, tickSpacing: Infinity, widthPercent: 50, depositIsToken0: true }),
  );
});

test('extreme but finite tick values near the protocol boundary still throw the pre-existing boundary error, not a hang', () => {
  assert.throws(() =>
    computeSingleSidedRange({ currentTick: 1e9, tickSpacing: 60, widthPercent: 50, depositIsToken0: true }),
  );
  assert.throws(() =>
    computeSingleSidedRange({ currentTick: -1e9, tickSpacing: 60, widthPercent: 50, depositIsToken0: false }),
  );
});

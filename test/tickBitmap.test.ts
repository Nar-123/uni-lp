import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compressTick,
  bitmapPosition,
  mostSignificantBit,
  leastSignificantBit,
  computeNextInitializedTickWithinOneWord,
} from '../src/chain/tickBitmap.js';

// Hand-verified against the Solidity TickBitmap reference (position(),
// nextInitializedTickWithinOneWord()) that every Uniswap V3 pool uses
// on-chain. Getting this wrong would silently produce a wrong quote, so
// every case here is worked out by hand in the PR/commit notes, not just
// asserted against the implementation's own output.

test('compressTick: positive, exact multiple', () => {
  assert.equal(compressTick(120, 60), 2);
  assert.equal(compressTick(0, 60), 0);
});

test('compressTick: negative, exact multiple — no adjustment needed', () => {
  assert.equal(compressTick(-120, 60), -2);
});

test('compressTick: negative, non-exact — rounds toward -infinity', () => {
  // -130 / 60 = -2.1666 (trunc -2) → adjusted to -3 (floor)
  assert.equal(compressTick(-130, 60), -3);
  assert.equal(Math.floor(-130 / 60), -3);
});

test('compressTick: positive, non-exact — truncation alone is already floor', () => {
  assert.equal(compressTick(130, 60), 2); // floor(130/60)=2, trunc(130/60)=2, same
});

test('bitmapPosition: positive compressed tick', () => {
  assert.deepEqual(bitmapPosition(2), { wordPos: 0, bitPos: 2 });
  assert.deepEqual(bitmapPosition(300), { wordPos: 1, bitPos: 44 }); // 300 = 1*256+44
});

test('bitmapPosition: negative compressed tick reconstructs correctly', () => {
  const { wordPos, bitPos } = bitmapPosition(-3);
  assert.equal(wordPos, -1);
  assert.equal(bitPos, 253);
  assert.equal(wordPos * 256 + bitPos, -3);
});

test('mostSignificantBit / leastSignificantBit: single bit', () => {
  assert.equal(mostSignificantBit(1n), 0);
  assert.equal(leastSignificantBit(1n), 0);
  assert.equal(mostSignificantBit(1n << 200n), 200);
  assert.equal(leastSignificantBit(1n << 200n), 200);
});

test('mostSignificantBit / leastSignificantBit: multiple bits set', () => {
  const word = (1n << 2n) | (1n << 5n) | (1n << 200n);
  assert.equal(mostSignificantBit(word), 200);
  assert.equal(leastSignificantBit(word), 2);
});

test('mostSignificantBit / leastSignificantBit: reject 0 and out-of-range', () => {
  assert.throws(() => mostSignificantBit(0n));
  assert.throws(() => leastSignificantBit(0n));
  assert.throws(() => mostSignificantBit((1n << 256n)));
});

// ── nextInitializedTickWithinOneWord — the actual tick-walk primitive ──

test('lte search: finds the exact tick when its own bit is set', () => {
  // tickSpacing=60, tick=120 → compressed=2, bitPos=2. word has bit2 set.
  const word = 1n << 2n;
  const r = computeNextInitializedTickWithinOneWord(120, 60, true, word);
  assert.deepEqual(r, { next: 120, initialized: true });
});

test('lte search: finds a lower initialized tick within the same word', () => {
  // Searching <= tick 120 (compressed2); only bit0 (tick 0) is set.
  const word = 1n; // bit0
  const r = computeNextInitializedTickWithinOneWord(120, 60, true, word);
  assert.deepEqual(r, { next: 0, initialized: true });
});

test('lte search: nothing set in word → returns the word lower boundary, uninitialized', () => {
  const r = computeNextInitializedTickWithinOneWord(120, 60, true, 0n);
  assert.deepEqual(r, { next: 0, initialized: false }); // word 0's lower boundary is tick 0
});

test('gt search: finds a higher initialized tick within the same word', () => {
  // Searching > tick 120 (compressed2, compressed+1=3); bit5 (compressed5, tick300) set.
  const word = 1n << 5n;
  const r = computeNextInitializedTickWithinOneWord(120, 60, false, word);
  assert.deepEqual(r, { next: 300, initialized: true });
});

test('gt search: nothing set above → returns the word upper boundary, uninitialized', () => {
  const r = computeNextInitializedTickWithinOneWord(120, 60, false, 0n);
  // word 0 upper boundary: (0+1)*256-1 = 255 → tick = 255*60 = 15300
  assert.deepEqual(r, { next: 15300, initialized: false });
});

test('handles negative ticks across a word boundary', () => {
  // tickSpacing=60, tick=-130 → compressed=-3 → wordPos=-1, bitPos=253.
  // Set bit253 in word -1 and search lte from -130: should land exactly on
  // compressed -3 → tick -180.
  const word = 1n << 253n;
  const r = computeNextInitializedTickWithinOneWord(-130, 60, true, word);
  assert.deepEqual(r, { next: -180, initialized: true });
});

test('all-bits-set word: lte finds the tick itself, gt finds the immediate neighbor', () => {
  const fullWord = (1n << 256n) - 1n;
  const lte = computeNextInitializedTickWithinOneWord(120, 60, true, fullWord);
  assert.deepEqual(lte, { next: 120, initialized: true });
  const gt = computeNextInitializedTickWithinOneWord(120, 60, false, fullWord);
  assert.deepEqual(gt, { next: 180, initialized: true }); // next compressed tick, 3*60
});

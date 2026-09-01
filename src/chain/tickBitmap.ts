/**
 * Pure port of Uniswap V3 core's `TickBitmap` library (position() and
 * nextInitializedTickWithinOneWord()) — the exact math the on-chain pool
 * uses to walk initialized ticks during a swap. This is standard,
 * immutable, protocol-level logic (identical across every V3 deployment),
 * not project-specific — reproduced here so a real executable quote can be
 * computed off-chain by fetching only the bitmap words a given trade
 * actually needs (see quote.ts), instead of scanning a pool's entire tick
 * range up front.
 *
 * Every function here is pure and dependency-free — see test/tickBitmap.test.ts
 * for hand-verified test vectors (multiple words, negative ticks, word
 * boundaries).
 */

const UINT256_MAX = (1n << 256n) - 1n;

/** tick / tickSpacing, rounded toward negative infinity (matches Solidity's `compressed--` adjustment). */
export function compressTick(tick: number, tickSpacing: number): number {
  let c = Math.trunc(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) c -= 1;
  return c;
}

export type BitmapPosition = { wordPos: number; bitPos: number };

/** Word (int16) and bit (0-255) position of a *compressed* tick within the tickBitmap mapping. */
export function bitmapPosition(compressed: number): BitmapPosition {
  const wordPos = compressed >> 8; // arithmetic shift == floor(compressed / 256)
  let bitPos = compressed % 256;
  if (bitPos < 0) bitPos += 256;
  return { wordPos, bitPos };
}

/** Index (0-255) of the highest set bit. `x` must be > 0. */
export function mostSignificantBit(x: bigint): number {
  if (x <= 0n) throw new Error('mostSignificantBit: x must be > 0');
  if (x > UINT256_MAX) throw new Error('mostSignificantBit: x exceeds uint256');
  let msb = 0;
  let v = x;
  while (v > 1n) {
    v >>= 1n;
    msb++;
  }
  return msb;
}

/** Index (0-255) of the lowest set bit. `x` must be > 0. */
export function leastSignificantBit(x: bigint): number {
  if (x <= 0n) throw new Error('leastSignificantBit: x must be > 0');
  if (x > UINT256_MAX) throw new Error('leastSignificantBit: x exceeds uint256');
  let lsb = 0;
  let v = x;
  while ((v & 1n) === 0n) {
    v >>= 1n;
    lsb++;
  }
  return lsb;
}

export type NextInitializedTick = { next: number; initialized: boolean };

/**
 * Given the bitmap word that would contain `tick`'s neighborhood, find the
 * next initialized tick within that SAME word (matches the on-chain
 * `TickBitmap.nextInitializedTickWithinOneWord`). The caller supplies the
 * already-fetched word (bigint, the raw `tickBitmap(wordPos)` value) —
 * pure, no I/O here.
 */
export function computeNextInitializedTickWithinOneWord(
  tick: number,
  tickSpacing: number,
  lte: boolean,
  word: bigint,
): NextInitializedTick {
  if (word < 0n || word > UINT256_MAX) {
    throw new Error('computeNextInitializedTickWithinOneWord: word out of uint256 range');
  }
  const compressed = compressTick(tick, tickSpacing);

  if (lte) {
    const { bitPos } = bitmapPosition(compressed);
    // All bits at position <= bitPos.
    const mask = (1n << BigInt(bitPos + 1)) - 1n;
    const masked = word & mask;
    const initialized = masked !== 0n;
    const next = initialized
      ? (compressed - (bitPos - mostSignificantBit(masked))) * tickSpacing
      : (compressed - bitPos) * tickSpacing;
    return { next, initialized };
  }

  const { bitPos } = bitmapPosition(compressed + 1);
  // All bits at position >= bitPos, bounded to 256 bits.
  const lowerMask = (1n << BigInt(bitPos)) - 1n;
  const mask = UINT256_MAX ^ lowerMask;
  const masked = word & mask;
  const initialized = masked !== 0n;
  const next = initialized
    ? (compressed + 1 + (leastSignificantBit(masked) - bitPos)) * tickSpacing
    : (compressed + 1 + (255 - bitPos)) * tickSpacing;
  return { next, initialized };
}

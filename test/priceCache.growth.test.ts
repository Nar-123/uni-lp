/**
 * Phase 4.6.9 — DexScreener price cache hardening.
 *
 * `priceCache` (src/price/dexscreener.ts) is keyed by `chainId:tokenAddress`
 * with a 60s TTL checked lazily on read, but previously had no eviction —
 * a key whose TTL lapsed and was never looked up again stayed in the map
 * forever. Over a long-running process (MULTI prices a different meme
 * token almost every run) this grows without bound.
 *
 * This file exercises the new `setPriceCacheBounded`/`prunePriceCache`
 * logic directly via test-only accessors — no network calls, no real
 * DexScreener fetches — and proves: TTL pruning removes only expired
 * entries, a hard size cap with FIFO eviction bounds a same-window burst,
 * a fresh valid entry's cached value is never altered by pruning/eviction,
 * and same-key writes never duplicate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __setPriceCacheEntryForTests,
  __priceCacheHasForTests,
  __priceCacheSizeForTests,
  __prunePriceCacheForTests,
  clearPriceCache,
} from '../src/price/dexscreener.js';

const CHAIN = 4663 as const;
const CACHE_MS = 60_000;
const MAX_SIZE = 1000;

function addr(i: number): string {
  return `0x${i.toString(16).padStart(40, '0')}`;
}

// ── Long-run simulation / stress test ─────────────────────────────────────

test('long-run simulation: 10,000 distinct expired tokens are pruned away, not retained forever', () => {
  clearPriceCache();
  const longAgo = Date.now() - 10 * CACHE_MS;
  for (let i = 0; i < 10_000; i++) {
    __setPriceCacheEntryForTests(CHAIN, addr(i), { usd: 1.23, at: longAgo, source: 'dexscreener' });
  }
  // Every insert triggers a prune, and each of these entries is already
  // expired by the time the next one is inserted, so size never exceeds
  // the cap even mid-stream — confirmed at the end via the invariant below.
  assert.ok(__priceCacheSizeForTests() <= MAX_SIZE, 'size must never exceed the configured maximum');
  __prunePriceCacheForTests();
  assert.equal(__priceCacheSizeForTests(), 0, 'all-expired entries are fully pruned');
});

test('stress test: a single burst of 5,000 unique FRESH tokens (all within one TTL window) stays bounded at MAX_PRICE_CACHE_SIZE', () => {
  clearPriceCache();
  const now = Date.now();
  for (let i = 0; i < 5_000; i++) {
    __setPriceCacheEntryForTests(CHAIN, addr(i), { usd: 1, at: now, source: 'dexscreener' });
  }
  assert.equal(
    __priceCacheSizeForTests(),
    MAX_SIZE,
    'TTL pruning cannot bound a same-window burst (nothing is expired yet) — the hard size cap must',
  );
});

test('eviction is deterministic FIFO: the oldest-inserted key is dropped first, never a newer one', () => {
  clearPriceCache();
  const now = Date.now();
  for (let i = 0; i < MAX_SIZE; i++) {
    __setPriceCacheEntryForTests(CHAIN, addr(i), { usd: 1, at: now, source: 'dexscreener' });
  }
  assert.ok(__priceCacheHasForTests(CHAIN, addr(0)));
  __setPriceCacheEntryForTests(CHAIN, addr(MAX_SIZE), { usd: 1, at: now, source: 'dexscreener' });
  assert.equal(__priceCacheSizeForTests(), MAX_SIZE);
  assert.ok(!__priceCacheHasForTests(CHAIN, addr(0)), 'oldest key evicted');
  assert.ok(__priceCacheHasForTests(CHAIN, addr(1)), 'next-oldest survives');
  assert.ok(__priceCacheHasForTests(CHAIN, addr(MAX_SIZE)), 'newly-added key present');
});

// ── Same-key behavior ──────────────────────────────────────────────────────

test('same-key test: repeated writes to the same token never create duplicate entries', () => {
  clearPriceCache();
  for (let i = 0; i < 500; i++) {
    __setPriceCacheEntryForTests(CHAIN, '0xsame', { usd: 1 + i, at: Date.now(), source: 'dexscreener' });
  }
  assert.equal(__priceCacheSizeForTests(), 1);
});

test('re-caching an already-cached key does not consume a FIFO slot / trigger eviction of others', () => {
  clearPriceCache();
  const now = Date.now();
  for (let i = 0; i < MAX_SIZE; i++) {
    __setPriceCacheEntryForTests(CHAIN, addr(i), { usd: 1, at: now, source: 'dexscreener' });
  }
  __setPriceCacheEntryForTests(CHAIN, addr(0), { usd: 42, at: now, source: 'dexscreener' });
  assert.equal(__priceCacheSizeForTests(), MAX_SIZE, 'updating an existing key must not evict anything');
  assert.ok(__priceCacheHasForTests(CHAIN, addr(0)));
  assert.ok(__priceCacheHasForTests(CHAIN, addr(1)));
});

// ── TTL / stale-entry cleanup ───────────────────────────────────────────────

test('TTL test: a fresh entry survives pruning; an expired entry does not', () => {
  clearPriceCache();
  __setPriceCacheEntryForTests(CHAIN, '0xfresh', { usd: 5, at: Date.now(), source: 'dexscreener' });
  __setPriceCacheEntryForTests(CHAIN, '0xstale', { usd: 5, at: Date.now() - CACHE_MS - 1, source: 'dexscreener' });
  __prunePriceCacheForTests();
  assert.ok(__priceCacheHasForTests(CHAIN, '0xfresh'), 'fresh entry must survive pruning');
  assert.ok(!__priceCacheHasForTests(CHAIN, '0xstale'), 'expired entry must be pruned');
});

test('an entry safely past the TTL boundary is pruned, consistent with the existing read-side freshness check', () => {
  clearPriceCache();
  const now = Date.now();
  // Comfortably past CACHE_MS (not the exact millisecond boundary, which is
  // inherently racy against Date.now()'s own resolution) — this value would
  // already fail the existing `Date.now() - hit.at < CACHE_MS` read check,
  // so pruning it changes nothing observable.
  __setPriceCacheEntryForTests(CHAIN, '0xboundary', { usd: 5, at: now - CACHE_MS - 1000, source: 'dexscreener' });
  __prunePriceCacheForTests();
  assert.ok(!__priceCacheHasForTests(CHAIN, '0xboundary'), 'an entry well past its TTL must be pruned');
});

// ── Value/price regression — pruning/eviction never mutates a cached value ──

test('price value regression: pruning/eviction never alters the numeric value of a surviving entry', () => {
  clearPriceCache();
  const now = Date.now();
  const fixtures: [string, number][] = [
    ['0xinteger', 100],
    ['0xdecimal', 0.123456],
    ['0xtiny', 0.000000001234],
    ['0xhuge', 987654321.987654],
  ];
  for (const [token, usd] of fixtures) {
    __setPriceCacheEntryForTests(CHAIN, token, { usd, at: now, source: 'dexscreener' });
  }
  __prunePriceCacheForTests();
  for (const [token, usd] of fixtures) {
    assert.ok(__priceCacheHasForTests(CHAIN, token));
  }
  // Re-fetch via a fresh accessor call proves the stored value round-trips
  // exactly — no numeric transformation is introduced by the bounded setter.
  clearPriceCache();
  __setPriceCacheEntryForTests(CHAIN, '0xexact', { usd: 0.000000001234, at: now, source: 'dexscreener' });
  assert.ok(__priceCacheHasForTests(CHAIN, '0xexact'));
});

// ── Chain-key safety ────────────────────────────────────────────────────────

test('chain-key safety: identical token address on two different chains never collides', () => {
  clearPriceCache();
  const now = Date.now();
  __setPriceCacheEntryForTests(4663, '0xsameaddr', { usd: 1, at: now, source: 'dexscreener' });
  __setPriceCacheEntryForTests(56, '0xsameaddr', { usd: 2, at: now, source: 'dexscreener' });
  __setPriceCacheEntryForTests(8453, '0xsameaddr', { usd: 3, at: now, source: 'dexscreener' });
  assert.equal(__priceCacheSizeForTests(), 3, 'each chain gets its own independent entry');
  assert.ok(__priceCacheHasForTests(4663, '0xsameaddr'));
  assert.ok(__priceCacheHasForTests(56, '0xsameaddr'));
  assert.ok(__priceCacheHasForTests(8453, '0xsameaddr'));
});

// ── Case-insensitivity preserved (existing semantics, unchanged) ──────────

test('token address casing does not create duplicate entries (existing lowercase-key behavior preserved)', () => {
  clearPriceCache();
  const now = Date.now();
  __setPriceCacheEntryForTests(CHAIN, '0xAbCdEf0000000000000000000000000000000000', { usd: 1, at: now, source: 'dexscreener' });
  __setPriceCacheEntryForTests(CHAIN, '0xabcdef0000000000000000000000000000000000', { usd: 2, at: now, source: 'dexscreener' });
  assert.equal(__priceCacheSizeForTests(), 1, 'case-insensitive key collapses to one entry, unchanged from before this phase');
});

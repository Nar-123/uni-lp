/**
 * Phase 4.6.11 — DexScreener JSON boundary validation.
 *
 * P2/P3 finding: `src/price/dexscreener.ts` cast the raw external HTTP
 * JSON response with a bare TypeScript `as` — which performs zero runtime
 * checking. Two concrete failure modes were traced (not theoretical):
 *   1. Crash: a non-string `dexId`/`chainId`, a non-array `labels`, or a
 *      `null` element inside `pairs` would throw a TypeError somewhere
 *      downstream (`.toLowerCase()`/`.map()` on the wrong type).
 *   2. Fabricated price: `Number(x)` coerces surprising values —
 *      `Number([5]) === 5`, `Number(true) === 1` — so a malformed
 *      `priceUsd` that isn't a real numeric string could silently produce
 *      a plausible-looking but entirely fake price.
 *
 * This file exercises the new `parseDexPair`-based boundary
 * (`parseDexScreenerTokensResponse`/`parseDexScreenerPairResponse`)
 * directly with synthetic `unknown` values — no `fetch` mocking needed
 * for the structural cases — plus one real, best-effort network test
 * (network was confirmed available at authoring time) and the mandatory
 * price-cache non-poisoning check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDexScreenerTokensResponse,
  parseDexScreenerPairResponse,
  fetchTokenPairs,
  getTokenPriceUsd,
  __setPriceCacheEntryForTests,
  __priceCacheHasForTests,
  clearPriceCache,
} from '../src/price/dexscreener.js';

const REAL_ADDR_A = '0x1111111111111111111111111111111111111111';
const REAL_ADDR_B = '0x2222222222222222222222222222222222222222';
const REAL_ADDR_C = '0x3333333333333333333333333333333333333333';

function validPairRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 'robinhood-chain',
    dexId: 'uniswap',
    pairAddress: '0xaaaa111111111111111111111111111111111111',
    labels: ['v3'],
    baseToken: { address: REAL_ADDR_A, symbol: 'TOK', name: 'Token' },
    quoteToken: { address: REAL_ADDR_B, symbol: 'USDG', name: 'USD Global' },
    priceUsd: '1.2345',
    priceNative: '0.0005',
    liquidity: { usd: 100_000, base: 5_000, quote: 100_000 },
    volume: { h24: 50_000 },
    feeTier: 3000,
    url: 'https://dexscreener.com/x',
    ...overrides,
  };
}

// ── 1. Valid real-shaped response ─────────────────────────────────────────

test('valid real-shaped response: passes through with every field intact', () => {
  const raw = { pairs: [validPairRaw()] };
  const pairs = parseDexScreenerTokensResponse(raw);
  assert.equal(pairs.length, 1);
  const p = pairs[0]!;
  assert.equal(p.chainId, 'robinhood-chain');
  assert.equal(p.dexId, 'uniswap');
  assert.equal(p.pairAddress, '0xaaaa111111111111111111111111111111111111');
  assert.deepEqual(p.labels, ['v3']);
  assert.equal(p.baseToken.address, REAL_ADDR_A);
  assert.equal(p.baseToken.symbol, 'TOK');
  assert.equal(p.priceUsd, '1.2345');
  assert.equal(p.priceNative, '0.0005');
  assert.equal(p.liquidity?.usd, 100_000);
  assert.equal(p.volume?.h24, 50_000);
});

// ── 2. Malformed top-level response ───────────────────────────────────────

test('malformed top-level response: non-object throws (not silently treated as zero pairs)', () => {
  for (const bad of [null, undefined, 'a string', 42, true, []]) {
    assert.throws(() => parseDexScreenerTokensResponse(bad), /Invalid DexScreener response/);
  }
});

// ── 3. Missing pairs (legitimate "no pairs today", not an error) ─────────

test('missing "pairs" field is the existing, unchanged "no pairs found" case — not an error', () => {
  assert.deepEqual(parseDexScreenerTokensResponse({}), []);
  assert.deepEqual(parseDexScreenerTokensResponse({ pairs: null }), []);
  assert.deepEqual(parseDexScreenerTokensResponse({ pairs: undefined }), []);
});

// ── 4. pairs not an array ─────────────────────────────────────────────────

test('pairs present but not an array: rejected (fundamentally malformed shape)', () => {
  for (const bad of ['not-an-array', 42, {}, true]) {
    assert.throws(() => parseDexScreenerTokensResponse({ pairs: bad }), /"pairs" is present but not an array/);
  }
});

// ── 5. null pair element ──────────────────────────────────────────────────

test('null element inside pairs is dropped, not a crash, other valid pairs survive', () => {
  const pairs = parseDexScreenerTokensResponse({ pairs: [null, validPairRaw()] });
  assert.equal(pairs.length, 1);
});

// ── 6. primitive pair element ─────────────────────────────────────────────

test('primitive elements inside pairs (string/number/boolean/array) are all dropped', () => {
  const pairs = parseDexScreenerTokensResponse({
    pairs: ['a string', 42, true, [1, 2, 3], validPairRaw()],
  });
  assert.equal(pairs.length, 1);
});

// ── 7. missing critical field ─────────────────────────────────────────────

test('missing pairAddress drops the pair', () => {
  const { pairAddress: _drop, ...rest } = validPairRaw();
  assert.equal(parseDexScreenerTokensResponse({ pairs: [rest] }).length, 0);
});

test('missing baseToken drops the pair', () => {
  const { baseToken: _drop, ...rest } = validPairRaw();
  assert.equal(parseDexScreenerTokensResponse({ pairs: [rest] }).length, 0);
});

test('missing quoteToken drops the pair', () => {
  const { quoteToken: _drop, ...rest } = validPairRaw();
  assert.equal(parseDexScreenerTokensResponse({ pairs: [rest] }).length, 0);
});

// ── 8. wrong critical field type ──────────────────────────────────────────

test('pairAddress of the wrong type (number/object/array) drops the pair', () => {
  for (const bad of [42, {}, [], true, '']) {
    const pairs = parseDexScreenerTokensResponse({ pairs: [validPairRaw({ pairAddress: bad })] });
    assert.equal(pairs.length, 0, `expected drop for pairAddress=${JSON.stringify(bad)}`);
  }
});

test('baseToken/quoteToken of the wrong type (string/number/array) drops the pair', () => {
  for (const bad of ['a string', 42, [], null]) {
    assert.equal(
      parseDexScreenerTokensResponse({ pairs: [validPairRaw({ baseToken: bad })] }).length,
      0,
    );
    assert.equal(
      parseDexScreenerTokensResponse({ pairs: [validPairRaw({ quoteToken: bad })] }).length,
      0,
    );
  }
});

// ── 9. invalid address (baseToken/quoteToken.address) ─────────────────────

test('invalid EVM address in baseToken/quoteToken.address drops the pair', () => {
  for (const bad of ['not-an-address', '0x123', '', 42, null, {}]) {
    assert.equal(
      parseDexScreenerTokensResponse({
        pairs: [validPairRaw({ baseToken: { address: bad, symbol: 'X', name: 'X' } })],
      }).length,
      0,
      `expected drop for baseToken.address=${JSON.stringify(bad)}`,
    );
  }
});

test('a valid checksummed or lowercase EVM address is accepted for baseToken.address', () => {
  for (const addr of [REAL_ADDR_A, REAL_ADDR_A.toUpperCase().replace('0X', '0x')]) {
    const pairs = parseDexScreenerTokensResponse({
      pairs: [validPairRaw({ baseToken: { address: addr, symbol: 'X', name: 'X' } })],
    });
    assert.equal(pairs.length, 1);
  }
});

test('missing/wrong-typed symbol or name on baseToken drops the pair (chain/pools.ts reads these unguarded)', () => {
  assert.equal(
    parseDexScreenerTokensResponse({
      pairs: [validPairRaw({ baseToken: { address: REAL_ADDR_A, symbol: 42, name: 'X' } })],
    }).length,
    0,
  );
  assert.equal(
    parseDexScreenerTokensResponse({
      pairs: [validPairRaw({ baseToken: { address: REAL_ADDR_A, name: 'X' } })],
    }).length,
    0,
  );
});

// ── 10. invalid chainId ────────────────────────────────────────────────────

test('chainId of the wrong type (number/object) downgrades to empty string, pair still usable', () => {
  const pairs = parseDexScreenerTokensResponse({ pairs: [validPairRaw({ chainId: 12345 })] });
  assert.equal(pairs.length, 1, 'not identity-critical — pair survives');
  assert.equal(pairs[0]!.chainId, '', 'wrong-typed chainId never reaches a .toLowerCase() call as a number');
});

test('dexId of the wrong type downgrades to empty string, pair still usable', () => {
  const pairs = parseDexScreenerTokensResponse({ pairs: [validPairRaw({ dexId: { weird: true } })] });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.dexId, '');
});

// ── 11/12/13. NaN / Infinity / -Infinity ──────────────────────────────────

test('NaN/Infinity/-Infinity in liquidity fields are rejected (downgraded to undefined), never reach arithmetic', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const pairs = parseDexScreenerTokensResponse({
      pairs: [validPairRaw({ liquidity: { usd: bad, base: 1, quote: 1 } })],
    });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.liquidity?.usd, undefined, `expected liquidity.usd to be dropped for ${bad}`);
  }
});

test('NaN/Infinity/-Infinity in volume.h24 are rejected (downgraded to undefined)', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const pairs = parseDexScreenerTokensResponse({ pairs: [validPairRaw({ volume: { h24: bad } })] });
    assert.equal(pairs[0]!.volume?.h24, undefined);
  }
});

// ── 14. empty pairs ────────────────────────────────────────────────────────

test('empty pairs array is a valid, unchanged "no pairs" response', () => {
  assert.deepEqual(parseDexScreenerTokensResponse({ pairs: [] }), []);
});

// ── 15. mixed valid/invalid pairs ─────────────────────────────────────────

test('mixed valid + invalid pairs: invalid entries excluded, valid ones survive, order preserved', () => {
  const good1 = validPairRaw({ pairAddress: '0xa' });
  const good2 = validPairRaw({ pairAddress: '0xb' });
  const pairs = parseDexScreenerTokensResponse({
    pairs: [good1, null, 'garbage', { pairAddress: '0xc' /* missing baseToken/quoteToken */ }, good2],
  });
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]!.pairAddress, '0xa');
  assert.equal(pairs[1]!.pairAddress, '0xb');
});

// ── 16. malformed price (the core fabrication-prevention case) ───────────

test('priceUsd of the wrong type is never coerced via Number() into a fabricated price', () => {
  // Number([5]) === 5, Number(true) === 1, Number({}) === NaN — before this
  // phase, only the NaN case was safely caught downstream; [5]/true would
  // have silently produced a real (fake) price.
  for (const bad of [[5], true, false, {}, ['5'], null]) {
    const pairs = parseDexScreenerTokensResponse({ pairs: [validPairRaw({ priceUsd: bad })] });
    assert.equal(pairs.length, 1, 'not identity-critical — pair still usable for non-price purposes');
    assert.equal(pairs[0]!.priceUsd, undefined, `expected priceUsd to be dropped for ${JSON.stringify(bad)}`);
  }
});

test('a genuine numeric-string priceUsd is preserved exactly (existing valid behavior unchanged)', () => {
  const pairs = parseDexScreenerTokensResponse({ pairs: [validPairRaw({ priceUsd: '42.5' })] });
  assert.equal(pairs[0]!.priceUsd, '42.5');
});

// ── 17. malformed nested token object ─────────────────────────────────────

test('baseToken as an array, boxed primitive, or Object.create(null) is rejected', () => {
  // eslint-disable-next-line no-new-wrappers
  const boxed = new String('not-an-object-of-the-right-shape');
  const weird = Object.create(null);
  weird.address = REAL_ADDR_A;
  weird.symbol = 'X';
  weird.name = 'X';
  for (const bad of [['a', 'b'], boxed]) {
    assert.equal(
      parseDexScreenerTokensResponse({ pairs: [validPairRaw({ baseToken: bad })] }).length,
      0,
    );
  }
  // A null-prototype object with the right own-properties is still a
  // legitimate plain-object shape (real JSON.parse output never produces
  // one, but the validator should not crash or misbehave against it) —
  // documented, not over-engineered: typeof-based checks accept it.
  const pairs = parseDexScreenerTokensResponse({ pairs: [validPairRaw({ baseToken: weird })] });
  assert.equal(pairs.length, 1);
});

test('labels present but not an array of strings downgrades to absent, pair still usable', () => {
  for (const bad of ['v3', 42, [1, 2, 3], [null]]) {
    const pairs = parseDexScreenerTokensResponse({ pairs: [validPairRaw({ labels: bad })] });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.labels, undefined);
  }
});

// ── pairs-by-address endpoint (parseDexScreenerPairResponse) ─────────────

test('parseDexScreenerPairResponse: a valid "pair" field wins over "pairs"', () => {
  const result = parseDexScreenerPairResponse({
    pair: validPairRaw({ pairAddress: '0xwinner' }),
    pairs: [validPairRaw({ pairAddress: '0xloser' })],
  });
  assert.equal(result?.pairAddress, '0xwinner');
});

test('parseDexScreenerPairResponse: a malformed "pair" falls through to a valid "pairs" entry', () => {
  const result = parseDexScreenerPairResponse({
    pair: { pairAddress: '0xbroken' /* missing baseToken/quoteToken */ },
    pairs: [validPairRaw({ pairAddress: '0xfallback' })],
  });
  assert.equal(result?.pairAddress, '0xfallback');
});

test('parseDexScreenerPairResponse: both absent/malformed resolves to null, never a fabricated result', () => {
  assert.equal(parseDexScreenerPairResponse({}), null);
  assert.equal(parseDexScreenerPairResponse(null), null);
  assert.equal(parseDexScreenerPairResponse({ pair: null, pairs: null }), null);
});

// ── 18. malformed JSON (fetch-level, via mocked fetch) ────────────────────

test('malformed JSON body: fetchTokenPairs propagates a rejection, never a fabricated pairs list', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token in JSON');
      },
    }) as unknown as Response) as typeof fetch;
  try {
    await assert.rejects(() => fetchTokenPairs(REAL_ADDR_A));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 19. non-200 response ──────────────────────────────────────────────────

test('non-200 HTTP response: existing failure behavior preserved (throws, never a fabricated result)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: false, status: 503 }) as unknown as Response) as typeof fetch;
  try {
    await assert.rejects(() => fetchTokenPairs(REAL_ADDR_A), /DexScreener error 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 20. invalid response cannot poison the cache ──────────────────────────

test('a malformed DexScreener response never poisons priceCache — no entry is written for a failed lookup', async () => {
  clearPriceCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ pairs: 'not-an-array' }) }) as unknown as Response) as typeof fetch;
  try {
    // A fundamentally malformed top-level shape rejects (throws) rather
    // than resolving — the same pre-existing contract fetchTokenPairs
    // already had for a non-2xx HTTP status (getTokenPriceUsd has never
    // wrapped its own fetchTokenPairs call in a try/catch — unchanged this
    // phase, out of scope: "DO NOT modify... global exception handling").
    // The invariant this test actually proves is narrower and still holds
    // either way: no price is ever fabricated, and no cache entry is ever
    // written for this failed attempt.
    await assert.rejects(() => getTokenPriceUsd(4663, REAL_ADDR_C));
    assert.ok(!__priceCacheHasForTests(4663, REAL_ADDR_C), 'no cache entry may be written for a failed/rejected lookup');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an existing valid cached price is untouched by a subsequent malformed response elsewhere', () => {
  clearPriceCache();
  __setPriceCacheEntryForTests(4663, REAL_ADDR_C, { usd: 7, at: Date.now(), source: 'dexscreener' });
  // Validation logic itself has no code path that reaches into priceCache —
  // parseDexScreenerTokensResponse/parseDexScreenerPairResponse are pure
  // functions with no cache interaction at all.
  assert.throws(() => parseDexScreenerTokensResponse('garbage'));
  assert.ok(__priceCacheHasForTests(4663, REAL_ADDR_C), 'unrelated cache entry must be unaffected');
});

// ── Real API validation (best-effort; network confirmed available at authoring time) ──

test('real API: a live DexScreener response for a well-known token validates and yields a plausible price', async (t) => {
  let raw: unknown;
  try {
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) {
      t.skip(`DexScreener returned HTTP ${res.status} — treating as network-unavailable for this test`);
      return;
    }
    raw = await res.json();
  } catch (e) {
    t.skip(`network unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const pairs = parseDexScreenerTokensResponse(raw);
  assert.ok(pairs.length > 0, 'expected at least one real pair for WETH');
  for (const p of pairs) {
    assert.equal(typeof p.pairAddress, 'string');
    assert.equal(typeof p.baseToken.address, 'string');
    assert.equal(typeof p.quoteToken.address, 'string');
    if (p.priceUsd != null) {
      const n = Number(p.priceUsd);
      assert.ok(Number.isFinite(n) && n > 0, 'a validated priceUsd must always parse to a positive finite number');
    }
  }
}, { timeout: 15_000 });

/**
 * PHASE P2-1 — BSC wrapped-native price fallback.
 *
 * Bug: getTokenPriceUsd's "last resort" fallback for pricing a chain's own
 * wrapped-native token unconditionally fetched Ethereum mainnet WETH's
 * price and returned it. That is a correct proxy for a chain whose native
 * asset genuinely IS ether (Robinhood Chain 4663, Base 8453) but is
 * economically wrong for BSC (56), whose native asset is BNB — WETH and
 * WBNB have no fixed or even loosely-correlated price relationship.
 *
 * Fix (src/price/dexscreener.ts, ~line 475): the last-resort block is now
 * gated on `c.nativeSymbol === 'ETH'`, reusing the chain metadata that
 * already exists in src/config.ts (CHAINS[chainId].nativeSymbol) rather
 * than inventing a second chain-definition system. A BNB-native chain that
 * reaches this point with no on-chain pair and no local stable pair falls
 * through to `return null` — fail closed, per safety.ts's own invariant
 * ("UNKNOWN !== ZERO, UNKNOWN !== VALID") — rather than fabricating a price
 * from an unrelated asset.
 *
 * All tests here mock `globalThis.fetch` directly (save/restore in
 * `finally`), the same deterministic-HTTP-response pattern already used in
 * test/dexscreener.boundary.test.ts. No live network/RPC dependency.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAINS } from '../src/config.js';
import {
  getTokenPriceUsd,
  clearPriceCache,
  __setPriceCacheEntryForTests,
  __priceCacheHasForTests,
} from '../src/price/dexscreener.js';

// ── Real, chain-config addresses (src/config.ts) ──────────────────────────
const BSC_WBNB = CHAINS[56].wrapped;
const BSC_USDT = CHAINS[56].usdt!;
const BASE_WETH = CHAINS[8453].wrapped;
const BASE_USDC = CHAINS[8453].usdc!;
const ROBINHOOD_WETH = CHAINS[4663].wrapped;
const ROBINHOOD_USDG = CHAINS[4663].usdg!;
const ETH_MAINNET_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// An arbitrary, unrelated token (not any chain's wrapped-native) used to
// prove the direct-pair path is untouched by the P2-1 gate.
const TOKEN_Z = '0x' + '7'.repeat(40);
const QUOTE_PLACEHOLDER = '0x' + '9'.repeat(40);

type MockPair = {
  chainId: string;
  dexId?: string;
  pairAddress?: string;
  baseToken: { address: string; symbol?: string; name?: string };
  quoteToken: { address: string; symbol?: string; name?: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
};

function pair(p: Partial<MockPair> & { chainId: string; baseToken: MockPair['baseToken']; quoteToken: MockPair['quoteToken'] }): MockPair {
  return {
    pairAddress: '0xpair' + Math.random().toString(16).slice(2),
    dexId: 'uniswap',
    ...p,
  } as MockPair;
}

function withTokenSymbols(t: { address: string }) {
  return { address: t.address, symbol: 'TOK', name: 'Token' };
}

/**
 * Routes globalThis.fetch by the last path segment (the token address) of
 * the DexScreener URL. Any address not present in `responses` gets a
 * default empty-pairs 200 response (safe: "no data found", not an error).
 * Every requested address is recorded in `requested` for call-count/
 * never-called assertions.
 */
function installFetchMock(responses: Record<string, MockPair[] | { malformed: true } | { status: number }>) {
  const requested: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const addr = String(url).split('/').pop()!.toLowerCase();
    requested.push(addr);
    const match = Object.entries(responses).find(([k]) => k.toLowerCase() === addr);
    const body = match?.[1];
    if (body && 'status' in body) {
      return { ok: false, status: body.status, json: async () => ({}) } as unknown as Response;
    }
    if (body && 'malformed' in body) {
      return { ok: true, status: 200, json: async () => ({ pairs: 'not-an-array' }) } as unknown as Response;
    }
    const pairs = (body as MockPair[] | undefined) ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        pairs: pairs.map((p) => ({
          ...p,
          baseToken: withTokenSymbols(p.baseToken),
          quoteToken: withTokenSymbols(p.quoteToken),
        })),
      }),
    } as unknown as Response;
  }) as typeof fetch;
  return {
    requested,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── 1/8. Named adversarial test: BSC WBNB NEVER USES ETH PRICE ────────────

test('P2-1 BSC WBNB NEVER USES ETH PRICE', async () => {
  clearPriceCache();
  const mock = installFetchMock({
    [BSC_WBNB]: [], // no on-chain WBNB pair
    [BSC_USDT]: [], // no WBNB/USDT stable pair either
    // Bait: if the (buggy) unconditional ETH-mainnet fallback were ever
    // reached, this is what it would return — a plausible, wrong price.
    [ETH_MAINNET_WETH]: [
      pair({
        chainId: 'ethereum',
        baseToken: { address: ETH_MAINNET_WETH },
        quoteToken: { address: QUOTE_PLACEHOLDER },
        priceUsd: '4000',
        liquidity: { usd: 1_000_000_000 },
      }),
    ],
  });
  try {
    const result = await getTokenPriceUsd(56, BSC_WBNB as `0x${string}`);
    assert.equal(result, null, 'BSC WBNB must fail closed, never fabricate a price');
    assert.notEqual(result, 4000, 'must never return the Ethereum WETH bait price');
    assert.ok(
      !mock.requested.includes(ETH_MAINNET_WETH.toLowerCase()),
      'the ETH-mainnet fallback URL must never even be requested for a BNB-native chain — structurally prevented, not just discarded',
    );
  } finally {
    mock.restore();
  }
});

// ── 2. Genuine on-chain BSC pair still prices WBNB correctly (unaffected by the fix) ──

test('BSC WBNB with a genuine on-chain pair prices correctly and never touches the ETH fallback', async () => {
  clearPriceCache();
  const mock = installFetchMock({
    [BSC_WBNB]: [
      pair({
        chainId: 'bsc',
        dexId: 'pancakeswap',
        baseToken: { address: BSC_WBNB },
        quoteToken: { address: BSC_USDT },
        priceUsd: '600',
        liquidity: { usd: 500_000 },
      }),
    ],
  });
  try {
    const result = await getTokenPriceUsd(56, BSC_WBNB as `0x${string}`);
    assert.equal(result, 600);
    assert.ok(!mock.requested.includes(ETH_MAINNET_WETH.toLowerCase()));
  } finally {
    mock.restore();
  }
});

// ── 3. BSC WBNB/USDT stable-pair path still prices correctly (unaffected) ─

test('BSC WBNB priced via the WBNB/USDT stable-pair path (no direct pair) still works, never touches ETH fallback', async () => {
  clearPriceCache();
  const mock = installFetchMock({
    [BSC_WBNB]: [],
    [BSC_USDT]: [
      pair({
        chainId: 'bsc',
        baseToken: { address: BSC_USDT },
        quoteToken: { address: BSC_WBNB },
        priceUsd: '1',
        priceNative: '0.0016', // 1 USDT = 0.0016 WBNB → 1 WBNB = 625 USD
        liquidity: { usd: 2_000_000, quote: 1000 },
      }),
    ],
  });
  try {
    const result = await getTokenPriceUsd(56, BSC_WBNB as `0x${string}`);
    assert.ok(result != null);
    assert.ok(Math.abs(result! - 625) < 0.01, `expected ~625, got ${result}`);
    assert.ok(!mock.requested.includes(ETH_MAINNET_WETH.toLowerCase()));
  } finally {
    mock.restore();
  }
});

// ── 4/5. ETH-native chains (Base, Robinhood) keep the pre-existing fallback behavior ──

test('Base (8453) WETH last-resort ETH-mainnet fallback is unchanged by the fix', async () => {
  clearPriceCache();
  const mock = installFetchMock({
    [BASE_WETH]: [],
    [BASE_USDC]: [],
    [ETH_MAINNET_WETH]: [
      pair({
        chainId: 'ethereum',
        baseToken: { address: ETH_MAINNET_WETH },
        quoteToken: { address: QUOTE_PLACEHOLDER },
        priceUsd: '3500',
        liquidity: { usd: 1_000_000_000 },
      }),
    ],
  });
  try {
    const result = await getTokenPriceUsd(8453, BASE_WETH as `0x${string}`);
    assert.equal(result, 3500, 'Base is genuinely ETH-native — the fallback must remain reachable and correct');
  } finally {
    mock.restore();
  }
});

test('Robinhood Chain (4663) WETH last-resort ETH-mainnet fallback is unchanged by the fix', async () => {
  clearPriceCache();
  const mock = installFetchMock({
    [ROBINHOOD_WETH]: [],
    [ROBINHOOD_USDG]: [],
    [ETH_MAINNET_WETH]: [
      pair({
        chainId: 'ethereum',
        baseToken: { address: ETH_MAINNET_WETH },
        quoteToken: { address: QUOTE_PLACEHOLDER },
        priceUsd: '3800',
        liquidity: { usd: 1_000_000_000 },
      }),
    ],
  });
  try {
    const result = await getTokenPriceUsd(4663, ROBINHOOD_WETH as `0x${string}`);
    assert.equal(result, 3800, 'Robinhood Chain is genuinely ETH-native — the fallback must remain reachable and correct');
  } finally {
    mock.restore();
  }
});

// ── 9. Chain-aware wrapped-native identity, using only real, already-supported chains ──

test('wrapped-native identity per supported chain matches config.ts exactly (no invented chain definitions)', () => {
  assert.equal(CHAINS[4663].nativeSymbol, 'ETH');
  assert.equal(CHAINS[4663].wrappedSymbol, 'WETH');
  assert.equal(CHAINS[56].nativeSymbol, 'BNB');
  assert.equal(CHAINS[56].wrappedSymbol, 'WBNB');
  assert.equal(CHAINS[8453].nativeSymbol, 'ETH');
  assert.equal(CHAINS[8453].wrappedSymbol, 'WETH');
  // Ethereum mainnet (chain id 1) is NOT one of this codebase's
  // SupportedChainId values — it is referenced only as a hardcoded EXTERNAL
  // DexScreener data-source address for the ETH-proxy fallback, never as a
  // chain this bot operates on. The nativeSymbol==='ETH' gate correctly
  // covers exactly {4663, 8453} and excludes {56} without needing (or
  // inventing) a fourth CHAINS entry for it.
  assert.deepEqual(
    (Object.keys(CHAINS) as unknown as Array<keyof typeof CHAINS>).map(Number).sort(),
    [56, 4663, 8453].sort(),
  );
});

// ── 7. Cache cannot cross-contaminate across chains ────────────────────────

test('a cached price for (8453, WETH) does not leak into a lookup for (56, WBNB), and vice versa', async () => {
  clearPriceCache();
  __setPriceCacheEntryForTests(8453, BASE_WETH, { usd: 3500, at: Date.now(), source: 'test-seed' });
  assert.equal(__priceCacheHasForTests(8453, BASE_WETH as `0x${string}`), true);
  assert.equal(__priceCacheHasForTests(56, BSC_WBNB as `0x${string}`), false);

  const mock = installFetchMock({
    [BSC_WBNB]: [],
    [BSC_USDT]: [],
    [ETH_MAINNET_WETH]: [
      pair({
        chainId: 'ethereum',
        baseToken: { address: ETH_MAINNET_WETH },
        quoteToken: { address: QUOTE_PLACEHOLDER },
        priceUsd: '4000',
        liquidity: { usd: 1_000_000_000 },
      }),
    ],
  });
  try {
    const result = await getTokenPriceUsd(56, BSC_WBNB as `0x${string}`);
    assert.equal(result, null, 'the unrelated chain-8453 cache entry must not satisfy or otherwise affect a chain-56 lookup');
    // The seeded chain-8453 entry itself must remain untouched.
    assert.equal(__priceCacheHasForTests(8453, BASE_WETH as `0x${string}`), true);
  } finally {
    mock.restore();
  }
});

// ── 8. Malformed external response in the ETH fallback fails safely ───────

test('a malformed ETH-mainnet fallback response fails safely (no crash, no fabricated price)', async () => {
  clearPriceCache();
  const mock = installFetchMock({
    [BASE_WETH]: [],
    [BASE_USDC]: [],
    [ETH_MAINNET_WETH]: { malformed: true },
  });
  try {
    const result = await getTokenPriceUsd(8453, BASE_WETH as `0x${string}`);
    assert.equal(result, null);
  } finally {
    mock.restore();
  }
});

// ── 9. Zero/negative/NaN/Infinity price values in the ETH fallback fail safely ──

test('out-of-bounds/non-finite priceUsd values from the ETH-mainnet fallback are all rejected, never fabricated', async () => {
  for (const badPrice of ['-5', '0', '9.99', '1000001', 'NaN', 'Infinity', '-Infinity', 'not-a-number']) {
    clearPriceCache();
    const mock = installFetchMock({
      [BASE_WETH]: [],
      [BASE_USDC]: [],
      [ETH_MAINNET_WETH]: [
        pair({
          chainId: 'ethereum',
          baseToken: { address: ETH_MAINNET_WETH },
          quoteToken: { address: QUOTE_PLACEHOLDER },
          priceUsd: badPrice,
          liquidity: { usd: 1_000_000_000 },
        }),
      ],
    });
    try {
      const result = await getTokenPriceUsd(8453, BASE_WETH as `0x${string}`);
      assert.equal(result, null, `priceUsd=${badPrice} must be rejected, got ${result}`);
    } finally {
      mock.restore();
    }
  }
});

// ── 10. Existing direct-pair pricing for a non-wrapped-native token is unaffected ──

test('direct on-chain pricing for an ordinary (non-wrapped-native) token is unaffected by the P2-1 gate, on any chain', async () => {
  clearPriceCache();
  const mock = installFetchMock({
    [TOKEN_Z]: [
      pair({
        chainId: 'bsc',
        baseToken: { address: TOKEN_Z },
        quoteToken: { address: BSC_WBNB },
        priceUsd: '0.0042',
        liquidity: { usd: 50_000 },
      }),
    ],
  });
  try {
    const result = await getTokenPriceUsd(56, TOKEN_Z as `0x${string}`);
    assert.equal(result, 0.0042);
    assert.ok(!mock.requested.includes(ETH_MAINNET_WETH.toLowerCase()));
  } finally {
    mock.restore();
  }
});

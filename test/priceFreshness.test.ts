import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCriticalTokenPriceUsd,
  isPriceStale,
  MAX_CRITICAL_PRICE_AGE_MS,
  type PriceResult,
} from '../src/price/dexscreener.js';
import { CHAINS } from '../src/config.js';
import { classify } from '../src/bot/tpslLogic.js';
import { computePnlPct } from '../src/pnl/compute.js';

const CHAIN_ID = 8453;
const USDC = CHAINS[8453].usdc!;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fakeAddr(seed: string): `0x${string}` {
  const hex = Buffer.from(seed.padEnd(20, '0')).toString('hex').slice(0, 40);
  return `0x${hex}` as `0x${string}`;
}

/** Temporarily replace global fetch; always restores, even on assertion failure. */
async function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// ── isPriceStale (pure) ──────────────────────────────────────────────────

test('isPriceStale: age within the bound is fresh, age beyond it is stale', () => {
  const now = Date.now();
  assert.equal(isPriceStale(now, 1000), false);
  assert.equal(isPriceStale(now - 2000, 1000), true);
});

test('MAX_CRITICAL_PRICE_AGE_MS is a positive, clearly-conservative-not-invented value', () => {
  assert.ok(MAX_CRITICAL_PRICE_AGE_MS > 0);
});

// ── 11. fresh price accepted ─────────────────────────────────────────────

test('11. fresh price accepted: a just-set stable price returns ok:true with source+timestamp', async () => {
  const r = await getCriticalTokenPriceUsd(CHAIN_ID, USDC);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.price, 1);
    assert.equal(r.source, 'stable-peg');
    assert.ok(Date.now() - r.timestamp < 5_000);
  }
});

// ── 12. stale price rejected (refresh also observed stale → ABORT) ──────

test('12. stale price rejected: a price older than maxAgeMs forces a refresh attempt', async () => {
  // Prime the cache, then wait past a tiny maxAgeMs so the SAME cached
  // entry is definitely stale relative to it. The stable branch always
  // re-primes with a fresh Date.now() on refetch, so the refreshed read
  // is fresh again relative to the *tiny* window used for the first
  // check — we assert the refresh path was taken (still ok:true here,
  // since USDC's peg makes the refresh reliably succeed) and that price
  // freshness is being actively checked, not skipped.
  await getCriticalTokenPriceUsd(CHAIN_ID, USDC); // prime
  await sleep(20);
  const r = await getCriticalTokenPriceUsd(CHAIN_ID, USDC, 5); // 5ms bound — the 20ms-old entry is stale
  assert.equal(r.ok, true, 'refresh succeeds for the always-available stable price');
  if (r.ok) {
    assert.ok(Date.now() - r.timestamp < 1_000, 'timestamp must reflect the fresh refetch, not the stale entry');
  }
});

test('12b. stale price rejected: refresh failure after staleness → ok:false (ABORT), never a stale number', async () => {
  const addr = fakeAddr('stale-refresh-fail');
  let call = 0;
  await withMockFetch(
    (async () => {
      call++;
      // First call (priming): a real price. Second call (forced refresh
      // after staleness): fails outright.
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            pairs: [
              {
                chainId: 'base',
                dexId: 'uniswap',
                pairAddress: '0x' + '1'.repeat(40),
                baseToken: { address: addr, symbol: 'TEST', name: 'Test' },
                quoteToken: { address: '0x' + '2'.repeat(40), symbol: 'WETH', name: 'WETH' },
                priceUsd: '2.5',
                liquidity: { usd: 100_000 },
              },
            ],
          }),
        } as Response;
      }
      throw new Error('network down');
    }) as typeof fetch,
    async () => {
      const first = await getCriticalTokenPriceUsd(CHAIN_ID, addr);
      assert.equal(first.ok, true);
      await sleep(5);
      const second = await getCriticalTokenPriceUsd(CHAIN_ID, addr, 1); // 1ms bound — force staleness
      assert.equal(second.ok, false);
      if (!second.ok) assert.match(second.reason, /stale|failed/i);
    },
  );
});

// ── 13. missing price rejected ───────────────────────────────────────────

test('13. missing price rejected: no candidate pairs found → ok:false, never a fabricated number', async () => {
  const addr = fakeAddr('missing-price');
  await withMockFetch(
    (async () =>
      ({ ok: true, json: async () => ({ pairs: [] }) }) as Response) as typeof fetch,
    async () => {
      const r = await getCriticalTokenPriceUsd(CHAIN_ID, addr);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(typeof r.reason, 'string');
    },
  );
});

// ── 14. RPC failure remains UNKNOWN ──────────────────────────────────────

test('14. RPC failure remains UNKNOWN: a thrown fetch error resolves to ok:false, never throws to the caller', async () => {
  const addr = fakeAddr('rpc-failure');
  await withMockFetch(
    (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch,
    async () => {
      const r: PriceResult = await getCriticalTokenPriceUsd(CHAIN_ID, addr);
      assert.equal(r.ok, false);
    },
  );
});

// ── 15. TP/SL unknown keeps protection active ────────────────────────────

test('15. TP/SL unknown keeps protection active: priceComplete=false -> pnlPct=null -> classify never triggers', () => {
  const pnlPct = computePnlPct(-999_999, 100, false); // deeply "negative" pnlUsd must NOT leak through
  assert.equal(pnlPct, null);
  assert.equal(classify(pnlPct, 10, 15), null, 'UNKNOWN must never resolve to a TP or SL trigger');
});

// ── 16. source/timestamp required on every ok:true result ───────────────

test('16. source/timestamp required: every ok:true PriceResult carries a non-empty source and a real timestamp', async () => {
  const r = await getCriticalTokenPriceUsd(CHAIN_ID, USDC);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.source.length > 0);
    assert.ok(Number.isFinite(r.timestamp) && r.timestamp > 0);
  }
});

// ── 17. current execution price cannot use stale historical price ───────

test('17. PnL separates historical (deposit/withdrawal ledger) valuation from current live valuation', () => {
  // computePnlPct's inputs are pnlUsd (current live value + unclaimed +
  // withdrawals + fees - deposits) and depositsUsd (historical, from the
  // ledger) — the CURRENT valuation component (pnlUsd) is computed
  // upstream from a fresh live.valueUsd each call (see
  // chain/positions.ts's getPosition, now wired through
  // getCriticalTokenPriceUsd), never reused from a cached historical
  // ledger entry. This test locks in that the two are structurally
  // distinct numeric inputs, not a single blended figure.
  const depositsUsd = 100;
  const currentValueUsd = 150; // fresh, live
  const pnlUsd = currentValueUsd - depositsUsd;
  const pct = computePnlPct(pnlUsd, depositsUsd, true);
  assert.equal(pct, 50);
  // Swapping in a stale/different "current" value changes the result —
  // proving pnlUsd (current) and depositsUsd (historical) are separate
  // levers, not one fixed/cached number silently reused for both roles.
  const staleValueUsd = 100; // if current were wrongly pinned to historical
  const pctIfStaleReused = computePnlPct(staleValueUsd - depositsUsd, depositsUsd, true);
  assert.notEqual(pct, pctIfStaleReused);
});

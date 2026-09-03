/**
 * Phase 4.7 — zero-trust audit finding 4.1 (Part F, pool discovery).
 *
 * Root cause (src/strategy/multiPool.ts's discoverAndScorePoolsForCandidate,
 * before this fix):
 *   try {
 *     listed = await fetcher(config.chainId, candidate.address, 0);
 *   } catch {
 *     return { pools: [], selected: null, rejected: [] };  // identical shape
 *   }                                                        // to "found none"
 *
 * multiExecute.ts's caller then recorded EVERY `!selected` outcome as the
 * candidate-quality verdict 'NO_VALID_POOL' — indistinguishable whether the
 * token genuinely has no qualifying pool, or an RPC/DexScreener outage made
 * it impossible to even check. An infrastructure failure could render as
 * "today's memecoins just didn't have good pools" with no error surfaced
 * anywhere.
 *
 * This suite proves a thrown pool-fetch error now produces a distinct
 * 'POOL_FETCH_ERROR' rejection reason instead of the generic
 * 'NO_VALID_POOL', while a genuinely-empty (successful, zero-pool) fetch
 * still correctly reports 'NO_VALID_POOL'.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multiexec-poolfetcherr-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { __resetStoreForTests } = await import('../src/db/index.js');
const { runMultiStrategy } = await import('../src/strategy/multiExecute.js');
const { __resetMultiCooldownForTests } = await import('../src/strategy/multiRisk.js');

function resetDb(): void {
  __resetStoreForTests();
  for (const suffix of ['', '.bak', '.tmp']) {
    try {
      fs.rmSync(`${process.env.DB_PATH!}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

const CHAIN = 4663;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chainId: CHAIN,
    interval: '6h' as const,
    minMarketCapUsd: 1_000_000,
    minTokenAgeHours: 24,
    topN: 10,
    rangePercent: 50,
    positionSizeUsd: 100,
    usdgAddress: USDG,
    poolTvlWeight: 0.3,
    poolVolumeWeight: 0.3,
    poolVolumeTvlWeight: 0.25,
    poolFeeWeight: 0.15,
    maxOpenPositions: 3,
    maxPositionsPerToken: 1,
    maxExposureUsd: 500,
    entryCooldownMs: 300_000,
    tpPercent: 10,
    slPercent: 15,
    ...overrides,
  };
}

function freshToken(): string {
  return `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}`;
}

function trendingFetcherFor(token: string) {
  return async () => [
    {
      address: token,
      symbol: 'TOK',
      name: 'Token',
      price: 1,
      volume: 500_000,
      liquidity: 200_000,
      market_cap: 2_000_000,
      holder_count: 1000,
      renowned_count: 0,
      gas_fee: 0,
      launchpad_platform: 'pump.fun',
    },
  ];
}

function infoFetcherFor(token: string) {
  return async () => ({
    address: token,
    symbol: 'TOK',
    name: 'Token',
    decimals: 18,
    holder_count: 1000,
    total_supply: '0',
    circulating_supply: '0',
    liquidity: '0',
    total_fee: '0',
    trade_fee: '0',
    biggest_pool_address: '0x0',
    creation_timestamp: Math.floor((Date.now() - 48 * 3_600_000) / 1000),
    open_timestamp: Math.floor((Date.now() - 48 * 3_600_000) / 1000),
    launchpad: 'pump.fun',
    price: {
      price: '1',
      price_1h: '0',
      price_24h: '0',
      buys_24h: 0,
      sells_24h: 0,
      swaps_24h: 0,
      volume_1h: '0',
      volume_24h: '0',
    },
  });
}

test('4.1 fix: a thrown pool-fetch error is rejected as POOL_FETCH_ERROR, not the generic NO_VALID_POOL', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const token = freshToken();
  const cfg = baseConfig();

  const run = await runMultiStrategy(cfg as never, {
    dryRun: true,
    now: Date.now(),
    fetcher: trendingFetcherFor(token) as never,
    infoFetcher: infoFetcherFor(token) as never,
    poolFetcher: async () => {
      throw new Error('simulated RPC outage during pool discovery');
    },
    mintFn: async () => {
      throw new Error('mintFn must never be reached when pool discovery fails');
    },
  });

  assert.equal(run.executed.length, 0);
  const rejection = run.rejected.find((r) => r.address.toLowerCase() === token.toLowerCase());
  assert.ok(rejection, 'the candidate must appear in rejected');
  assert.equal(
    rejection!.rejectedReason,
    'POOL_FETCH_ERROR',
    'a pool-fetch infrastructure failure must be distinguishable from a genuine no-pool verdict (NO_VALID_POOL)',
  );
});

test('sanity: a genuinely-empty (successful) pool fetch still reports NO_VALID_POOL, not POOL_FETCH_ERROR', async () => {
  resetDb();
  __resetMultiCooldownForTests();
  const token = freshToken();
  const cfg = baseConfig();

  const run = await runMultiStrategy(cfg as never, {
    dryRun: true,
    now: Date.now(),
    fetcher: trendingFetcherFor(token) as never,
    infoFetcher: infoFetcherFor(token) as never,
    poolFetcher: async () => [], // genuinely no pools, no error
    mintFn: async () => {
      throw new Error('mintFn must never be reached when there is no valid pool');
    },
  });

  assert.equal(run.executed.length, 0);
  const rejection = run.rejected.find((r) => r.address.toLowerCase() === token.toLowerCase());
  assert.ok(rejection);
  assert.equal(rejection!.rejectedReason, 'NO_VALID_POOL');
});

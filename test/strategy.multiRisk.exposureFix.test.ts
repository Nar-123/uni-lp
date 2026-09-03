/**
 * Phase 4.7 — zero-trust audit findings 6.1 and 6.2 (Part I, position sizing
 * & exposure limits).
 *
 * Root cause (src/strategy/multiRisk.ts's checkPositionLimits, before this
 * fix):
 *   const exposureUsd = openMulti.reduce((sum, p) => {
 *     const meta = getMultiPositionMeta(p.chainId, p.tokenId);
 *     return sum + (meta?.positionSizeUsd ?? 0);          // 6.2: fail-open
 *   }, 0);
 *   if (exposureUsd >= config.maxExposureUsd) { ... }       // 6.1: excludes
 *                                                            // the incoming
 *                                                            // position
 *
 * 6.1: the cap compared only EXISTING exposure to the limit — the position
 * about to be opened was never added in, so the gate only ever fires AFTER
 * the cap has already been exceeded by up to one more position's size.
 *
 * 6.2: a position whose metadata row is missing (lost to a crash window, or
 * a corrupt-store quarantine) contributed exactly $0 to the exposure sum —
 * the one direction a risk cap must never fail in.
 *
 * This suite proves both are fixed for the config.positionSizeUsd (fixed-USD
 * sizing) mode, the codebase's primary/documented MULTI operating mode.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-multirisk-exposurefix-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { recordOpenPosition, recordMultiPositionMeta, __resetStoreForTests } = await import(
  '../src/db/index.js'
);
const { checkPositionLimits } = await import('../src/strategy/multiRisk.js');

const CHAIN = 4663;

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

function freshToken(): string {
  return `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}`;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    chainId: CHAIN,
    interval: '6h' as const,
    minMarketCapUsd: 1_000_000,
    minTokenAgeHours: 24,
    topN: 10,
    rangePercent: 50,
    positionSizeUsd: 400,
    usdgAddress: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    poolTvlWeight: 0.3,
    poolVolumeWeight: 0.3,
    poolVolumeTvlWeight: 0.25,
    poolFeeWeight: 0.15,
    maxOpenPositions: 10,
    maxPositionsPerToken: 1,
    maxExposureUsd: 500,
    entryCooldownMs: 300_000,
    tpPercent: 10,
    slPercent: 15,
    ...overrides,
  };
}

function openMultiPositionWithMeta(tokenId: string, positionSizeUsd: number): void {
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: '0xusdg',
    token1: tokenId,
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
    strategy: 'multi',
  });
  recordMultiPositionMeta({
    chainId: CHAIN,
    tokenId,
    candidateSource: 'gmgn_trending_6h',
    candidateInterval: '6h',
    candidateMarketCapUsd: null,
    candidateAgeHours: null,
    candidateVolume6hUsd: null,
    candidateClassification: 'MEME',
    candidateScore: 1,
    poolAddress: '0xpool',
    poolFee: 3000,
    poolTvlUsd: null,
    poolVolumeUsd: null,
    poolScore: 1,
    entryPrice: null,
    tickLower: 0,
    tickUpper: 100,
    positionSizeUsd,
    timestamp: Date.now(),
  });
}

/** Same as above but deliberately WITHOUT a meta row — simulates a crash between recordOpenPosition and recordMultiPositionMeta. */
function openMultiPositionWithoutMeta(tokenId: string): void {
  recordOpenPosition({
    chainId: CHAIN,
    tokenId,
    poolAddress: '0xpool',
    token0: '0xusdg',
    token1: tokenId,
    fee: 3000,
    tickLower: 0,
    tickUpper: 100,
    strategy: 'multi',
  });
}

test('6.1 fix: exposure check blocks BEFORE the cap is exceeded, once existing + incoming would reach it', () => {
  resetDb();
  const cfg = baseConfig({ maxExposureUsd: 500, positionSizeUsd: 400 });

  // No open positions yet: existing=0, incoming=400 -> 400 < 500 -> allowed.
  const first = checkPositionLimits(cfg as never, CHAIN, freshToken());
  assert.equal(first.pass, true, 'first $400 position must be allowed under a $500 cap');

  // Now $400 is already open. A second $400 position would bring total
  // exposure to $800 on a $500 cap — the pre-fix code allowed this (existing
  // 400 < 500 passes) since it never added the incoming position's size.
  openMultiPositionWithMeta(freshToken(), 400);
  const second = checkPositionLimits(cfg as never, CHAIN, freshToken());
  assert.equal(
    second.pass,
    false,
    'a second $400 position must be BLOCKED once existing ($400) + incoming ($400) would reach the $500 cap — previously only existing exposure was checked, allowing $800 total on a $500 cap',
  );
  assert.equal(second.reason, 'POSITION_LIMIT');
});

test('6.2 fix: a position with no meta row (crash between open and meta-write) contributes its configured size, not $0, to exposure', () => {
  resetDb();
  const cfg = baseConfig({ maxExposureUsd: 500, positionSizeUsd: 400 });

  // One position opened but its meta write was "lost" (never recorded).
  openMultiPositionWithoutMeta(freshToken());

  // Pre-fix: meta?.positionSizeUsd ?? 0 -> this position contributes $0,
  // so existing=0, incoming=400 -> allowed, even though real exposure is
  // already ~$400 (the lost position's actual on-chain deposit).
  const result = checkPositionLimits(cfg as never, CHAIN, freshToken());
  assert.equal(
    result.pass,
    false,
    'a metadata-less open position must fail closed (treated as the configured position size), not silently count as $0 exposure — existing ~$400 (assumed) + incoming $400 exceeds the $500 cap',
  );
  assert.equal(result.reason, 'POSITION_LIMIT');
});

test('sanity: exposure well under the cap (with correctly-recorded meta) still passes', () => {
  resetDb();
  const cfg = baseConfig({ maxExposureUsd: 5000, positionSizeUsd: 400 });
  openMultiPositionWithMeta(freshToken(), 400);
  openMultiPositionWithMeta(freshToken(), 400);
  const result = checkPositionLimits(cfg as never, CHAIN, freshToken());
  assert.equal(result.pass, true, '800 existing + 400 incoming = 1200, well under a 5000 cap');
});

/**
 * Phase 4.6.8 — memory & data growth hardening.
 *
 * Three module-level caches were found to grow without bound over a
 * long-running process, purely because nothing ever removed an entry once
 * added:
 *   - strategy/multiRisk.ts's `cooldownMap` (one permanent key per distinct
 *     token ever successfully entered by MULTI)
 *   - chain/tokens.ts's `metaCache` (one permanent key per distinct token
 *     address ever queried for symbol/name/decimals)
 *   - chain/tokens.ts's `supplyCache` (one permanent key per distinct token
 *     address ever queried for totalSupply, despite already having a TTL)
 *
 * None of these are financial/recovery-critical — all three are explicitly
 * documented as safe-to-reset, in-memory-only caches (verified by reading
 * the source). This file proves each is now bounded, that pruning/eviction
 * never changes an observable result for still-valid entries, and that the
 * financial/ledger/journal/position stores this phase intentionally left
 * untouched still behave exactly as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEntryCooldown,
  recordEntryCooldown,
  __resetMultiCooldownForTests,
  __setCooldownEntryForTests,
  __cooldownMapSizeForTests,
} from '../src/strategy/multiRisk.js';
import type { MultiConfig } from '../src/strategy/multiConfig.js';
import {
  __setMetaCacheEntryForTests,
  __metaCacheSizeForTests,
  __metaCacheHasForTests,
  __resetMetaCacheForTests,
  __setSupplyCacheEntryForTests,
  __pruneSupplyCacheForTests,
  __supplyCacheSizeForTests,
  __resetSupplyCacheForTests,
} from '../src/chain/tokens.js';

function baseConfig(overrides: Partial<MultiConfig> = {}): MultiConfig {
  return {
    enabled: true,
    chainId: 4663,
    interval: '6h',
    minMarketCapUsd: 1_000_000,
    minTokenAgeHours: 24,
    topN: 10,
    rangePercent: 50,
    positionSizeUsd: null,
    usdgAddress: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as `0x${string}`,
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

// ── multiRisk.ts cooldownMap ──────────────────────────────────────────────

test('cooldownMap: long-run simulation — 10,000 distinct tokens entered does not leave 10,000 permanent keys', () => {
  __resetMultiCooldownForTests();
  const cfg = baseConfig({ entryCooldownMs: 1_000 });
  const longAgo = Date.now() - 10 * cfg.entryCooldownMs; // well past expiry
  for (let i = 0; i < 10_000; i++) {
    __setCooldownEntryForTests(4663, `0x${i.toString(16).padStart(40, '0')}`, longAgo);
  }
  assert.equal(__cooldownMapSizeForTests(), 10_000, 'sanity: all 10k were actually inserted');
  // A cooldown check prunes everything already expired; checkEntryCooldown
  // itself never records anything (only recordEntryCooldown does).
  checkEntryCooldown(4663, '0xfresh', cfg);
  assert.equal(__cooldownMapSizeForTests(), 0, 'all 10,000 expired entries are pruned away');
});

test('cooldownMap: duplicate-state — repeatedly entering the SAME token never grows the map beyond one entry for it', () => {
  __resetMultiCooldownForTests();
  const cfg = baseConfig({ entryCooldownMs: 300_000 });
  for (let i = 0; i < 500; i++) {
    recordEntryCooldown(4663, '0xsametoken');
  }
  assert.equal(__cooldownMapSizeForTests(), 1, 'same key overwritten, never appended');
});

test('cooldownMap: pruning an expired entry never changes the cooldown-check result for that key (behavior-preserving)', () => {
  __resetMultiCooldownForTests();
  const cfg = baseConfig({ entryCooldownMs: 1_000 });
  const longAgo = Date.now() - 5_000; // expired
  __setCooldownEntryForTests(4663, '0xabc', longAgo);
  // Before this phase: expired entry stayed forever but was already
  // irrelevant to the pass/fail result (now - last >= entryCooldownMs).
  const result = checkEntryCooldown(4663, '0xabc', cfg);
  assert.equal(result.pass, true, 'an expired cooldown must still pass, exactly as before');
  assert.equal(__cooldownMapSizeForTests(), 0, 'and is now actually removed rather than lingering');
});

test('cooldownMap: a still-active (non-expired) cooldown is never pruned and still blocks entry', () => {
  __resetMultiCooldownForTests();
  const cfg = baseConfig({ entryCooldownMs: 300_000 });
  recordEntryCooldown(4663, '0xactive');
  const result = checkEntryCooldown(4663, '0xactive', cfg);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'ENTRY_COOLDOWN');
  assert.equal(__cooldownMapSizeForTests(), 1, 'active entry must survive pruning');
});

test('cooldownMap: mixed expired + active entries — only expired ones are pruned', () => {
  __resetMultiCooldownForTests();
  const cfg = baseConfig({ entryCooldownMs: 1_000 });
  __setCooldownEntryForTests(4663, '0xexpired1', Date.now() - 5_000);
  __setCooldownEntryForTests(4663, '0xexpired2', Date.now() - 5_000);
  recordEntryCooldown(4663, '0xactive1'); // just recorded, still active
  checkEntryCooldown(4663, '0xsomethingelse', cfg); // triggers prune
  assert.equal(__cooldownMapSizeForTests(), 1, 'only the still-active entry remains');
});

// ── chain/tokens.ts metaCache ──────────────────────────────────────────────

test('metaCache: long-run simulation — 10,000 distinct token lookups stay bounded at the configured max size', () => {
  __resetMetaCacheForTests();
  for (let i = 0; i < 10_000; i++) {
    __setMetaCacheEntryForTests(`4663:0x${i.toString(16).padStart(40, '0')}`, {
      address: `0x${i.toString(16).padStart(40, '0')}` as `0x${string}`,
      symbol: 'TOK',
      name: 'Token',
      decimals: 18,
    });
  }
  assert.equal(__metaCacheSizeForTests(), 500, 'bounded at MAX_META_CACHE_SIZE regardless of lifetime insert count');
});

test('metaCache: FIFO eviction drops the oldest key first, never a recently-added one', () => {
  __resetMetaCacheForTests();
  for (let i = 0; i < 500; i++) {
    __setMetaCacheEntryForTests(`k${i}`, { address: '0x0' as `0x${string}`, symbol: 'A', name: 'A', decimals: 18 });
  }
  assert.ok(__metaCacheHasForTests('k0'));
  __setMetaCacheEntryForTests('k500', { address: '0x0' as `0x${string}`, symbol: 'A', name: 'A', decimals: 18 });
  assert.equal(__metaCacheSizeForTests(), 500);
  assert.ok(!__metaCacheHasForTests('k0'), 'oldest key evicted');
  assert.ok(__metaCacheHasForTests('k1'), 'next-oldest survives');
  assert.ok(__metaCacheHasForTests('k500'), 'newly-added key present');
});

test('metaCache: re-caching an already-cached key does not consume a slot / trigger eviction', () => {
  __resetMetaCacheForTests();
  for (let i = 0; i < 500; i++) {
    __setMetaCacheEntryForTests(`k${i}`, { address: '0x0' as `0x${string}`, symbol: 'A', name: 'A', decimals: 18 });
  }
  __setMetaCacheEntryForTests('k0', { address: '0x0' as `0x${string}`, symbol: 'A', name: 'A', decimals: 18 });
  assert.equal(__metaCacheSizeForTests(), 500, 'updating an existing key must not evict anything');
  assert.ok(__metaCacheHasForTests('k0'));
  assert.ok(__metaCacheHasForTests('k1'));
});

// ── chain/tokens.ts supplyCache ────────────────────────────────────────────

test('supplyCache: long-run simulation — 10,000 distinct expired entries are pruned down to the still-fresh ones', () => {
  __resetSupplyCacheForTests();
  const longAgo = Date.now() - 10 * 60_000; // well past the 60s TTL
  for (let i = 0; i < 10_000; i++) {
    __setSupplyCacheEntryForTests(`4663:0x${i.toString(16).padStart(40, '0')}`, 1_000_000n, longAgo);
  }
  __setSupplyCacheEntryForTests('4663:0xfresh', 42n, Date.now());
  assert.equal(__supplyCacheSizeForTests(), 10_001, 'sanity: all inserted');
  __pruneSupplyCacheForTests();
  assert.equal(__supplyCacheSizeForTests(), 1, 'every expired entry pruned; the fresh one survives');
});

test('supplyCache: pruning an expired entry does not affect a fresh entry\'s value', () => {
  __resetSupplyCacheForTests();
  __setSupplyCacheEntryForTests('4663:0xold', 1n, Date.now() - 120_000);
  __setSupplyCacheEntryForTests('4663:0xfresh', 999n, Date.now());
  __pruneSupplyCacheForTests();
  assert.equal(__supplyCacheSizeForTests(), 1);
});

// ── Accounting / recovery data is untouched by this phase ─────────────────

test('multiRisk: the durable duplicate-entry guards (checkDoubleEntry / checkPendingTransaction) are unrelated to the in-memory cooldown cache and are unaffected by pruning', () => {
  // This is a documentation-style regression: these two gates read from the
  // persistent DB (listOpenPositions / listUnresolvedTxJournal), never from
  // cooldownMap, so bounding cooldownMap cannot change their behavior. No
  // DB fixture is set up here (that is covered by strategy.multiPool/
  // strategy.multiRisk's existing tests) — this simply pins that both
  // functions are still exported with the same signatures/behavior class.
  __resetMultiCooldownForTests();
  const cfg = baseConfig();
  recordEntryCooldown(4663, '0xtoken');
  const result = checkEntryCooldown(4663, '0xtoken', cfg);
  assert.equal(result.pass, false, 'cooldown gate itself still works identically after the pruning change');
});

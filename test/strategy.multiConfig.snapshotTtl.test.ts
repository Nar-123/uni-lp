/**
 * Phase 4.7 audit (F-10) — MULTI_SNAPSHOT_TTL_MS config wiring: finite,
 * positive, validated, deterministic, never silently infinite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { loadMultiConfig, validateMultiConfig } = await import('../src/strategy/multiConfig.js');

const CHAIN = 4663;

function clearEnv(): void {
  delete process.env.MULTI_SNAPSHOT_TTL_MS;
}

test('MULTI_SNAPSHOT_TTL_MS defaults to 600000 (10 minutes) when unset', () => {
  clearEnv();
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.snapshotTtlMs, 600_000);
  assert.equal(cfg.enabled, true);
});

test('a valid positive MULTI_SNAPSHOT_TTL_MS override is honored', () => {
  process.env.MULTI_SNAPSHOT_TTL_MS = '300000';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.snapshotTtlMs, 300_000);
  } finally {
    clearEnv();
  }
});

test('a malformed (non-numeric) MULTI_SNAPSHOT_TTL_MS falls back to the default, never NaN', () => {
  process.env.MULTI_SNAPSHOT_TTL_MS = 'not-a-number';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.snapshotTtlMs, 600_000);
    assert.equal(Number.isFinite(cfg.snapshotTtlMs), true);
  } finally {
    clearEnv();
  }
});

test('an Infinity-valued MULTI_SNAPSHOT_TTL_MS is impossible via envNum\'s finiteness guard — falls back to the default, never effectively infinite', () => {
  process.env.MULTI_SNAPSHOT_TTL_MS = '1e400';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.snapshotTtlMs, 600_000);
  } finally {
    clearEnv();
  }
});

test('a zero MULTI_SNAPSHOT_TTL_MS fails validateMultiConfig — MULTI disabled rather than an effectively-always-expired or effectively-never-expiring snapshot', () => {
  process.env.MULTI_SNAPSHOT_TTL_MS = '0';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.enabled, false);
    assert.match(cfg.disabledReason ?? '', /MULTI_SNAPSHOT_TTL_MS/);
    const v = validateMultiConfig(cfg);
    assert.equal(v.valid, false);
  } finally {
    clearEnv();
  }
});

test('a negative MULTI_SNAPSHOT_TTL_MS fails validateMultiConfig', () => {
  process.env.MULTI_SNAPSHOT_TTL_MS = '-100';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.enabled, false);
  } finally {
    clearEnv();
  }
});

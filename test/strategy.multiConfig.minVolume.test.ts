/**
 * Phase 4.7 audit (F-07) — MULTI_MIN_CANDIDATE_VOLUME_USD config wiring.
 *
 * The always-on "volume must be strictly positive" rule lives in
 * multiCandidates.ts and is not configurable (see
 * strategy.multiCandidates.test.ts). This suite only covers the SEPARATE,
 * optional, operator-controlled floor: env parsing, validation, and the
 * documented "0 = disabled" default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { loadMultiConfig, validateMultiConfig } = await import('../src/strategy/multiConfig.js');

const CHAIN = 4663;

function clearEnv(): void {
  delete process.env.MULTI_MIN_CANDIDATE_VOLUME_USD;
}

test('MULTI_MIN_CANDIDATE_VOLUME_USD defaults to 0 (disabled) when unset', () => {
  clearEnv();
  const cfg = loadMultiConfig(CHAIN);
  assert.equal(cfg.minCandidateVolumeUsd, 0);
  assert.equal(cfg.enabled, true);
});

test('a valid positive MULTI_MIN_CANDIDATE_VOLUME_USD is honored', () => {
  process.env.MULTI_MIN_CANDIDATE_VOLUME_USD = '25000';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.minCandidateVolumeUsd, 25_000);
  } finally {
    clearEnv();
  }
});

test('a malformed (non-numeric) MULTI_MIN_CANDIDATE_VOLUME_USD falls back to the 0 default, never NaN', () => {
  process.env.MULTI_MIN_CANDIDATE_VOLUME_USD = 'not-a-number';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.minCandidateVolumeUsd, 0);
    assert.equal(Number.isFinite(cfg.minCandidateVolumeUsd), true);
  } finally {
    clearEnv();
  }
});

test('a negative MULTI_MIN_CANDIDATE_VOLUME_USD fails validateMultiConfig — MULTI disabled rather than silently trading with an invalid floor', () => {
  process.env.MULTI_MIN_CANDIDATE_VOLUME_USD = '-100';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.enabled, false);
    assert.match(cfg.disabledReason ?? '', /MULTI_MIN_CANDIDATE_VOLUME_USD/);
    const v = validateMultiConfig(cfg);
    assert.equal(v.valid, false);
  } finally {
    clearEnv();
  }
});

test('MULTI_MIN_CANDIDATE_VOLUME_USD=0 explicitly is valid (equivalent to unset/disabled)', () => {
  process.env.MULTI_MIN_CANDIDATE_VOLUME_USD = '0';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.minCandidateVolumeUsd, 0);
    assert.equal(cfg.enabled, true);
  } finally {
    clearEnv();
  }
});

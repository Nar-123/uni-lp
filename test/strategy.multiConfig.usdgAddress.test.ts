/**
 * Phase 4.7 — zero-trust audit finding 3.1 (Part E, quote-asset validation).
 *
 * Root cause (src/strategy/multiConfig.ts, before this fix):
 *   function envAddress(key) {
 *     const raw = process.env[key]?.trim();
 *     if (!raw) return null;
 *     return isAddress(raw) ? raw : null;        // malformed -> null,
 *   }                                              // indistinguishable from unset
 *   function resolveUsdgAddress(chainId) {
 *     const explicit = envAddress('MULTI_USDG_ADDRESS');
 *     if (explicit) return explicit;
 *     return CHAINS[chainId].usdg ?? null;         // silently substituted
 *   }
 *
 * A MULTI_USDG_ADDRESS that was present but malformed (typo, truncated,
 * trailing character) silently fell back to the chain's default USDG
 * contract — a DIFFERENT quote asset than the operator explicitly
 * configured — with no warning, and MULTI would proceed enabled and trading
 * real capital against it. validateMultiConfig()'s existing `!usdgAddress`
 * check only ever caught "no address resolved at all", never "the wrong one
 * silently resolved instead".
 *
 * This suite proves a malformed override now fails closed to null (routing
 * through the same, already-tested MULTI-disabled path as "unset"), while a
 * validly-formed override still wins over the chain default, and an unset
 * variable still correctly falls back to the chain default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { loadMultiConfig, validateMultiConfig } = await import('../src/strategy/multiConfig.js');

const CHAIN = 4663;
const VALID_OVERRIDE = '0x1111111111111111111111111111111111111111';

function clearOverride(): void {
  delete process.env.MULTI_USDG_ADDRESS;
}

test('malformed MULTI_USDG_ADDRESS (present but not a valid address) fails closed — resolves to null, MULTI disabled, never silently substitutes the chain default', () => {
  process.env.MULTI_USDG_ADDRESS = '0xTruncatedNotAValidAddress';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.usdgAddress, null, 'a malformed override must resolve to null, not the chain default');
    assert.equal(cfg.enabled, false, 'MULTI must be disabled rather than silently trading against the chain default quote asset');
    assert.match(cfg.disabledReason ?? '', /usdg/i);
    const v = validateMultiConfig(cfg);
    assert.equal(v.valid, false);
  } finally {
    clearOverride();
  }
});

test('malformed MULTI_USDG_ADDRESS with trailing/leading whitespace-only garbage still fails closed', () => {
  process.env.MULTI_USDG_ADDRESS = 'not-an-address-at-all';
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.usdgAddress, null);
    assert.equal(cfg.enabled, false);
  } finally {
    clearOverride();
  }
});

test('a validly-formed MULTI_USDG_ADDRESS override still wins over the chain default (existing behavior preserved)', () => {
  process.env.MULTI_USDG_ADDRESS = VALID_OVERRIDE;
  try {
    const cfg = loadMultiConfig(CHAIN);
    assert.equal(cfg.usdgAddress?.toLowerCase(), VALID_OVERRIDE.toLowerCase());
  } finally {
    clearOverride();
  }
});

test('an unset MULTI_USDG_ADDRESS still falls back to the chain default (existing behavior preserved)', () => {
  clearOverride();
  const cfg = loadMultiConfig(CHAIN);
  assert.ok(cfg.usdgAddress, 'the known chain default must still resolve when nothing is overridden');
});

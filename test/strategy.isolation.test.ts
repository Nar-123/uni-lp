/**
 * STRATEGY env isolation — Phase 4 spec §9.
 *
 * getActiveStrategyName() is the single switch bot.ts uses to gate the
 * /multi command family; this only tests the switch itself (fast,
 * no db/network setup needed). The gating call sites are verified by
 * reading src/bot/bot.ts (grep for getActiveStrategyName usage ahead of
 * each multi:* handler) rather than re-instantiating the whole bot here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';

const { getActiveStrategyName } = await import('../src/strategy/multiConfig.js');

test('STRATEGY unset defaults to "default" (existing behavior unaffected)', () => {
  delete process.env.STRATEGY;
  assert.equal(getActiveStrategyName(), 'default');
});

test('STRATEGY=multi activates the multi strategy name', () => {
  process.env.STRATEGY = 'multi';
  assert.equal(getActiveStrategyName(), 'multi');
  delete process.env.STRATEGY;
});

test('STRATEGY is case-insensitive and trims whitespace', () => {
  process.env.STRATEGY = '  MULTI  ';
  assert.equal(getActiveStrategyName(), 'multi');
  delete process.env.STRATEGY;
});

test('any other STRATEGY value falls back to "default", never partially activating multi', () => {
  process.env.STRATEGY = 'degen';
  assert.equal(getActiveStrategyName(), 'default');
  delete process.env.STRATEGY;
});

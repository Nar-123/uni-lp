/**
 * Phase 4.7 audit (F-10 follow-up — execution TOCTOU) — the per-token
 * in-flight execution lock. Distinct from chain/txLock.ts: this REJECTS a
 * second concurrent attempt, it never queues one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executionLockKey,
  globalReservationKey,
  tryAcquireExecutionLock,
  releaseExecutionLock,
  __resetExecutionLocksForTests,
  __executionLockSizeForTests,
} from '../src/strategy/executionLock.js';

test('a fresh key can always be acquired', () => {
  __resetExecutionLocksForTests();
  assert.equal(tryAcquireExecutionLock('k1'), true);
});

test('a second acquire of the same key while held fails', () => {
  __resetExecutionLocksForTests();
  assert.equal(tryAcquireExecutionLock('k1'), true);
  assert.equal(tryAcquireExecutionLock('k1'), false);
});

test('after release, the same key can be acquired again', () => {
  __resetExecutionLocksForTests();
  assert.equal(tryAcquireExecutionLock('k1'), true);
  releaseExecutionLock('k1');
  assert.equal(tryAcquireExecutionLock('k1'), true);
});

test('different keys never block each other', () => {
  __resetExecutionLocksForTests();
  assert.equal(tryAcquireExecutionLock('k1'), true);
  assert.equal(tryAcquireExecutionLock('k2'), true);
  assert.equal(__executionLockSizeForTests(), 2);
});

test('releasing a key that was never held is a safe no-op', () => {
  __resetExecutionLocksForTests();
  assert.doesNotThrow(() => releaseExecutionLock('never-held'));
  assert.equal(__executionLockSizeForTests(), 0);
});

test('releasing twice is a safe no-op (no negative/leaked state)', () => {
  __resetExecutionLocksForTests();
  tryAcquireExecutionLock('k1');
  releaseExecutionLock('k1');
  assert.doesNotThrow(() => releaseExecutionLock('k1'));
  assert.equal(__executionLockSizeForTests(), 0);
});

test('executionLockKey is deterministic and case-insensitive on wallet/token', () => {
  const a = executionLockKey(4663, '0xAbCd000000000000000000000000000000000A', '0xEf12000000000000000000000000000000000B');
  const b = executionLockKey(4663, '0xabcd000000000000000000000000000000000a', '0xef12000000000000000000000000000000000b');
  assert.equal(a, b);
});

test('executionLockKey differs across chain, wallet, or token', () => {
  const base = executionLockKey(4663, '0xwallet', '0xtoken');
  assert.notEqual(base, executionLockKey(56, '0xwallet', '0xtoken'));
  assert.notEqual(base, executionLockKey(4663, '0xother', '0xtoken'));
  assert.notEqual(base, executionLockKey(4663, '0xwallet', '0xother'));
});

test('a different token for the same chain+wallet is a distinct key and does not block', () => {
  __resetExecutionLocksForTests();
  const keyX = executionLockKey(4663, '0xwallet', '0xtokenX');
  const keyY = executionLockKey(4663, '0xwallet', '0xtokenY');
  assert.equal(tryAcquireExecutionLock(keyX), true);
  assert.equal(tryAcquireExecutionLock(keyY), true, 'a different token must never be blocked by another token\'s in-flight lock');
});

test('no lock leaks across many acquire/release cycles', () => {
  __resetExecutionLocksForTests();
  for (let i = 0; i < 50; i++) {
    tryAcquireExecutionLock('cycling-key');
    releaseExecutionLock('cycling-key');
  }
  assert.equal(__executionLockSizeForTests(), 0);
});

// ── F-11: globalReservationKey ────────────────────────────────────────────

test('globalReservationKey is deterministic and case-insensitive on wallet', () => {
  const a = globalReservationKey(4663, '0xAbCd000000000000000000000000000000000A');
  const b = globalReservationKey(4663, '0xabcd000000000000000000000000000000000a');
  assert.equal(a, b);
});

test('11. globalReservationKey differs across chains for the same wallet — a chain-4663 reservation never blocks a chain-56 execution', () => {
  const key4663 = globalReservationKey(4663, '0xwallet');
  const key56 = globalReservationKey(56, '0xwallet');
  assert.notEqual(key4663, key56);

  __resetExecutionLocksForTests();
  assert.equal(tryAcquireExecutionLock(key4663), true);
  assert.equal(tryAcquireExecutionLock(key56), true, 'a different chain must never be blocked by another chain\'s global reservation');
});

test('12. globalReservationKey differs across wallets for the same chain — two distinct wallets never contend for the same reservation', () => {
  const keyWalletA = globalReservationKey(4663, '0xwalletA');
  const keyWalletB = globalReservationKey(4663, '0xwalletB');
  assert.notEqual(keyWalletA, keyWalletB);

  __resetExecutionLocksForTests();
  assert.equal(tryAcquireExecutionLock(keyWalletA), true);
  assert.equal(tryAcquireExecutionLock(keyWalletB), true, 'a different wallet must never be blocked by another wallet\'s global reservation');
});

test('globalReservationKey can never collide with a real per-token executionLockKey — the sentinel is not a valid 0x-address shape', () => {
  const global = globalReservationKey(4663, '0xwallet');
  // Real tokens are always validated as 0x + 40 hex elsewhere
  // (bot/multiExecuteResolver.ts's callback regex) — the sentinel is
  // neither that shape nor a value any real token address could ever equal.
  assert.ok(!/^0x[a-fA-F0-9]{40}$/i.test(global.split(':').pop()!));
});

test('the global reservation and a per-token lock for the SAME token+wallet+chain are independent keys and can both be held simultaneously (as the wrapper does)', () => {
  __resetExecutionLocksForTests();
  const tokenKey = executionLockKey(4663, '0xwallet', '0xtoken');
  const globalKey = globalReservationKey(4663, '0xwallet');
  assert.notEqual(tokenKey, globalKey);
  assert.equal(tryAcquireExecutionLock(tokenKey), true);
  assert.equal(tryAcquireExecutionLock(globalKey), true);
  assert.equal(__executionLockSizeForTests(), 2);
});

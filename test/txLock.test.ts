import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTxLock } from '../src/chain/txLock.js';

// Nonce-safety: two sends for the SAME (chain, wallet) key must never be
// in flight at the same time — this is what prevents two concurrent
// TP/SL closes (or a manual command racing the watcher) from both reading
// the same "pending" nonce from the RPC node.

test('same key: second task only starts after the first settles (serialized)', async () => {
  const events: string[] = [];
  const key = 'chain-1:wallet-a';

  const first = withTxLock(key, async () => {
    events.push('first:start');
    await new Promise((r) => setTimeout(r, 30));
    events.push('first:end');
    return 'first';
  });

  // Give the first task a tick to actually start before queuing the second.
  await new Promise((r) => setTimeout(r, 5));

  const second = withTxLock(key, async () => {
    events.push('second:start');
    return 'second';
  });

  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1, 'first');
  assert.equal(r2, 'second');
  // second must not start until first has fully ended
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('different keys: not serialized against each other', async () => {
  const events: string[] = [];

  const a = withTxLock('chain-1:wallet-a', async () => {
    events.push('a:start');
    await new Promise((r) => setTimeout(r, 30));
    events.push('a:end');
  });
  const b = withTxLock('chain-1:wallet-b', async () => {
    events.push('b:start');
    await new Promise((r) => setTimeout(r, 5));
    events.push('b:end');
  });

  await Promise.all([a, b]);
  // b (different wallet key) finishes well before a, proving it wasn't
  // queued behind a's lock.
  assert.ok(events.indexOf('b:end') < events.indexOf('a:end'));
});

test('a rejected task does not block subsequent tasks for the same key', async () => {
  const key = 'chain-1:wallet-c';

  const failing = withTxLock(key, async () => {
    throw new Error('simulated nonce-too-low / revert');
  });
  await assert.rejects(failing, /simulated nonce-too-low/);

  // Queued after the failure — must still run (queue is not poisoned).
  const next = await withTxLock(key, async () => 'still runs');
  assert.equal(next, 'still runs');
});

test('preserves per-call return values and errors independently under contention', async () => {
  const key = 'chain-1:wallet-d';
  const results = await Promise.allSettled([
    withTxLock(key, async () => 1),
    withTxLock(key, async () => {
      throw new Error('mid-queue failure');
    }),
    withTxLock(key, async () => 3),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal((results[0] as PromiseFulfilledResult<number>).value, 1);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'fulfilled');
  assert.equal((results[2] as PromiseFulfilledResult<number>).value, 3);
});

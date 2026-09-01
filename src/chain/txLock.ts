/**
 * Per-(chain, wallet) transaction serialization.
 *
 * viem's wallet client fetches a "pending" nonce from the RPC node at send
 * time when no explicit nonce is supplied. Two concurrent sends against the
 * same account on the same chain (e.g. two TP/SL positions triggering a
 * close within the same tick via independent `setTimeout` callbacks, or a
 * manual bot command racing the watcher) can both read the same pending
 * nonce before either broadcast lands, racing: one send fails ("nonce too
 * low"), gets stuck, or unexpectedly replaces the other.
 *
 * `withTxLock` queues work per key so nonce-fetch-and-broadcast is atomic
 * across the whole bot. It is wired in once, in `clients.ts`, by wrapping
 * the wallet client's own `sendTransaction`/`writeContract` methods — every
 * existing call site (mint, close, swap, TP/SL, bridging, revoke,
 * transfer, wrap/unwrap) is covered automatically with no per-call-site
 * changes required.
 *
 * Deliberately NOT reentrant: a task must not call `withTxLock` with the
 * same key from inside another task already holding that key (it would
 * queue behind itself and deadlock). This is safe here because it is only
 * ever invoked from the wrapped `sendTransaction`/`writeContract` methods
 * themselves, which are leaf calls (no nested sends).
 */

const queues = new Map<string, Promise<unknown>>();

/** Run `fn` only after any previously queued work for this key has settled. */
export function withTxLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const run: Promise<T> = prior.then(fn, fn);
  // Store an always-resolving tracker so a rejection doesn't leave an
  // unhandled-rejection warning sitting on the queue between calls, while
  // callers of withTxLock still observe the real result via `run`.
  queues.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/** Test/inspection helper: number of distinct queues currently tracked. */
export function txLockQueueCount(): number {
  return queues.size;
}

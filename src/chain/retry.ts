/** Small retry helpers for flaky RPC / path fallbacks */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Duck-typed check for txRecovery.ts's "never retry" marker (kept local to
 * avoid a chain/ <-> chain/ import cycle). An error marked this way means a
 * broadcast's outcome is ambiguous or a nonce is confirmed consumed with no
 * hash to verify success/revert — retrying it risks a duplicate broadcast,
 * so withRetries must refuse regardless of any caller-supplied shouldRetry.
 */
function isNoRetryMarked(e: unknown): boolean {
  return !!(e && typeof e === 'object' && (e as Record<string, unknown>).__txNoRetry === true);
}

/**
 * Run `fn` up to `times` times. On failure, wait `backoffMs * attempt` then retry.
 * Does not retry if `shouldRetry` returns false.
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    times?: number;
    backoffMs?: number;
    label?: string;
    shouldRetry?: (err: unknown, attempt: number) => boolean;
  } = {},
): Promise<T> {
  const times = opts.times ?? 3;
  const backoffMs = opts.backoffMs ?? 800;
  const label = opts.label ?? 'op';
  let last: unknown;
  for (let i = 1; i <= times; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Hard veto, checked before any shouldRetry (default or caller-
      // supplied): a transaction whose broadcast outcome is ambiguous, or
      // whose nonce is confirmed consumed with no hash to verify
      // success/revert, must never be retried — see chain/txRecovery.ts.
      if (isNoRetryMarked(e)) {
        console.warn(
          `[retry ${label}] attempt ${i}/${times}: ambiguous/unresolved broadcast — refusing to retry: ${msg.slice(0, 160)}`,
        );
        break;
      }
      const retry =
        opts.shouldRetry?.(e, i) ??
        // default: retry transient / path failures, not "no balance" / "not found"
        !/no balance|not found|already empty|tokenIn === tokenOut|invalid address/i.test(
          msg,
        );
      console.warn(`[retry ${label}] attempt ${i}/${times} failed: ${msg.slice(0, 160)}`);
      if (!retry || i === times) break;
      await sleep(backoffMs * i);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

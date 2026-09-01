/**
 * Gas estimation — Phase 2 Part 3.
 *
 * Replaces hardcoded `gas: 900_000n`-style constants across the local
 * execution paths (swap/close/v4/mint) with a live `estimateContractGas`
 * call plus a bounded, configurable safety padding.
 *
 * Fail-closed policy (deliberately NOT "estimate fails -> send with
 * unlimited/huge gas"): every one of the 25 call sites this module
 * replaces already runs `simulateContract` with the identical
 * address/abi/functionName/args/account immediately before the write — if
 * that succeeded, the transaction is known-executable and a subsequent
 * `estimateContractGas` failure is almost always a transient RPC problem
 * (timeout, rate limit), not a newly-discovered revert. In that case this
 * falls back to the EXACT hardcoded constant each call site used before
 * this patch — an explicit, bounded, already-reviewed ceiling, not a new
 * unbounded guess — and logs a warning so the degradation is visible.
 * Every retry round in the callers already refreshes quote/simulation
 * state from scratch (Phase 1/2), so a bad estimate is never reused stale
 * across a retry — see PHASE2_PART3_AUDIT.md.
 *
 * Phase 2 Part 4 (§15) added one bounded retry of the live estimate before
 * falling back (estimate → retry once, short backoff → fallback), so a
 * single transient blip no longer immediately degrades to the fallback
 * constant. The fallback itself was reviewed call-site-by-call-site rather
 * than removed: every site's fallback is a small, function-specific,
 * pre-existing constant that WOULD under-gas a genuinely larger call
 * (safe failure — the tx reverts out-of-gas, wallet keeps its funds minus
 * a wasted-gas cost) rather than over-gas one (there is no unlimited/huge
 * fallback anywhere in this module). See PHASE2_PART4_AUDIT.md §10 for the
 * full per-call-site table.
 */
import type { Address, Hash } from 'viem';
import type { getPublicClient } from './clients.js';

/** Default padding applied on top of a successful estimate. */
export const GAS_ESTIMATE_PADDING_BPS = 2000; // 20% — matches the 1.15-1.25x buffers already used in tradingApi.ts for API-supplied gas

type MinimalGasClient = {
  estimateContractGas: ReturnType<typeof getPublicClient>['estimateContractGas'];
};

export type EstimateWriteGasParams = {
  client: MinimalGasClient;
  address: Address;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abi: any;
  functionName: string;
  args?: readonly unknown[];
  account: Address;
  value?: bigint;
  /** basis points added on top of the raw estimate (default GAS_ESTIMATE_PADDING_BPS) */
  paddingBps?: number;
  /**
   * The pre-existing hardcoded gas value this call site used before Phase 2
   * Part 3 — reused ONLY if live estimation fails, per the fail-closed
   * policy above. Required so every call site keeps an explicit, reviewed
   * bound rather than an ad-hoc new one.
   */
  fallbackGas: bigint;
  /** short label for the warning log when the fallback is used */
  context: string;
  /** retry the live estimate once (short backoff) before falling back — default true */
  retryOnce?: boolean;
  /** ms to wait before the single retry (default 400) */
  retryBackoffMs?: number;
  /** injectable for tests; default real setTimeout */
  sleepFn?: (ms: number) => Promise<void>;
};

/** Pure: apply bounded bps padding to a raw gas estimate. */
export function applyGasPadding(estimated: bigint, paddingBps: number): bigint {
  if (estimated <= 0n) return estimated;
  const bps = Math.max(0, Math.round(paddingBps));
  return (estimated * BigInt(10_000 + bps)) / 10_000n;
}

/**
 * Live-estimate gas for a contract write, padded, retrying once (short
 * backoff) before falling back to the call site's pre-existing hardcoded
 * constant. Never throws — a gas-estimation hiccup must not itself abort a
 * transaction whose safety-critical simulation already succeeded.
 */
export async function estimateWriteGas(params: EstimateWriteGasParams): Promise<bigint> {
  const attempt = async (): Promise<bigint> => {
    const estimated = await params.client.estimateContractGas({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
      account: params.account,
      ...(params.value != null ? { value: params.value } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return applyGasPadding(estimated as bigint, params.paddingBps ?? GAS_ESTIMATE_PADDING_BPS);
  };
  try {
    return await attempt();
  } catch (e1) {
    const msg1 = e1 instanceof Error ? e1.message : String(e1);
    if (params.retryOnce ?? true) {
      const sleepFn = params.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      await sleepFn(params.retryBackoffMs ?? 400);
      try {
        return await attempt();
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        console.warn(
          `[gas] estimateContractGas failed twice for ${params.context}, falling back to ${params.fallbackGas}: ${msg2.slice(0, 200)}`,
        );
        return params.fallbackGas;
      }
    }
    console.warn(
      `[gas] estimateContractGas failed for ${params.context}, falling back to ${params.fallbackGas}: ${msg1.slice(0, 200)}`,
    );
    return params.fallbackGas;
  }
}

export type ExecutionGasTelemetry = {
  gasLimitSent: string | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  actualGasCostWei: string | null;
};

type MinimalReceiptClient = {
  getTransactionReceipt: (args: {
    hash: Hash;
  }) => Promise<{ gasUsed?: bigint; effectiveGasPrice?: bigint; gasPrice?: bigint }>;
};

/**
 * Best-effort actual gas cost for a mined tx, read back from its receipt.
 * Never throws (telemetry must never block or fail the trade it describes)
 * and never fabricates a zero for a field it couldn't measure — an
 * unmeasurable value stays `null` ("UNKNOWN"), consistent with the rest of
 * this codebase's fail-closed telemetry (see computeRealizedSlippageBps).
 */
export async function buildGasTelemetry(
  client: MinimalReceiptClient,
  hash: Hash,
  gasLimitSent?: bigint,
): Promise<ExecutionGasTelemetry> {
  const base: ExecutionGasTelemetry = {
    gasLimitSent: gasLimitSent != null ? gasLimitSent.toString() : null,
    gasUsed: null,
    effectiveGasPriceWei: null,
    actualGasCostWei: null,
  };
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    const price = receipt.effectiveGasPrice ?? receipt.gasPrice;
    const gasUsed = receipt.gasUsed;
    return {
      ...base,
      gasUsed: gasUsed != null ? gasUsed.toString() : null,
      effectiveGasPriceWei: price != null ? price.toString() : null,
      actualGasCostWei: gasUsed != null && price != null ? (gasUsed * price).toString() : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[gas] receipt lookup failed for ${hash}, gas telemetry incomplete: ${msg.slice(0, 160)}`);
    return base;
  }
}

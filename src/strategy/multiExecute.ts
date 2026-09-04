import type { Address, Hex } from 'viem';
import { randomUUID } from 'node:crypto';
import type { SupportedChainId } from '../config.js';
import { loadPool, verifyOnChainPoolReserves } from '../chain/pools.js';
import { loadV4Pool, verifyV4PoolHasLiquidity } from '../chain/v4.js';
import { mintSingleSided, type MintParamsWithProtocol, type MintResult } from '../chain/mint.js';
import { getTokenMeta, humanToFloat } from '../chain/tokens.js';
import { getTokenPriceUsd } from '../price/dexscreener.js';
import {
  DEFAULT_PREFS,
  recordLedger,
  recordMultiPositionMeta,
  recordOpenPosition,
  setJournalAccountingMeta,
  setPositionTpSl,
  type UserPrefs,
} from '../db/index.js';
import {
  fetchAndFilterCandidates,
  revalidateCandidate,
  type CandidateFetcher,
  type RevalidationResult,
  type TokenInfoFetcher,
} from './multiCandidates.js';
import { discoverAndScorePoolsForCandidate, type PoolFetcher } from './multiPool.js';
import { computeMultiRange } from './multiRange.js';
import { checkPendingTransaction, recordEntryCooldown, runRiskGate } from './multiRisk.js';
import {
  executionLockKey,
  globalReservationKey,
  releaseExecutionLock,
  tryAcquireExecutionLock,
} from './executionLock.js';
import { getHotWalletAddress } from '../chain/clients.js';
import type { MultiConfig } from './multiConfig.js';
import type {
  MultiCandidate,
  MultiPoolCandidate,
  MultiStrategyRun,
  RejectedCandidate,
  TradeIntent,
} from './types.js';

export type MintFn = (params: MintParamsWithProtocol) => Promise<MintResult>;

/**
 * Injectable, matching the existing mintFn/poolFetcher/fetcher pattern —
 * keeps executeTradeIntent's real-RPC dependencies mockable in tests
 * without any network access, same as every other external call in this
 * pipeline. Defaults to the real on-chain check dispatched by protocol.
 */
export type LiquidityCheckFn = (
  intent: TradeIntent,
) => Promise<{ status: 'OK' | 'ONCHAIN_VALIDATION_ERROR' | 'TVL_MISMATCH' }>;

const defaultVerifyLiquidity: LiquidityCheckFn = (intent) =>
  intent.pool.protocol === 'v4'
    ? verifyV4PoolHasLiquidity(intent.chainId, intent.pool.poolAddress as Hex)
    : verifyOnChainPoolReserves(
        intent.chainId,
        intent.pool.poolAddress as Address,
        intent.token as Address,
        intent.quoteToken as Address,
        intent.pool.tvlUsd ?? 0,
      );

type LivePoolState = {
  currentTick: number;
  tickSpacing: number;
  token0: Address;
  token1: Address;
};

/** Unifies v3 (contract address) and v4 (poolId) live-state loading — MULTI never re-implements tick fetching. */
async function loadLivePoolState(
  chainId: SupportedChainId,
  pool: MultiPoolCandidate,
): Promise<LivePoolState | null> {
  try {
    if (pool.protocol === 'v4') {
      const info = await loadV4Pool(chainId, pool.poolAddress as Hex);
      return {
        currentTick: info.tick,
        tickSpacing: info.tickSpacing,
        token0: info.token0.address,
        token1: info.token1.address,
      };
    }
    const info = await loadPool(chainId, pool.poolAddress as Address);
    return {
      currentTick: info.tick,
      tickSpacing: info.tickSpacing,
      token0: info.token0.address,
      token1: info.token1.address,
    };
  } catch {
    return null;
  }
}

function rejectCandidate(candidate: MultiCandidate, reason: string): RejectedCandidate {
  return { ...candidate, rejectedReason: reason };
}

/**
 * Re-validates and then executes a single TradeIntent through the existing
 * execution pipeline (mintSingleSided → journalledSend → tx lock → journal →
 * receipt → accounting). MULTI never calls a wallet client directly and
 * never implements a second broadcast path — `mintFn` defaults to the same
 * `mintSingleSided` used by manual mints.
 */
export async function executeTradeIntent(params: {
  intent: TradeIntent;
  candidate: MultiCandidate;
  config: MultiConfig;
  prefs: UserPrefs;
  mintFn?: MintFn;
  verifyLiquidityFn?: LiquidityCheckFn;
}): Promise<{ tokenId: string; txHash: string } | { skipped: true; reason: string }> {
  const { intent, candidate, config, prefs } = params;
  const mintFn = params.mintFn ?? mintSingleSided;
  const verifyLiquidityFn = params.verifyLiquidityFn ?? defaultVerifyLiquidity;

  // The execution layer re-validates — it never trusts the intent blindly,
  // even though it was assembled by our own strategy code moments earlier.
  const gate = await runRiskGate(intent, config);
  const failure = gate.find((r) => !r.pass);
  if (failure) {
    return { skipped: true, reason: failure.reason ?? 'RISK_GATE_FAILED' };
  }

  const usdgAddress = config.usdgAddress;
  if (!usdgAddress) {
    return { skipped: true, reason: 'NOT_USDG' };
  }

  // Phase 4.7 audit (F-08): DexScreener's pool.tvlUsd (scored/ranked in
  // multiPool.ts, left untouched by this check) is never independently
  // verified on-chain before this point. Re-verifying only here — once, for
  // the single candidate about to receive a real deposit, not for every
  // Top-N candidate during a dry-run scan — keeps this bounded to exactly
  // one additional on-chain check per real execution (see the RPC-impact
  // note in each verify function's own doc comment). Fails closed: any
  // classification other than OK aborts the trade before any capital moves.
  const liquidityCheck = await verifyLiquidityFn(intent);
  if (liquidityCheck.status !== 'OK') {
    return { skipped: true, reason: liquidityCheck.status };
  }

  let sizeMode: 'percent' | 'fixed' = 'fixed';
  let fixedAmountHuman = 0;
  let balancePercent = 0;

  if (config.positionSizeUsd != null) {
    // Phase 4.7 fix: a failed/unavailable USDG price lookup must abort the
    // trade, not silently fabricate $1.00 — no capital has moved yet at
    // this point, so failing closed here is free. Fabricating a price to
    // size a real deposit ($positionSizeUsd / assumedPrice) risked
    // depositing a materially wrong token amount whenever MULTI_USDG_ADDRESS
    // is overridden to a non-default quote asset DexScreener fails to
    // price (the built-in chain default short-circuits to a real
    // stable-peg 1.0 and is not affected — see price/dexscreener.ts).
    const usdgPrice = await getTokenPriceUsd(config.chainId, usdgAddress);
    if (usdgPrice == null) {
      return { skipped: true, reason: 'PRICE_UNAVAILABLE' };
    }
    fixedAmountHuman = config.positionSizeUsd / usdgPrice;
  } else if (prefs.sizeMode === 'fixed') {
    fixedAmountHuman = prefs.fixedAmountHuman;
  } else {
    sizeMode = 'percent';
    balancePercent = prefs.balancePercent;
  }

  let result: MintResult;
  try {
    result = await mintFn({
      chainId: intent.chainId,
      poolAddress: intent.pool.poolAddress,
      depositToken: usdgAddress,
      balancePercent,
      sizeMode,
      fixedAmountHuman,
      widthPercent: config.rangePercent,
      protocol: intent.pool.protocol,
      dex: intent.pool.dex,
      poolId: intent.pool.protocol === 'v4' ? (intent.pool.poolAddress as Hex) : undefined,
    });
  } catch {
    return { skipped: true, reason: 'SIMULATION_FAILED' };
  }

  const tokenId = result.tokenId.toString();

  recordOpenPosition({
    chainId: intent.chainId,
    tokenId,
    poolAddress: String(result.poolAddress),
    token0: result.token0,
    token1: result.token1,
    fee: result.fee,
    tickLower: result.tickLower,
    tickUpper: result.tickUpper,
    protocol: result.protocol ?? 'v3',
    dex: result.dex ?? 'uniswap',
    strategy: 'multi',
  });

  const usdgMeta = await getTokenMeta(intent.chainId, usdgAddress);
  const depositAmountHuman = humanToFloat(result.depositAmount, usdgMeta.decimals);
  // The deposit has already been broadcast and confirmed by this point —
  // unlike the pre-mint sizing lookup above, there is no safe way to abort
  // here. A failed lookup still must not silently masquerade as a normal,
  // confident $1.00 price: logged so a real quote-asset depeg or DexScreener
  // outage during the accounting step is observable rather than invisible.
  const usdgPriceRaw = await getTokenPriceUsd(intent.chainId, usdgAddress);
  if (usdgPriceRaw == null) {
    console.warn(
      `[multi] price lookup failed while recording deposit accounting for ${usdgAddress} on chain ${intent.chainId} — falling back to $1.00; verify via /pnl if this quote asset is not actually pegged`,
    );
  }
  const usdgPriceNow = usdgPriceRaw ?? 1;
  const depositUsd = depositAmountHuman * usdgPriceNow;

  setJournalAccountingMeta(intent.chainId, result.hash, [
    {
      kind: 'deposit',
      tokenId,
      tokenAddress: usdgAddress,
      amountRaw: result.depositAmount.toString(),
      amountHuman: depositAmountHuman,
      usd: depositUsd,
      strategy: 'multi',
    },
  ]);

  recordLedger({
    chainId: intent.chainId,
    tokenId,
    kind: 'deposit',
    tokenAddress: usdgAddress,
    amountRaw: result.depositAmount.toString(),
    amountHuman: depositAmountHuman,
    usd: depositUsd,
    txHash: result.hash,
    strategy: 'multi',
  });

  // entryPrice intentionally null: deriving a decimals-correct USD entry price from
  // raw ticks here would require the same oriented-price logic already implemented
  // in chain/prices.ts — recomputing it independently risks silent drift, so this
  // is left unset rather than manufacturing a number that looks more precise than it is.
  recordMultiPositionMeta({
    chainId: intent.chainId,
    tokenId,
    candidateSource: candidate.source,
    candidateInterval: '6h',
    candidateMarketCapUsd: candidate.marketCapUsd,
    candidateAgeHours: candidate.ageHours,
    candidateVolume6hUsd: candidate.volume6hUsd,
    candidateClassification: candidate.classification,
    candidateScore: candidate.candidateScore,
    poolAddress: String(result.poolAddress),
    poolFee: intent.pool.fee,
    poolTvlUsd: intent.pool.tvlUsd,
    poolVolumeUsd: intent.pool.volumeUsd,
    poolScore: intent.pool.totalScore,
    entryPrice: null,
    tickLower: result.tickLower,
    tickUpper: result.tickUpper,
    positionSizeUsd: depositUsd,
    timestamp: Date.now(),
  });

  setPositionTpSl(intent.chainId, tokenId, {
    enabled: true,
    tpPercent: config.tpPercent,
    slPercent: config.slPercent,
  });

  recordEntryCooldown(intent.chainId, intent.token);

  return { tokenId, txHash: result.hash };
}

/** Injectable — defaults to the real revalidateCandidate; kept mockable for tests, matching every other external dependency in this pipeline. */
export type RevalidateFn = (
  config: MultiConfig,
  tokenAddress: string,
  opts?: { now?: number },
) => Promise<RevalidationResult>;

const defaultRevalidate: RevalidateFn = (config, tokenAddress, opts) =>
  revalidateCandidate(config, tokenAddress, opts);

/**
 * Phase 4.7 audit (F-10 + TOCTOU + F-11 global reservation) — the
 * Telegram-session-aware entry point for a MULTI Execute button press.
 * `executeTradeIntent` itself stays exactly as it was (a pure execution
 * engine with no notion of "sessions", "snapshot age", or locking) — this
 * wrapper adds everything only the session/concurrency layer needs to know:
 * how old the cached scan is, whether another Execute for this exact token
 * is already in flight, and — F-11 — whether ANY other MULTI execution for
 * this wallet is currently between its risk decision and its durable
 * outcome (which the per-token lock alone cannot detect, since two
 * different tokens acquire two different per-token keys).
 *
 * Ordering, deliberately, and NOT a blind copy of a suggested diagram:
 *
 *   TTL check → per-token lock → GLOBAL reservation → revalidation →
 *   executeTradeIntent (risk gate → F-08 → sizing → mintFn) →
 *   release GLOBAL reservation → release per-token lock
 *
 * Both locks are acquired BEFORE revalidation (which makes real GMGN
 * network calls) for the same reason F-10 already established for the
 * per-token lock alone: a rejected attempt costs zero wasted API calls,
 * rather than both contenders redundantly re-fetching the same data before
 * either discovers it lost the race.
 *
 * Per-token lock acquired FIRST, global reservation SECOND (the reverse of
 * this task's own suggested diagram) — deliberate, documented deviation:
 * placing the global reservation first would mean a same-token double-press
 * is intercepted by the (token-agnostic) global gate before ever reaching
 * the per-token lock, making the per-token lock's own distinct
 * EXECUTION_IN_PROGRESS outcome unreachable for that exact case and
 * silently changing already-tested F-10 behavior. Acquiring per-token
 * first preserves that existing, specific outcome unchanged, while the
 * global reservation — checked second — still fully closes the
 * cross-token race: a different token still cannot proceed past it while
 * any other token's attempt holds it. There is exactly one place in this
 * codebase that acquires both locks, always in this same order, so no
 * opposite-order acquisition — and therefore no deadlock — is possible.
 * Release order is the mirror image (global first, then per-token),
 * standard reverse-of-acquisition nesting.
 *
 * The global reservation is held for the SAME interval as the per-token
 * lock — through revalidation, runRiskGate, F-08, sizing, mintFn, and the
 * post-mint accounting writes inside executeTradeIntent — not released
 * early after runRiskGate. Releasing it as soon as runRiskGate passes would
 * defeat its entire purpose: another token's concurrent attempt would then
 * be free to run its own runRiskGate against the same not-yet-updated
 * open-position/exposure state.
 *
 * Scope boundary, explicit: both locks live here, not inside
 * executeTradeIntent itself. runMultiStrategy's own internal dryRun:false
 * loop (confirmed, again, to have zero production callers — grep
 * `runMultiStrategy(` finds exactly one call site, in bot.ts, always
 * `dryRun: true`) calls executeTradeIntent directly and therefore is NOT
 * covered by either lock. This is an intentional, currently-inert gap, not
 * an oversight: that loop processes its own candidates strictly
 * sequentially (one `await executeTradeIntent(...)` per iteration, never
 * fired concurrently with itself), so it cannot self-race; it also has no
 * "session" to derive a snapshot age from, so TTL/revalidation do not apply
 * to it either. It WOULD need equivalent locking if it is ever invoked
 * concurrently by more than one caller in the future (e.g. a scheduled
 * auto-execute feature) — flagged here precisely so that future work does
 * not silently inherit weaker protection than the Telegram path.
 */
export async function executeTradeIntentFromSnapshot(params: {
  intent: TradeIntent;
  candidate: MultiCandidate;
  config: MultiConfig;
  prefs: UserPrefs;
  /** MultiStrategyRun.timestamp — when the Telegram-cached scan was taken. */
  snapshotTimestamp: number;
  mintFn?: MintFn;
  verifyLiquidityFn?: LiquidityCheckFn;
  revalidateFn?: RevalidateFn;
  now?: number;
}): Promise<{ tokenId: string; txHash: string } | { skipped: true; reason: string }> {
  const { intent, config, prefs, snapshotTimestamp } = params;
  const now = params.now ?? Date.now();
  const revalidateFn = params.revalidateFn ?? defaultRevalidate;

  if (now - snapshotTimestamp > config.snapshotTtlMs) {
    return { skipped: true, reason: 'SNAPSHOT_EXPIRED' };
  }

  const wallet = getHotWalletAddress();
  const lockKey = executionLockKey(intent.chainId, wallet, intent.token);
  if (!tryAcquireExecutionLock(lockKey)) {
    return { skipped: true, reason: 'EXECUTION_IN_PROGRESS' };
  }

  try {
    // F-11: a second, wallet-wide (not token-specific) reservation. Without
    // this, two DIFFERENT tokens — each acquiring its own distinct
    // per-token lock above without conflict — could both pass
    // multiRisk.ts's checkPositionLimits (MULTI_MAX_OPEN_POSITIONS /
    // MULTI_MAX_EXPOSURE_USD) by both reading the same stale
    // listOpenPositions() state before either had durably recorded a
    // position. This reservation makes that read-decide-act sequence
    // single-flight across the whole wallet, for every MULTI token at once.
    const globalKey = globalReservationKey(intent.chainId, wallet);
    if (!tryAcquireExecutionLock(globalKey)) {
      return { skipped: true, reason: 'GLOBAL_EXECUTION_IN_PROGRESS' };
    }

    try {
      const revalidation = await revalidateFn(config, intent.token, { now });
      if (revalidation.status === 'REVALIDATION_SOURCE_ERROR') {
        return { skipped: true, reason: 'REVALIDATION_SOURCE_ERROR' };
      }
      if (revalidation.status === 'CANDIDATE_NOT_FOUND') {
        return { skipped: true, reason: 'CANDIDATE_NOT_FOUND' };
      }
      if (revalidation.status === 'REJECTED') {
        return { skipped: true, reason: revalidation.reason };
      }

      // revalidation.status === 'OK': eligibility reconfirmed with fresh data.
      // The intent itself (pool/range/sizing inputs) is NOT rebuilt from this
      // fresh candidate — F-08/F-09 already independently re-verify the pool
      // at the on-chain level inside executeTradeIntent, and rebuilding
      // pool/range here would mean re-running pool discovery/scoring, exactly
      // what this phase is scoped NOT to do. The freshly-revalidated candidate
      // IS used for accounting (recordMultiPositionMeta's candidate* fields),
      // so the historical record reflects what was actually true at the
      // moment capital moved, not the original (now provably stale) scan.
      //
      // runRiskGate (inside executeTradeIntent) is the SAME, unmodified risk
      // calculation as before — this reservation only serializes access to
      // it, it never duplicates or second-guesses its decision.
      return await executeTradeIntent({
        intent,
        candidate: revalidation.candidate,
        config,
        prefs,
        mintFn: params.mintFn,
        verifyLiquidityFn: params.verifyLiquidityFn,
      });
    } finally {
      releaseExecutionLock(globalKey);
    }
  } finally {
    releaseExecutionLock(lockKey);
  }
}

/**
 * Phase 4.7 audit (F-13) — a fresh, opaque scan identifier, generated
 * exactly once per runMultiStrategy call (see below — never regenerated
 * for report formatting, button building, refresh, or execute).
 *
 * 10 lowercase hex characters (40 bits of entropy) taken from the
 * fully-random prefix of a v4 UUID (the version/variant marker nibbles
 * live later in the string, at de-hyphenated position 12+, so slicing the
 * first 10 characters never includes a constrained bit) — deliberately
 * short: Telegram's callback_data has a hard 64-byte limit, and the actual
 * callback also carries a 42-character token address plus a short prefix,
 * so the scan-id budget is real, not cosmetic (see bot.ts's `mx:` callback
 * format). 40 bits (~1.1 trillion possible values) is far more entropy
 * than this bot's realistic scan volume could ever meaningfully collide
 * against — this is a collision-resistant tag, not a security secret.
 */
export function generateScanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/**
 * Runs the full MULTI pipeline: fetch/filter candidates → discover/score
 * pools → compute range → risk gate → (dry-run: stop here) or execute.
 * Every rejection carries a specific reason code — never a generic
 * "candidate rejected".
 */
export async function runMultiStrategy(
  config: MultiConfig,
  opts?: {
    dryRun?: boolean;
    mintFn?: MintFn;
    fetcher?: CandidateFetcher;
    infoFetcher?: TokenInfoFetcher;
    poolFetcher?: PoolFetcher;
    prefs?: UserPrefs;
    now?: number;
    verifyLiquidityFn?: LiquidityCheckFn;
  },
): Promise<MultiStrategyRun> {
  const now = opts?.now ?? Date.now();
  const dryRun = opts?.dryRun ?? true;
  // Generated exactly once per call, up front, so both the early "empty"
  // return (config disabled / pending tx) and the full return below share
  // the exact same identifier for this one scan.
  const scanId = generateScanId();

  const empty: MultiStrategyRun = {
    scanId,
    chainId: config.chainId,
    dryRun,
    timestamp: now,
    candidates: [],
    rejected: [],
    intents: [],
    executed: [],
  };

  if (!config.enabled || !config.usdgAddress) {
    return empty;
  }

  if (!dryRun) {
    const pending = checkPendingTransaction(config.chainId);
    if (!pending.pass) {
      return empty;
    }
  }

  const { candidates, rejected, sourceError } = await fetchAndFilterCandidates(config, {
    fetcher: opts?.fetcher,
    infoFetcher: opts?.infoFetcher,
    now,
  });

  const intents: TradeIntent[] = [];
  const executed: { tokenId: string; txHash: string; intent: TradeIntent }[] = [];
  const prefs = opts?.prefs ?? DEFAULT_PREFS;

  for (const candidate of candidates) {
    const { selected, poolFetchError } = await discoverAndScorePoolsForCandidate(config, candidate, {
      poolFetcher: opts?.poolFetcher,
    });

    if (!selected) {
      if (poolFetchError) {
        // Phase 4.7 fix: an infrastructure failure while fetching pools must
        // not be recorded as "this candidate has no valid pool" — that reason
        // code is meant for a genuine data-quality verdict, not an outage.
        console.warn(
          `[multi] pool discovery failed for ${candidate.address} on chain ${config.chainId}: ${poolFetchError.message}`,
        );
        rejected.push(rejectCandidate(candidate, 'POOL_FETCH_ERROR'));
      } else {
        rejected.push(rejectCandidate(candidate, 'NO_VALID_POOL'));
      }
      continue;
    }

    const live = await loadLivePoolState(config.chainId, selected);
    if (!live) {
      rejected.push(rejectCandidate(candidate, 'INVALID_PRICE'));
      continue;
    }

    const usdgIsToken0 = live.token0.toLowerCase() === config.usdgAddress.toLowerCase();
    const range = computeMultiRange({
      currentTick: live.currentTick,
      tickSpacing: live.tickSpacing,
      widthPercent: config.rangePercent,
      usdgIsToken0,
    });

    if (!range.valid) {
      rejected.push(rejectCandidate(candidate, range.rejectedReason));
      continue;
    }

    const intent: TradeIntent = {
      strategy: 'multi',
      chainId: config.chainId,
      token: candidate.address,
      quoteToken: config.usdgAddress,
      pool: selected,
      fee: selected.fee ?? 0,
      side: range.side,
      range: { tickLower: range.tickLower, tickUpper: range.tickUpper },
      positionSize:
        config.positionSizeUsd != null
          ? { sizeMode: 'fixed', fixedAmountHuman: config.positionSizeUsd }
          : {
              sizeMode: prefs.sizeMode,
              balancePercent: prefs.balancePercent,
              fixedAmountHuman: prefs.fixedAmountHuman,
            },
      depositToken: config.usdgAddress,
      reason: `candidateScore=${candidate.candidateScore.toFixed(3)} poolScore=${selected.totalScore.toFixed(3)}`,
      candidateScore: candidate.candidateScore,
      poolScore: selected.totalScore,
    };

    const gate = await runRiskGate(intent, config);
    const failure = gate.find((r) => !r.pass);
    if (failure) {
      rejected.push(rejectCandidate(candidate, failure.reason ?? 'RISK_GATE_FAILED'));
      continue;
    }

    intents.push(intent);

    if (!dryRun) {
      const outcome = await executeTradeIntent({
        intent,
        candidate,
        config,
        prefs,
        mintFn: opts?.mintFn,
        verifyLiquidityFn: opts?.verifyLiquidityFn,
      });
      if ('skipped' in outcome) {
        rejected.push(rejectCandidate(candidate, outcome.reason));
      } else {
        executed.push({ tokenId: outcome.tokenId, txHash: outcome.txHash, intent });
      }
    }
  }

  return { scanId, chainId: config.chainId, dryRun, timestamp: now, candidates, rejected, intents, executed, sourceError };
}

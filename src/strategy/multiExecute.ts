import type { Address, Hex } from 'viem';
import type { SupportedChainId } from '../config.js';
import { loadPool } from '../chain/pools.js';
import { loadV4Pool } from '../chain/v4.js';
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
import { fetchAndFilterCandidates, type CandidateFetcher, type TokenInfoFetcher } from './multiCandidates.js';
import { discoverAndScorePoolsForCandidate, type PoolFetcher } from './multiPool.js';
import { computeMultiRange } from './multiRange.js';
import { checkPendingTransaction, recordEntryCooldown, runRiskGate } from './multiRisk.js';
import type { MultiConfig } from './multiConfig.js';
import type {
  MultiCandidate,
  MultiPoolCandidate,
  MultiStrategyRun,
  RejectedCandidate,
  TradeIntent,
} from './types.js';

export type MintFn = (params: MintParamsWithProtocol) => Promise<MintResult>;

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
}): Promise<{ tokenId: string; txHash: string } | { skipped: true; reason: string }> {
  const { intent, candidate, config, prefs } = params;
  const mintFn = params.mintFn ?? mintSingleSided;

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

  let sizeMode: 'percent' | 'fixed' = 'fixed';
  let fixedAmountHuman = 0;
  let balancePercent = 0;

  if (config.positionSizeUsd != null) {
    const usdgPrice = (await getTokenPriceUsd(config.chainId, usdgAddress)) ?? 1;
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
  const usdgPriceNow = (await getTokenPriceUsd(intent.chainId, usdgAddress)) ?? 1;
  const depositUsd = depositAmountHuman * usdgPriceNow;

  setJournalAccountingMeta(intent.chainId, result.hash, [
    {
      kind: 'deposit',
      tokenId,
      tokenAddress: usdgAddress,
      amountRaw: result.depositAmount.toString(),
      amountHuman: depositAmountHuman,
      usd: depositUsd,
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
  },
): Promise<MultiStrategyRun> {
  const now = opts?.now ?? Date.now();
  const dryRun = opts?.dryRun ?? true;

  const empty: MultiStrategyRun = {
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
    const { selected } = await discoverAndScorePoolsForCandidate(config, candidate, {
      poolFetcher: opts?.poolFetcher,
    });

    if (!selected) {
      rejected.push(rejectCandidate(candidate, 'NO_VALID_POOL'));
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
      });
      if ('skipped' in outcome) {
        rejected.push(rejectCandidate(candidate, outcome.reason));
      } else {
        executed.push({ tokenId: outcome.tokenId, txHash: outcome.txHash, intent });
      }
    }
  }

  return { chainId: config.chainId, dryRun, timestamp: now, candidates, rejected, intents, executed, sourceError };
}

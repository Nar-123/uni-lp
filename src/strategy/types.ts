import type { DexId, SupportedChainId } from '../config.js';
import type { SizeMode } from '../chain/tokens.js';

/** Which strategy layer selects/sizes/times entries. Execution pipeline is shared by all. */
export type StrategyName = 'default' | 'multi';

export type CandidateType = 'MEME' | 'PROJECT' | 'UNKNOWN';

/**
 * A GMGN 6h-trending token that passed (or is being evaluated against) the
 * MULTI base filters. `null` fields mean UNKNOWN at the data source — never
 * coerced to 0 — callers must reject on UNKNOWN for hard requirements.
 */
export type MultiCandidate = {
  address: string;
  symbol: string;
  name: string;
  chainId: SupportedChainId;
  marketCapUsd: number | null;
  ageHours: number | null;
  volume6hUsd: number | null;
  liquidityUsd: number | null;
  classification: CandidateType;
  launchpadPlatform: string | null;
  candidateScore: number;
  reasons: string[];
  source: 'gmgn_trending_6h';
  sourceTimestamp: number;
};

/** A candidate that failed a filter, with the specific reason code (never generic). */
export type RejectedCandidate = MultiCandidate & { rejectedReason: string };

export type MultiPoolCandidate = {
  poolAddress: string;
  protocol: 'v3' | 'v4';
  dex: DexId;
  fee: number | null;
  tvlUsd: number | null;
  volumeUsd: number | null;
  liquidityUsd: number | null;
  currentPrice: number | null;
  sourceTimestamp: number;
  totalScore: number;
  tvlScore: number;
  volumeScore: number;
  volumeTvlScore: number;
  feeScore: number;
  reasons: string[];
  rejectedReasons: string[];
};

/**
 * Structured proposal produced by the MULTI strategy layer. The execution
 * layer (multiExecute.ts → mintSingleSided) re-validates every field — this
 * is never trusted blindly, matching the "strategy proposes, engine
 * disposes" boundary required by the spec.
 */
export type TradeIntent = {
  strategy: 'multi';
  chainId: SupportedChainId;
  token: string;
  quoteToken: string;
  pool: MultiPoolCandidate;
  fee: number;
  side: 'above' | 'below';
  range: { tickLower: number; tickUpper: number };
  positionSize: {
    sizeMode: SizeMode;
    fixedAmountHuman?: number;
    balancePercent?: number;
  };
  depositToken: string;
  reason: string;
  candidateScore: number;
  poolScore: number;
};

/**
 * Historical entry metadata for a MULTI-opened position — never overwritten
 * after entry (append-only per token/chain); used for auditability and the
 * /multi Telegram report, not for any live trading decision.
 */
export type MultiPositionMeta = {
  chainId: number;
  tokenId: string;
  candidateSource: 'gmgn_trending_6h';
  candidateInterval: '6h';
  candidateMarketCapUsd: number | null;
  candidateAgeHours: number | null;
  candidateVolume6hUsd: number | null;
  candidateClassification: CandidateType;
  candidateScore: number;
  poolAddress: string;
  poolFee: number | null;
  poolTvlUsd: number | null;
  poolVolumeUsd: number | null;
  poolScore: number;
  entryPrice: number | null;
  tickLower: number;
  tickUpper: number;
  positionSizeUsd: number | null;
  timestamp: number;
};

export type MultiStrategyRun = {
  /**
   * Phase 4.7 audit (F-13) — a fresh, opaque, cryptographically-random
   * identifier generated exactly once per scan (see multiExecute.ts's
   * generateScanId, called once in runMultiStrategy). Every Telegram
   * Execute button built from this run embeds this same scanId; a callback
   * is only ever resolved if it matches the CURRENT session's run.scanId
   * exactly — an old button from a since-replaced scan can never resolve
   * against a newer run, even if both scans happen to include the same
   * token address. Not a secret — just a collision-resistant tag, never
   * regenerated for the same scan (not on refresh-formatting, not on
   * button-building, not on execute).
   */
  scanId: string;
  chainId: SupportedChainId;
  dryRun: boolean;
  timestamp: number;
  candidates: MultiCandidate[];
  rejected: RejectedCandidate[];
  intents: TradeIntent[];
  executed: { tokenId: string; txHash: string; intent: TradeIntent }[];
  /**
   * Set when the candidate source itself failed (gmgn-cli not found, exec
   * failed, timed out, ...) — distinct from a genuinely empty `candidates`
   * list, which means the source responded and found nothing today.
   */
  sourceError?: { code: string; message: string };
};

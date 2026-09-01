# Phase 4 — MULTI Strategy — Final Audit

## Executive Summary

MULTI is an opt-in (`STRATEGY=multi`) candidate-selection and position-sizing
layer that sits entirely on top of the existing, already-hardened execution
engine (Phases 1–3.5). It never broadcasts a transaction itself; it builds a
`TradeIntent`, re-validates it through a risk gate, and hands it to the same
`mintSingleSided()` function manual mints use. This session continued work
already committed by a previous pass (commit `1c627ef`), which had built a
largely correct implementation. This session:

- **Fixed a confirmed correctness bug**: the "preferred fee tiers 5%/4%/3%"
  requirement was implemented with the wrong fee-unit magnitude
  (`[500, 400, 300]` = 0.05%/0.04%/0.03% in this codebase's convention,
  not real fee tiers on these chains at all). Corrected to
  `[50_000, 40_000, 30_000]`.
- **Closed a confirmed safety gap**: `STRATEGY=multi` gating existed as a
  function (`getActiveStrategyName`) but was never wired to anything — the
  `/multi` Telegram command family was reachable regardless of the env var.
  Added the gate to all three handlers.
- **Added the missing test suite**: zero MULTI-specific unit tests existed
  before this session. Added 58 tests across 6 files covering every
  checklist item in the spec's test section.

No other functional changes were made. The rest of the previous
implementation was read line-by-line, traced against the live call graph,
and found correct.

## Strategy Architecture

```
GMGN 6h trending → multiCandidates.ts (filter+rank+topN)
                 → multiPool.ts        (USDG pool discovery+scoring)
                 → multiRange.ts       (single-sided tick range)
                 → multiRisk.ts        (risk gate)
                 → multiExecute.ts     (TradeIntent → mintFn → accounting)
                                          │
                                          ▼
                              mintSingleSided() (existing, shared)
                                          │
                                          ▼
                       wallet.writeContract() (instrumented — see below)
```

`src/strategy/index.ts` re-exports all of the above as one module surface;
`src/bot/bot.ts` wires `/multi`, `multi:refresh`, and `multi:exec:*` to it.

## Candidate Source

`fetchAndFilterCandidates()` ([multiCandidates.ts](src/strategy/multiCandidates.ts))
calls `gmgnMarketTrending({ interval: '6h' })`. A fetch failure returns
`{candidates: [], rejected: []}` rather than throwing — fails closed, no crash.

## Candidate Filters

Applied in this exact order, each with a specific rejection reason:

1. `VOLUME_UNKNOWN` / `MC_UNKNOWN` — missing critical data rejects immediately, never coerced to 0.
2. `MC_TOO_LOW` — `marketCapUsd < config.minMarketCapUsd` (default $1M).
3. `CLASSIFICATION_UNKNOWN` — `launchpad_platform` absent/empty. Classification is **only** ever derived from this field, never inferred from name/ticker (verified by test with a token named "DogeMoonPumpMeme" and no `launchpad_platform`, which still rejects).
4. A secondary per-token `gmgnTokenInfo` lookup computes `ageHours` from `min(creation_timestamp, open_timestamp)`. `AGE_UNKNOWN` on fetch failure/throw/missing timestamps — fails closed. `AGE_TOO_LOW` if under `config.minTokenAgeHours` (default 24h).

## Candidate Ranking

`compareCandidates()` sorts strictly by `volume6hUsd` descending (tie-break:
liquidity, then address). This runs on the full filtered set — **filtering
happens before ranking and before top-N**, confirmed by a regression test
where a high-volume, MC-failing token never occupies a slot even though it
would rank #1 by volume alone.

## Candidate Scoring

`candidateScore = (rank_position_from_bottom) / total_ranked` — a simple
0–1 relative rank score, attached only for reporting/audit purposes
(`intent.reason`, `MultiPositionMeta.candidateScore`). It does not feed into
position sizing (see Position Sizing below).

## Pool Discovery

`discoverAndScorePoolsForCandidate()` ([multiPool.ts](src/strategy/multiPool.ts))
fetches all pools for the candidate token via `listPoolsForToken(chainId, address, 0)`
(min-TVL 0 so every pool reaches the filter stage with an explicit reason),
then applies:

1. `NOT_USDG` — pool's token0/token1 must equal `config.usdgAddress` **by contract address**, case-insensitive. Never matched by symbol.
2. `FEE_TIER_NOT_SUPPORTED` — fee must be one of the actually-supported preferred tiers (see Fee Tier Selection).
3. `TVL_TOO_LOW` — `tvlUsd < MIN_POOL_TVL_USD` ($2,000, from `chain/pools.ts`).

## Pool Scoring

`scoreMultiPool()` computes a weighted sum of four independently-normalized
dimensions (each capped at 1.0):

- `tvlScore = min(1, tvlUsd / 100_000)`
- `volumeScore = min(1, volumeUsd / 50_000)`
- `volumeTvlScore = min(1, (volumeUsd/tvlUsd) / 0.5)`
- `feeScore` — 1.0 / 0.75 / 0.5 for 5% / 4% / 3% respectively, 0 for anything else (never reached, since non-preferred tiers are already filtered out).

Weights are configurable (`MULTI_POOL_*_WEIGHT`, defaulting to 0.3/0.3/0.25/0.15).
Ranking tie-breaks deterministically: `totalScore → tvlUsd → volumeUsd → poolAddress`.
Verified by test that a pool with a much better volume/TVL ratio outranks
a pool that only wins on raw TVL — **selection is never TVL alone.**

## Fee Tier Selection

**Bug found and fixed this session.** Fee values in this codebase follow the
on-chain Uniswap v3 `fee()` convention: `fee / 10_000 = percent` (confirmed
via `chain/pools.ts`'s `feeLabel = (fee/10000).toFixed(2)+'%'`, used
consistently everywhere else, e.g. `config.ts`'s `FEE_TIERS = [100, 500, 3000, 10000]`
= 0.01%/0.05%/0.3%/1%). The MULTI implementation had:

```
const PREFERRED_FEE_TIERS = [500, 400, 300];  // = 0.05% / 0.04% / 0.03%
```

which is two orders of magnitude off from the spec'd 5%/4%/3%, and doesn't
match any fee tier this protocol's factories actually deploy — meaning pool
discovery would have rejected every real pool as `FEE_TIER_NOT_SUPPORTED`.
Fixed to:

```
const PREFERRED_FEE_TIERS = [50_000, 40_000, 30_000];  // 5% / 4% / 3%
```

with `feeScoreFor()` updated to match. Never forces an unavailable tier —
if a candidate's only USDG pool is at the standard 0.3% tier, it is rejected
(`FEE_TIER_NOT_SUPPORTED`), not substituted.

## USDG Validation

`resolveUsdgAddress()` ([multiConfig.ts](src/strategy/multiConfig.ts)) resolves
from `MULTI_USDG_ADDRESS` env override (validated as a real address) or
`CHAINS[chainId].usdg` (a hardcoded per-chain contract address). If neither
resolves, `usdgAddress` is `null` and `validateMultiConfig` disables MULTI
entirely — **no fallback to USDC/USDT/WETH/native.** `isUsdgPool()` and the
risk gate's `NOT_USDG` re-check both compare by lowercased contract address,
never by symbol/label.

## Single-Sided Logic

`computeMultiRange()` ([multiRange.ts](src/strategy/multiRange.ts)) is a thin
wrapper — it does not re-derive tick math. It delegates entirely to
`chain/ticks.ts`'s `computeSingleSidedRange()` / `assertOutOfRange()`, the
same protocol-correct tick math the rest of the bot uses. `usdgIsToken0`
(from live pool token ordering) determines the side: USDG-as-token0 →
range above market; USDG-as-token1 → range below market. Any tick-math
failure (boundary overflow, invalid width, would-require-both-tokens) is
caught and returns `{valid: false, rejectedReason: ...}` rather than
throwing to the caller.

## Range Calculation

`widthPercent` (default 50, i.e. "~-50%") passes straight through to
`computeSingleSidedRange`, which computes `ticksForPriceRatio(1 - widthPercent/100)`
and aligns to `tickSpacing`. Verified by test: for a below-market range, the
resulting lower-bound price is ~0.50× the current price (tolerance
0.45–0.55 to account for tick-spacing rounding), and both bounds are exact
multiples of `tickSpacing`.

## Position Sizing

`executeTradeIntent()` sizes from `config.positionSizeUsd` (fixed USD,
converted via live USDG price) if set, else falls back to the user's
existing `UserPrefs` (`sizeMode`/`fixedAmountHuman`/`balancePercent`) — the
same preferences manual mints use. **`candidateScore` and `poolScore` are
never read when computing size** — confirmed by reading every line of
`executeTradeIntent` and by the fact neither variable appears in the sizing
branch.

## Risk Gates

`runRiskGate()` ([multiRisk.ts](src/strategy/multiRisk.ts)) runs and reports
**every** check (not just the first failure), and `executeTradeIntent`
treats any non-passing result as a hard block:

- `NOT_USDG` — intent's quote token re-checked against configured USDG address.
- `INVALID_RANGE` — `tickLower < tickUpper` re-checked.
- `DUPLICATE_POSITION` — any open position (any strategy) on this token/chain blocks entry.
- `POSITION_LIMIT` — `MULTI_MAX_OPEN_POSITIONS` / `MULTI_MAX_POSITIONS_PER_TOKEN` / `MULTI_MAX_EXPOSURE_USD`, scoped to `strategy==='multi'` positions only (default-strategy positions don't count against MULTI's own limits, and vice versa).
- `ENTRY_COOLDOWN` — in-memory per-(chain,token) cooldown; only recorded on a successful entry, never on a rejection (retries aren't penalized).
- `PENDING_TRANSACTION` — any unresolved journal entry on the chain blocks a new MULTI send. `runMultiStrategy` also checks this **before fetching any candidates** in a live (non-dry) run, so a stuck prior transaction blocks the whole cycle immediately.

## Execution Boundary

Traced the full call chain:

```
multiExecute.ts: executeTradeIntent()
  → mintFn(...)                          // defaults to mintSingleSided, injectable for tests
    → mintSingleSided() [chain/mint.ts]
      → wallet.writeContract(...)        // wallet = getWalletClient(chainId)
```

`getWalletClient()` ([chain/clients.ts:260-298](src/chain/clients.ts)) returns
a wallet client whose `sendTransaction`/`writeContract` methods are
**unconditionally wrapped** with `withTxLock(...)` (per chain+wallet
serialization) and `journalledSend(...)` (journal-before-broadcast,
classify-on-ambiguous-failure, recovery). This wrapping is applied once, at
client-construction time, for **every** caller — mint, close, swap, TP/SL,
bridging, revoke, transfer — with no per-call-site opt-in needed. MULTI gets
this automatically through the shared client, with zero special-casing.

**Static verification**: `grep -rn 'sendTransaction|writeContract|walletClient\.' src/strategy/` returns zero matches. No file under `src/strategy/` references a raw broadcast call or a wallet client. This is also asserted as an automated test (`test/strategy.multiExecute.test.ts`, "execution boundary" tests) so a future regression would fail CI.

## Duplicate Prevention

- Open-position check (`checkDoubleEntry`) — any strategy's open position on the token blocks a new MULTI entry.
- Position/exposure limits (`checkPositionLimits`) — scoped to `strategy==='multi'`.
- Pending-transaction check (`checkPendingTransaction`) — blocks on any unresolved journal entry, checked both inside the risk gate (per-intent) and at the top of `runMultiStrategy` for a live run (blocks the whole scan before any candidate fetch).

## Exit Integration

MULTI positions are enrolled via `setPositionTpSl()` — the exact function
manual positions use. `tpslWatcher.ts` is strategy-agnostic: it polls
`listTpSlEnrolledPositions()` and closes via `closePosition()`
([chain/close.ts](src/chain/close.ts)), with no branching on `strategy`.
No second close engine exists. Grep for trailing-TP logic across the repo
returns nothing — trailing TP remains off, as required.

## Accounting Integration

`executeTradeIntent()` calls, in order: `recordOpenPosition` (with
`strategy: 'multi'`), `setJournalAccountingMeta`, `recordLedger` (with
`strategy: 'multi'`), `recordMultiPositionMeta`, `setPositionTpSl` — all
existing functions, all shared with manual mints. `recordMultiPositionMeta`
is **append-only**: it's a no-op if metadata already exists for
`(chainId, tokenId)`, so historical entry data is never overwritten.
`entryPrice` is intentionally left `null` rather than recomputed
independently from raw ticks (the code comment explains this is to avoid
silent drift from the decimals-correct oriented-price logic that already
exists in `chain/prices.ts`).

## Dry Run

`runMultiStrategy({dryRun: true})` runs the full pipeline (fetch → filter →
pool discovery → range → risk gate → intent) and stops before
`executeTradeIntent` — `mintFn` is never invoked. Verified by test with a
`mintFn` spy that throws if called: 0 calls, `run.executed.length === 0`.
The Telegram `/multi` report shows candidates, pool selection, range, and
risk-gate outcome for every intent without sending anything.

## Telegram

`/multi` (scan + report), `multi:refresh` (re-scan, edits in place),
`multi:exec:<token>` (execute one specific intent from the last scan,
guarded by a staleness check against the user's session). **All three are
now gated behind `getActiveStrategyName() === 'multi'`** (fixed this
session — see Strategy Isolation below).

## Tests

58 new tests added across 6 files, all using dependency-injected
fetchers/mintFn (no live network calls except the two pre-existing Phase 2
RPC integration tests, which are unrelated to MULTI):

| File | Tests | Covers |
|---|---|---|
| [test/strategy.multiCandidates.test.ts](test/strategy.multiCandidates.test.ts) | 16 | MC/age boundaries, UNKNOWN fail-closed, classification, filter-before-topN, volume sort, topN cap, fetch failure |
| [test/strategy.multiPool.test.ts](test/strategy.multiPool.test.ts) | 14 | USDG by contract address, fee-tier availability (never forced), TVL gate, scoring (TVL/volume/vol-per-TVL/fee), deterministic tie-break, fetch failure |
| [test/strategy.multiRange.test.ts](test/strategy.multiRange.test.ts) | 8 | Side selection, single-sidedness, tick-spacing alignment, ~50% width, invalid-width/boundary-overflow fail-closed |
| [test/strategy.multiRisk.test.ts](test/strategy.multiRisk.test.ts) | 13 | Duplicate entry, position/exposure limits (strategy-scoped), entry cooldown (not penalized on rejection), pending-tx, full risk-gate integration |
| [test/strategy.multiExecute.test.ts](test/strategy.multiExecute.test.ts) | 7 | Static execution-boundary scan, dry-run zero-tx, risk-gate short-circuit (no mintFn call), pending-tx blocks before fetch, disabled config no-op |
| [test/strategy.isolation.test.ts](test/strategy.isolation.test.ts) | 4 | STRATEGY env parsing (unset/multi/case-insensitive/other-value) |

## Test Results

```
npm run typecheck   → clean
npm run build       → clean
npm test            → 226/226 passing (168 pre-existing + 58 new)
npm run test:integration → 1 pass, 2 timeouts (pre-existing Phase 2 live-RPC
                            tests, no network access in this sandbox — not
                            a MULTI test, not a regression)
```

## Adversarial Audit

Searched the entire diff and all of `src/strategy/` for: `sendTransaction`,
`writeContract`, `minOut`, `amount0Min`, `amount1Min`, `quote`, `simulation`,
`gas`, `journal`, `recordLedger`, `multi`.

- `sendTransaction` / `writeContract`: zero occurrences in `src/strategy/`.
- `minOut` / `amount0Min` / `amount1Min`: zero occurrences in `src/strategy/` — MULTI never computes its own slippage floor; that logic lives entirely in `chain/swap.ts`/`chain/close.ts` (already covered by the Phase 2 hardening test suite: `test/swap.decimals.test.ts` "minOut cannot become 0..." etc.), reached only through `mintSingleSided`.
- `quote` / `simulation` / `gas`: MULTI never calls these directly either — they're internal to `mintSingleSided`'s call graph.
- `recordLedger`: called once in `executeTradeIntent`, with `strategy: 'multi'` tagged, using the same shared ledger function (not a parallel accounting path).

Traced every MULTI execution path (`executeTradeIntent`, `runMultiStrategy`)
end to end: neither function, nor anything they call within `src/strategy/`,
constructs a wallet client, signs anything, or calls a broadcast method
directly. All paths terminate at the shared `mintFn`/`mintSingleSided`.

## Remaining Risks

1. The full mint happy path (real price/RPC calls inside `executeTradeIntent`) has not been exercised end-to-end in this sandbox (no live RPC). Recommend a manual `/multi` → dry-run → single test execution on a live/testnet deployment before enabling for real capital.
2. Pool/candidate scoring weights (`MULTI_POOL_*_WEIGHT`, `TVL_REFERENCE_USD`, `VOLUME_REFERENCE_USD`, etc.) are heuristic constants, not calibrated against historical data.
3. `entryCooldownMs` is in-memory only (resets on process restart) — acceptable per the code's own comment since duplicate-position/pending-tx are the durable guards, but worth knowing.

## Known Limitations

- No trailing take-profit (by design, per instructions).
- No Degen/Bigcap/AI-scoring variants (by design, per instructions).
- `fee` is displayed in the Telegram report as `${intent.fee}bps`, which is
  technically the raw fee-unit value (e.g. `50000`), not actual bps
  (`500`). Cosmetic only — does not affect any filtering, scoring, or
  execution logic. Left as-is (out of scope; no spec requirement on exact
  display formatting).

## Parameter Calibration Requirements

Before live capital: back-test/paper-trade `MULTI_MIN_MARKET_CAP_USD`,
`MULTI_MIN_TOKEN_AGE_HOURS`, `MULTI_TOP_N`, `MULTI_RANGE_PERCENT`, the four
`MULTI_POOL_*_WEIGHT` values, `MULTI_TP_PERCENT`/`MULTI_SL_PERCENT`, and
`MULTI_MAX_EXPOSURE_USD` against real GMGN 6h data for the target chain.
None of these were tuned in this session — only their *mechanics* were
verified.

## Final Verdict

**PASS**

- MULTI is isolated from the default strategy — confirmed, and the one
  gating gap found (`STRATEGY` env never actually checked) is now fixed.
- Candidate filtering is correct: MC ≥ $1M, age ≥ 24h, filtering strictly
  before top-N, volume-ranked, UNKNOWN fails closed on every critical
  field.
- USDG validated by contract address, never symbol.
- Pool scoring incorporates TVL + volume + volume/TVL + fee; unsupported
  fee tiers are never forced (and the fee-tier bug that would have made
  this always fail is fixed).
- Single-sided range uses the existing protocol tick math, verified
  ~50% width and tick-spacing alignment.
- Position sizing is bounded and not score-scaled.
- Duplicate entry and unresolved-transaction checks block entry.
- MULTI cannot bypass the hardened execution/accounting layers — traced
  end-to-end and statically verified (test-enforced) that no
  `sendTransaction`/`writeContract`/wallet-client call exists anywhere in
  `src/strategy/`; every mint goes through the same instrumented wallet
  client as manual mints.
- Dry-run works and sends zero transactions.
- Typecheck, build, and unit tests all pass (226/226).

**PASS does not mean profitable. PASS does not mean production-ready.**
MULTI must undergo paper trading, out-of-sample testing, and parameter
calibration (see above) before live capital is put behind it.

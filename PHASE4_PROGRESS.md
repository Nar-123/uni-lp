# Phase 4 — MULTI Strategy — Progress Checklist

Status as of this session. Continued from the previous AI's commit
`1c627ef` ("Phase 2-4: quote/gas/tx hardening, PnL reconciliation, and
MULTI strategy") — that commit already contained a substantial, mostly
correct MULTI implementation. This session inspected it end-to-end, fixed
one confirmed correctness bug, closed one confirmed safety gap, and added
the test coverage that did not exist yet.

| Requirement | Status | Evidence |
|---|---|---|
| Candidate source (GMGN 6h trending) | DONE | [multiCandidates.ts](src/strategy/multiCandidates.ts) `fetchAndFilterCandidates` calls `gmgnMarketTrending({interval:'6h'})` |
| MC >= $1M filter | DONE | `multiCandidates.ts` MC check before classification; boundary + UNKNOWN tests in [test/strategy.multiCandidates.test.ts](test/strategy.multiCandidates.test.ts) |
| Age >= 24h filter | DONE | Secondary `gmgnTokenInfo` lookup, `ageHoursFromInfo`; UNKNOWN (fetch fails/throws) fails closed as `AGE_UNKNOWN`, never coerced |
| Meme/Project classification | DONE | `classify()` — presence of `launchpad_platform` only; missing → `UNKNOWN` → rejected, never inferred from name/ticker |
| Existing global risk filters | DONE (no separate filter exists) | Confirmed there is no other pre-existing "global candidate filter" layer in this codebase (screener has none either) — MULTI's own risk gate (duplicate/position-limit/cooldown/pending-tx) is the equivalent safety layer, applied at intent-build time |
| Filter-before-Top-10 (not Top-10-then-filter) | DONE | `fetchAndFilterCandidates`: all hard filters run first, `ranked.slice(0, topN)` is the final step; regression test proves an MC-failing high-volume token never occupies a slot |
| Sort by 6h volume | DONE | `compareCandidates` sorts by `volume6hUsd` desc (liquidity, then address as tie-break) |
| Top 10 | DONE | `config.topN` (default 10), applied after full filter+sort |
| USDG-only pool | DONE | `isUsdgPool()` compares actual contract address (case-insensitive), never symbol; `resolveUsdgAddress()` never falls back to USDC/USDT/WETH/native |
| Pool validation | DONE | `discoverAndScorePoolsForCandidate`: USDG pair, fee-tier availability, min-TVL gate, each with a distinct rejection reason |
| TVL + volume + volume/TVL + fee scoring | DONE | `scoreMultiPool` — weighted sum of all four, configurable weights, deterministic tie-break (score → TVL → volume → address) |
| Preferred fee tiers 5%/4%/3%, only if available | **FIXED this session** | `PREFERRED_FEE_TIERS` was `[500, 400, 300]` (= 0.05%/0.04%/0.03% in this codebase's fee-unit convention — see `chain/pools.ts` `feeLabel = fee/10000`), i.e. two orders of magnitude off from the spec'd 5%/4%/3% and not even a real fee tier ever deployed on these chains. Corrected to `[50_000, 40_000, 30_000]`. Never forces an unavailable tier — confirmed by test (`FEE_TIER_NOT_SUPPORTED` for e.g. the standard 0.3% tier). |
| Single-sided | DONE | `computeMultiRange` delegates to `chain/ticks.ts` `computeSingleSidedRange` + `assertOutOfRange` (no second/naive range calculation); tests confirm the range never straddles the current tick |
| ~-50% range via protocol tick math | DONE | Same function; test confirms lower-bound price ≈ 0.50× current price for a below-market range, tick-spacing alignment confirmed |
| Risk gate | DONE | [multiRisk.ts](src/strategy/multiRisk.ts): USDG re-check, range re-check, duplicate-entry, position/exposure limits, entry cooldown, pending-tx — all run and reported, not just first-failure |
| Existing hardened execution engine | DONE | `executeTradeIntent` calls `mintFn` which defaults to `mintSingleSided` — the same function manual mints use. Traced further: `mintSingleSided` → `wallet.writeContract()`, and the wallet client returned by `getWalletClient()` (`chain/clients.ts`) transparently wraps **every** `writeContract`/`sendTransaction` call with `withTxLock` + `journalledSend` (tx lock, journal, ambiguous-broadcast recovery) — this applies unconditionally to all callers, so MULTI inherits it with no special-casing needed. |
| Existing transaction journal/recovery | DONE | Same wrapping as above; MULTI adds no second journal/recovery path |
| Existing accounting | DONE | `executeTradeIntent` calls `recordLedger`/`setJournalAccountingMeta`/`recordOpenPosition` — the same functions/tables manual mints use |
| Strategy isolation (STRATEGY=default vs STRATEGY=multi) | **FIXED this session** | `getActiveStrategyName()` existed but was never actually called anywhere — the `/multi` command family was reachable by any authorized user regardless of the `STRATEGY` env var. Added a gate to all three handlers (`/multi`, `multi:refresh`, `multi:exec:*`) in [bot.ts](src/bot/bot.ts) requiring `getActiveStrategyName() === 'multi'`; the default strategy's mint/close/swap flows are untouched. |
| MULTI requirements — UNKNOWN fails closed | DONE | Every critical field (MC, age, volume, classification) rejects on UNKNOWN with a specific reason code; never coerced to 0/pass |
| Duplicate entry / pending-tx / position limits | DONE | `multiRisk.ts`; `runMultiStrategy` also short-circuits the entire run (before even fetching candidates) when a pending unresolved tx exists on the chain |
| Dry run (0 transactions) | DONE | `runMultiStrategy({dryRun:true})` never calls `mintFn`; test proves 0 mint invocations and `run.executed.length === 0` |
| Accounting metadata (append-only) | DONE | `recordMultiPositionMeta` is a no-op if metadata already exists for (chainId, tokenId) — never overwrites historical entry data |
| Exit integration (existing ExitEngine, no second close engine, trailing TP OFF) | DONE | `tpslWatcher.ts` is strategy-agnostic (`listTpSlEnrolledPositions`, `closePosition` from `chain/close.ts`); MULTI positions get `setPositionTpSl` called with the same function manual positions use; no new close engine exists; no trailing-TP code exists anywhere |
| Position sizing bounded, not score-scaled | DONE | `executeTradeIntent` sizes from `config.positionSizeUsd` (fixed) or the user's existing prefs — `candidateScore`/`poolScore` are never read when computing size |
| Tests — MC/age boundary, UNKNOWN, filter-before-top10, volume sort | **ADDED this session** | [test/strategy.multiCandidates.test.ts](test/strategy.multiCandidates.test.ts) (16 tests) |
| Tests — USDG address, pool scoring, fee availability | **ADDED this session** | [test/strategy.multiPool.test.ts](test/strategy.multiPool.test.ts) (14 tests) |
| Tests — single-sided range, tick spacing | **ADDED this session** | [test/strategy.multiRange.test.ts](test/strategy.multiRange.test.ts) (8 tests) |
| Tests — duplicate entry, position limits, pending-tx, cooldown | **ADDED this session** | [test/strategy.multiRisk.test.ts](test/strategy.multiRisk.test.ts) (13 tests) |
| Tests — dry-run, accounting, execution boundary | **ADDED this session** | [test/strategy.multiExecute.test.ts](test/strategy.multiExecute.test.ts) (7 tests) |
| Tests — strategy isolation | **ADDED this session** | [test/strategy.isolation.test.ts](test/strategy.isolation.test.ts) (4 tests) |
| Execution boundary static proof (no direct sendTransaction/writeContract/wallet client in strategy/*) | **ADDED this session** | Static source-scan test in `strategy.multiExecute.test.ts`; also manually confirmed via `grep` across `src/strategy/` (zero matches) |
| Typecheck | PASS | `npm run typecheck` — clean |
| Build | PASS | `npm run build` — clean |
| Unit tests | PASS | `npm test` — 226/226 passing (168 baseline + 58 new MULTI tests) |
| Integration tests | **BLOCKED (environment)** | `npm run test:integration` — 1 pass, 2 timeouts in `test/integration/quote.rpc.test.ts` (Phase 2, pre-existing, unrelated to MULTI). These hit a **live RPC endpoint** and were rate-limited/timed out in this sandbox, which has no working outbound RPC access. Not a MULTI regression — no MULTI integration test exists in that suite. |

## Not implemented (out of scope per instructions, confirmed absent)

- Trailing TP — absent, as required.
- A second/duplicate close engine — absent; MULTI reuses `chain/close.ts` + `tpslWatcher.ts`.
- Degen/Bigcap/AI scoring/auto-compounding/live-capital activation — absent, as required.

## Residual risk / things a human should know before enabling STRATEGY=multi

1. **Live-RPC path untested here.** The full mint happy path inside `executeTradeIntent` (real `getTokenPriceUsd` + `getTokenMeta` calls) requires live network/RPC access this sandbox doesn't have. It was verified by tracing the call graph and by the existing Phase 2 test suite that already covers `mintSingleSided`'s internals — but it has not been exercised end-to-end as MULTI in this session. Recommend a manual `/multi` dry-run against a live bot instance before flipping `STRATEGY=multi` in production.
2. **Fee-tier constants were wrong before this session** (see table above) — if MULTI was ever dry-run before this fix, its pool selection would have silently only ever matched 0.05%/0.04%/0.03% tier pools (which likely don't exist on these chains), meaning **every candidate would have been rejected `NO_VALID_POOL`**. This fix changes MULTI's behavior from "never finds a pool" to "actually finds 5%/4%/3% pools when they exist" — re-verify with a fresh dry-run.
3. **`/multi` was previously usable by any authorized user regardless of `STRATEGY`.** After this session's fix, the deployment operator must set `STRATEGY=multi` for the command to do anything. If MULTI was already being dry-run/tested in a live deployment before this fix without `STRATEGY=multi` set, that still worked (config-`enabled`, not the env var, gated it) — only the *isolation guarantee* was missing, not functionality.

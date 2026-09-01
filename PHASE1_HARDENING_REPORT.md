# PHASE 1 — UNICRIT Capital Safety Hardening Report

Scope: capital-safety hardening only. No changes to strategy parameters, GMGN
screening, range strategy, TP/SL thresholds, pool selection strategy, position
sizing strategy, or MULTI. Architecture preserved; no large rewrites.

## Executive Summary

The audit traced every execution path that can move funds — mint, increase
liquidity, decrease liquidity/close, collect, swap, unwrap, quote, price,
position valuation, ownership, transaction execution, retry, and simulation —
from candidate discovery through TP/SL to on-chain send.

Two classes of P0 (critical) capital-safety defects were found and fixed:

1. **Zero-protection execution paths.** Both the local swap engine and both
   close paths (Uniswap v3 and v4) could send a transaction with
   `minOut = 0` / `amount0Min = amount1Min = 0`, either as a designed
   "not slippage-protected" close, or as a retry fallback that progressively
   weakened protection down to zero after a stricter attempt reverted. Any
   of these paths could execute at an arbitrarily bad price (sandwich/MEV,
   thin-pool slippage, or a stale quote), realizing severe, avoidable losses.

2. **UNKNOWN price silently becoming ZERO, corrupting automated PnL/TP-SL
   decisions.** Position valuation computed `valueUsd` as
   `amount * (price ?? 0)`. When a token's USD price was genuinely
   unavailable (price-provider timeout/failure), the position's live value
   collapsed toward zero, which made PnL/TP-SL logic compute a deeply
   negative PnL — capable of **automatically triggering a stop-loss close on
   a healthy position** purely because of a transient price-feed hiccup.
   A related bug in the TP/SL watcher conflated *any* read failure
   (including transient RPC errors) with "position confirmed gone," silently
   disabling TP/SL protection with no user notification.

Both classes are fixed. A new fail-closed helper module
(`src/chain/safety.ts`) centralizes the invariants so they can't be
silently reintroduced at a new call site, and the two false-trigger bugs are
closed by tracking price/read completeness end-to-end instead of coercing
UNKNOWN to a numeric zero.

## Findings Before Patch

### P0-1 — Local swap engine: retry silently weakens minOut to zero
- **File:** [src/chain/swap.ts](src/chain/swap.ts)
- **Function:** `previewSwapToNative`, `swapTokenToNative`, `swapExactInLocal`
- **Root cause:** `previewSwapToNative` computed
  `amountOutMinimum = estimatedOut > 0n ? floor : 0n` — a quote failure
  silently produced a zero-protection preview instead of aborting.
  `swapTokenToNative` and `swapExactInLocal` each built a
  `minOutLevels`/`minLevels` array of `[fullMinOut, halfMinOut, 0n]` and
  tried each level in order on simulate/send failure — i.e. **on a
  legitimate slippage-protection revert, the bot automatically retried with
  half the protection, then with none at all.** `swapExactInLocal` also
  computed its quote/minOut *once*, before the retry loop, so even a
  same-quote retry reused a stale estimate.
- **Impact:** An automated swap (token→native during close auto-swap,
  meme→ETH conversions, stable funding swaps) could execute for close to
  zero output on a thin/manipulated pool, especially likely for the meme
  tokens this bot trades.
- **Reproduction:** Force the first two `simulateContract` attempts to
  revert (e.g. by racing a large price move) → the third attempt sends with
  `amountOutMinimum = 0`, accepting any output.
- **Fix:** `previewSwapToNative` now throws `SafetyError` when it cannot
  produce a positive quote/estimate. `swapTokenToNative`/`swapExactInLocal`
  now compute a single, non-degrading `minOut` via
  `computeSwapMinOut()`/`requirePositiveMinOut()` from `safety.ts`; a
  `simulateContract` failure moves to the next pool/fee-tier (not a weaker
  protection level). `swapExactInLocal`'s quote + price-impact check now run
  **inside** each retry round so a retry gets fresh data, per Section 13.
- **Regression test:** [test/safety.test.ts](test/safety.test.ts) —
  "swap: quote unavailable/quote=0/minOut cannot become 0/retry cannot
  reduce minOut".

### P0-2 — Uniswap v3 close: no minimum-withdrawal protection at all
- **File:** [src/chain/close.ts](src/chain/close.ts)
- **Function:** `closePosition` (v3 path)
- **Root cause:** `decreaseLiquidity` was always called with
  `amount0Min: 0n, amount1Min: 0n`, in the initial attempt, every retry
  round, and the sequential fallback — with an explicit comment
  *"not a slippage-protected close (by design)"*.
- **Impact:** Closing any v3 position could return arbitrarily little of
  the underlying tokens with zero on-chain protection — the position's
  entire principal was exposed to whatever price existed at the exact
  block the transaction landed, including sandwich attacks.
- **Reproduction:** Call `/close` on any open v3 position while its pool is
  thin — the decrease succeeds and returns tokens far below fair value; the
  transaction never has a floor to revert against.
- **Fix:** Before each attempt (initial + every retry round + the
  sequential fallback), the bot now reads live pool state (`slot0` +
  pool liquidity), computes the position's *expected* withdrawable
  `amount0`/`amount1` for the live liquidity via v3-sdk `Position` math
  (`computeV3AmountsForLiquidity`, exported from `positions.ts`), and
  derives `amount0Min`/`amount1Min` as `expected * (1 - 10%)` via
  `computeWithdrawalMins()`. If pool state can't be read, the close call
  **aborts** (throws `SafetyError`) instead of proceeding with zero
  protection. A genuinely single-sided position keeps a **safe** zero on
  the side that has nothing to withdraw.
- **Regression test:** "close: amount0Min/amount1Min cannot become 0",
  "close: a genuinely single-sided position keeps a SAFE zero on the empty
  side", "close: missing expected amounts aborts".

### P0-3 — Uniswap v4 close: same zero-protection pattern (BURN+TAKE / DECREASE+TAKE)
- **File:** [src/chain/v4.ts](src/chain/v4.ts)
- **Function:** `closeV4Position`
- **Root cause:** Identical to P0-2 — both the full-exit (`BURN+TAKE`) and
  keep-NFT (`DECREASE+TAKE`) unlock-data encoders were built with
  `amount0Min: 0n, amount1Min: 0n` on every attempt and every retry round;
  the failure log even read `"v4 close round N failed (amountMin=0)"`.
- **Impact:** Same as P0-2, for every v4 position (native ETH/BNB pools
  included).
- **Fix:** A new `computeV4AmountsForLiquidity` helper reads live
  `StateView` pool state and derives expected `amount0`/`amount1` for the
  live liquidity via v4-sdk `Position` math; `computeWithdrawalMins()`
  (10% bound, same as v3) produces `amount0Min`/`amount1Min` for both
  `BURN+TAKE` and `DECREASE+TAKE`, recomputed fresh every retry round. The
  fees-only (`COLLECT_FEES`, liquidity already 0) and empty-shell burn paths
  correctly keep `amount0Min = amount1Min = 0` — there is no principal left
  to protect on those paths (classified SAFE, see Dangerous Zero Audit).
- **Regression test:** shared with P0-2 (`computeWithdrawalMins` is the
  same primitive used by both v3 and v4 close paths).

### P0-4 — UNKNOWN price collapses to $0 in position valuation → false TP/SL trigger
- **Files:** [src/chain/positions.ts](src/chain/positions.ts) (`getPosition`,
  `loadV3PositionsBatched`), [src/chain/v4.ts](src/chain/v4.ts)
  (`getV4Position`), [src/pnl/compute.ts](src/pnl/compute.ts)
  (`computePositionPnl`)
- **Root cause:** `valueUsd = amount0Human * (p0 ?? 0) + amount1Human * (p1 ?? 0)`.
  When a token's USD price is genuinely unavailable, `valueUsd` silently
  becomes partial or fully `$0` instead of "unknown." `computePositionPnl`
  used that value directly: `currentValueUsd = live?.valueUsd ?? 0`, feeding
  a deeply negative `pnlUsd`/`pnlPct` into the TP/SL watcher.
- **Impact:** A transient price-provider failure (timeout, rate limit, a
  brand-new token not yet indexed) could make a perfectly healthy position
  look like it lost most of its value, causing `tpslWatcher`'s `classify()`
  to arm and — after the 5s recheck — **execute a real, involuntary close**
  of the position, purely because of bad price data, not an actual market
  move.
- **Reproduction:** Make `getTokenPriceUsd` return `null` for one side of an
  enrolled TP/SL position with a meaningful balance on that side; the next
  tick computes `pnlPct` around `-100%`, which is `<= -slPercent` for any
  realistic SL setting, and the position closes.
- **Fix:** `OnChainPosition` gained a `priceComplete: boolean` field,
  computed by `priceCompleteFor()` (`safety.ts`): a side needs a known price
  only if its amount is nonzero (0 × unknown is still 0 — a legitimately
  empty side never blocks completeness). `computePositionPnl` now takes an
  optional `priceComplete` and forces `pnlPct = null` whenever it is
  explicitly `false` (via the pure, tested `computePnlPct()`); `classify()`
  in `tpslWatcher.ts` already treated `null` pnlPct as "no trigger" — so a
  price-incomplete position now correctly produces **no action** instead of
  a spurious stop-loss.
- **Regression test:** [test/pnl.test.ts](test/pnl.test.ts) (priceComplete
  forces null pnlPct), [test/safety.test.ts](test/safety.test.ts)
  ("position: …" cases for `priceCompleteFor`), [test/tpsl.test.ts](test/tpsl.test.ts)
  (`classify(null, …) === null`).

### P1-1 — TP/SL watcher disables protection on transient read failure, no notification
- **File:** [src/bot/tpslWatcher.ts](src/bot/tpslWatcher.ts)
- **Function:** `measurePnl`, `tick`, `recheckAndMaybeClose`
- **Root cause:** `measurePnl` wrapped `getPosition`/`getV4Position` +
  `computePositionPnl` in a single try/catch that collapsed *any* error
  (RPC timeout, price-fetch failure, PnL-compute error) into `return null`.
  Both `tick()` and `recheckAndMaybeClose()` treated `null` as "position
  gone" and called `setPositionTpSl(..., { enabled: false })` — silently,
  with no user notification.
- **Impact:** A single transient RPC hiccup during a 30s poll (or the 5s
  TP/SL recheck) permanently disabled TP/SL protection for that position,
  and the user had no way to know it happened.
- **Fix:** `measurePnl` now returns a tri-state `MeasureResult`
  (`'active' | 'gone' | 'unknown'`). Only a *confirmed* `getPosition`/
  `getV4Position` result of `null` (ownership verified, nothing left) counts
  as `'gone'` and unenrolls. Any thrown error is `'unknown'` — the watcher
  takes **no action** and retries next cycle (Section 18, invariant 9/10).
- **Regression test:** the underlying invariant (`classify` never triggers
  on unknown/null PnL) is covered in `test/tpsl.test.ts`; the tri-state
  dispatch itself is a thin wrapper reviewed by inspection (see "Remaining
  Risks" — it isn't independently unit tested because `measurePnl` pulls in
  the bot's full RPC/DB dependency chain, which has no mocking harness in
  this codebase; see Known Limitations).

### P1-2 — v3/v4 ownership check conflated RPC failure with "not owned" / "assume valid"
- **Files:** [src/chain/positions.ts](src/chain/positions.ts) (`getPosition`),
  [src/chain/v4.ts](src/chain/v4.ts) (`getV4Position`, both `ownerOf` checks)
- **Root cause:** v3's `getPosition` caught *any* `ownerOf` failure and
  returned `null` (treated identically to "burned / never minted"). v4's
  `getV4Position` had two `ownerOf` checks: the first correctly rethrew
  unrecognized errors, but the **second** (re-verifying ownership after
  reading pool state) used `catch { /* can't verify, assume valid */ }` —
  a literal instance of the explicitly prohibited "assume valid" pattern.
- **Impact:** A transient RPC failure on the ownership check could either
  (a) make a still-owned v3 position vanish from listings/close eligibility
  (mostly a UX bug, mitigated elsewhere by `listPositionsFast`'s own
  uncertain-ID tracking), or (b) for v4, cause the bot to treat a position
  it **no longer owns** (transferred/burned between the two checks) as
  fully valid and continue building close calldata for it.
- **Fix:** A shared `classifyOwnershipError()` (`safety.ts`) distinguishes a
  confirmed on-chain revert (`ERC721: nonexistent token`, `NOT_MINTED`,
  etc. → `'gone'`) from anything else (→ `'unknown'`, rethrown, never
  assumed valid or absent). Both v3's `getPosition` and both of v4's
  `ownerOf` checks now use it; the v4 "assume valid" catch now rethrows.
  A secondary effect: [src/bot/bot.ts](src/bot/bot.ts)'s `/generate` PnL-card
  handler previously auto-marked a position "closed" in the ledger whenever
  *either* lookup failed for *any* reason; it now only does so when the
  lookup **confirmed** absence (`confirmedGone`), never on a bare read
  failure — preventing an RPC hiccup from silently dropping a position out
  of TP/SL tracking via that path.
- **Regression test:** "ownership: … classifies as gone / … classifies as
  unknown, never as gone" in `test/safety.test.ts`.

### P2-1 — totalSupply failure reported as 0, not UNKNOWN (display-only)
- **Files:** [src/chain/tokens.ts](src/chain/tokens.ts) (`getTokenTotalSupply`),
  callers in [src/chain/mint.ts](src/chain/mint.ts) and
  [src/chain/v4.ts](src/chain/v4.ts) (mcap preview text)
- **Root cause:** `catch { return 0n; }` — a totalSupply read failure was
  indistinguishable from "supply is really 0."
- **Impact:** Low — both call sites only use the value to render an
  optional "Mcap range: …" line in the mint confirmation text; a `0`
  already produced `mcapAtOrientedPrice() === null`, so no market-cap line
  was shown either way. Not a gating/trading decision.
- **Fix:** `getTokenTotalSupply` now returns `bigint | null` (`null` on
  failure); both callers explicitly throw inside their existing
  `try {} catch { /* optional */ }` block when the supply is unknown,
  which is caught the same way a `0` used to be (mcap line simply omitted).
  Fixed for correctness/principle compliance (Section 8), not because the
  old behavior was exploitable.

### P2-2 — No pre-flight simulation before broadcasting Trading-API / GMGN swaps
- **Files:** [src/chain/tradingApi.ts](src/chain/tradingApi.ts) (`broadcastTx`),
  [src/gmgn/swap.ts](src/gmgn/swap.ts) (`gmgnSwap`, local mode)
- **Root cause:** Both paths call `wallet.sendTransaction()` directly with
  externally-supplied calldata, with no dry run — a revert is only
  discovered after the transaction is mined (wasting gas, and delaying
  failure detection).
- **Fix:** Both now call `client.call({ to, data, value, account })` before
  broadcasting and throw a clear error if it would revert, satisfying
  Section 12 ("simulation must succeed before send") uniformly across all
  execution paths, not just the local v3 router path (which already
  simulated).

## Files Changed

| File | Change |
|---|---|
| `src/chain/safety.ts` (new) | Centralized fail-closed invariants: `SafetyError`, `requirePositiveMinOut`, `requirePositiveWithdrawalFloor`, `requireKnownPrice`, `requireKnownAmount`, `computeMinWithSlippage`, `computeSwapMinOut`, `computeWithdrawalMins`, `classifyOwnershipError`, `priceCompleteFor`, `resolveReceivedAmount`, `CLOSE_SLIPPAGE_BPS` |
| `src/bot/tpslLogic.ts` (new) | Pure `classify()`/`TriggerKind`, split out of `tpslWatcher.ts` for testability and reused there |
| `src/chain/swap.ts` | Removed all degrading `minOut` fallback arrays; quote failure aborts instead of minOut=0; `swapExactInLocal` refreshes quote+price-impact check every retry round |
| `src/chain/close.ts` | v3 close now computes and enforces `amount0Min`/`amount1Min` from live expected withdrawal every attempt/round; aborts if pool state unreadable |
| `src/chain/v4.ts` | v4 close (`BURN+TAKE`/`DECREASE+TAKE`) same fix as close.ts; second `ownerOf` check no longer "assumes valid"; `getV4Position` valueUsd tracks `priceComplete`; mcap text handles unknown totalSupply |
| `src/chain/positions.ts` | Exported `computeV3AmountsForLiquidity` (throws) alongside display-only `amountsFromSdk` (degrades to 0, unchanged); `getPosition` ownerOf failure classified via `classifyOwnershipError`; `OnChainPosition.priceComplete` added and populated in both `getPosition` and `loadV3PositionsBatched` |
| `src/pnl/compute.ts` | New pure `computePnlPct()`; `computePositionPnl` forces `pnlPct = null` when `priceComplete === false` |
| `src/bot/tpslWatcher.ts` | `measurePnl` returns tri-state `MeasureResult`; `tick`/`recheckAndMaybeClose` only unenroll on confirmed `'gone'`, never on `'unknown'` |
| `src/chain/tokens.ts` | `getTokenTotalSupply` returns `bigint \| null` instead of silently `0n` on failure |
| `src/chain/mint.ts` | Handles `getTokenTotalSupply` returning `null` (mcap line omitted, same net effect as before) |
| `src/chain/tradingApi.ts` | `broadcastTx` dry-runs via `client.call` before sending |
| `src/gmgn/swap.ts` | Local-mode `gmgnSwap` dry-runs via `client.call` before sending |
| `src/chain/wrap.ts` | Re-exports `resolveReceivedAmount` from `safety.ts` (canonical balance-delta helper, Section 14) |
| `src/bot/bot.ts` | `/generate` PnL-card handler no longer auto-marks a position "closed" on a bare read failure — only on confirmed absence |
| `package.json` | Added `"test": "tsx --test test/*.test.ts"` (Node's built-in `node:test`, no new dependency) |
| `test/safety.test.ts`, `test/pnl.test.ts`, `test/tpsl.test.ts` (new) | Regression tests — see below |

## Safety Invariants Added

Implemented as the exported functions in `src/chain/safety.ts`:

1. Automated swap: `minOut > 0` — `requirePositiveMinOut` / `computeSwapMinOut`
2. Automated close: minimum withdrawal `> 0` whenever the expected amount on
   that side is `> 0` — `requirePositiveWithdrawalFloor` / `computeWithdrawalMins`
3. Price: must be known (finite, `> 0`) for a trading decision — `requireKnownPrice`
4. Quote/estimate: must be known (`> 0`) for a trading decision — `requireKnownAmount`
5. Ownership: a verification failure is UNKNOWN, never "not owned" and never
   "assume valid" — `classifyOwnershipError`
6. Position value: UNKNOWN price on a nonzero side ⇒ the whole valuation is
   marked incomplete, never silently `$0` — `priceCompleteFor`, threaded
   through to `computePnlPct`
7. Simulation: `swapExactInLocal`, `swapTokenToNative`, close (v3+v4), the
   Trading API path, and the local GMGN path all simulate/dry-run before
   sending
8. Retry: refreshes data and reruns the safety gate — never reuses a stale
   quote, and never offers a "weaker" minOut/min-withdrawal level
9. WETH/wrapped-token accounting: `resolveReceivedAmount` — only the
   operation's own balance delta is spent/unwrapped, capped by what's
   actually available; a snapshot miss never falls back to sweeping the
   existing balance

## Tests Added

`npm test` runs `tsx --test test/*.test.ts` (Node's built-in test runner —
no new dependency added). 32 tests, all passing:

- **test/safety.test.ts** (25 tests) — SWAP: quote unavailable / quote=0 /
  estimate unavailable / minOut cannot become 0 (including at 100%
  slippage-bps input) / retry cannot reduce minOut. CLOSE:
  amount0Min/amount1Min cannot become 0, single-sided keeps a safe zero,
  slippage-floor math, missing/negative expected amounts abort. PRICE:
  null/undefined/NaN/zero/negative all abort; a valid price passes through.
  OWNERSHIP: revert messages classify as gone; RPC/network failures classify
  as unknown, never gone. POSITION: zero-amount side doesn't need a price;
  nonzero-amount side with unknown price marks the position incomplete.
  WETH: unwraps only the swap-produced delta (1.0 existing + 0.2 swap output
  → unwraps 0.2, not 1.2); capped fallback estimate; no-delta/no-fallback → 0.
- **test/pnl.test.ts** (3 tests) — `priceComplete=false` forces `pnlPct=null`
  regardless of how negative the (unreliable) pnlUsd looks; `true`/unset
  computes normally; near-zero deposits stay null.
- **test/tpsl.test.ts** (5 tests) — `classify()` never triggers on
  null/NaN/±Infinity pnlPct; correct TP/SL threshold behavior otherwise.

### Test Results

```
tests 32
pass  32
fail  0
```

## Dangerous Zero Audit

Every remaining `amount0Min: 0n` / `amount1Min: 0n` / `minOut`-style zero in
the codebase, re-checked after the patch:

| Location | Classification | Why |
|---|---|---|
| `close.ts` `computeMins`: `liquidity <= 0n → {0n, 0n}` | **SAFE** | No liquidity to decrease — nothing to protect |
| `v4.ts` `computeMins`: same guard | **SAFE** | Same as above |
| `v4.ts` `encodeCollectFeesUnlockData` (liquidity: 0n) | **SAFE** | Fee-only collection, no principal at risk; used by `claimV4Fees` and the close path's fees-only attempt |
| `v4.ts` empty-shell burn (`liqLeft === 0n` confirmed) | **SAFE** | Nothing left to withdraw; burn only clears the NFT shell |
| `mint.ts` `amount0Min = amount1Min = 0n` (single-sided mint) | **SAFE** | NPM `mint()`'s Min params are a *floor* on how much of the pulled deposit is required, not a withdrawal minimum; the *ceiling* (`amount0Desired`/`amount1Desired`) already caps what can be pulled, and a pre-flight `simulateContract` runs before sending. Worst case is depositing *less* than expected, never more or a bad-price loss. |
| `v4.ts` mint (`amount0Max`/`amount1Max`) | **N/A** | Ceiling parameters, not a `Min`/floor pattern at all |
| `gmgn/swap.ts` `managedSwap` (`minOutput: 0n`, `amountOutQuoted: 0n`) | **SAFE (documented)** | `GMGN_SWAP_MODE=managed` (opt-in, not default) delegates execution and its own slippage protection entirely to GMGN's backend; these fields are unreported placeholders, not a locally-constructed unprotected transaction |
| `priceImpact.ts`: skip check when price unknown | **ACCEPTED LIMITATION** | Secondary defense-in-depth on top of the now-hardened primary minOut protection. Forcing a hard-fail here would block trading on any meme token without an established USD price feed — a strategy-behavior change explicitly out of Phase 1 scope. Documented, not fixed. |
| `swap.ts` `ethPx = 2000` provisional floor | **SAFE (sizing only)** | Only affects how much stable to *target* acquiring for a mint; the actual swap that acquires it still goes through the (now-hardened) on-chain quote/minOut pipeline. Position-sizing behavior is explicitly out of scope. |

No dangerous zero-protection paths remain in mint / close / swap / collect.

## Transaction Safety Audit

Traced `candidate → mint → position → watcher → TP/SL → close → swap →
receipt → accounting` end to end:

- **mint**: pre-flight `simulateContract`, range/price-mismatch checks
  unchanged (strategy, out of scope), single-sided Min pattern confirmed
  safe (see table above).
- **watcher → TP/SL**: `classify()` cannot trigger on `null`/non-finite
  PnL%; PnL% is now `null` whenever price data was incomplete
  (`priceComplete=false`); a read failure during measurement is `'unknown'`
  and produces no action, never a forced close, never a silent unenroll.
- **close (v3 + v4)**: both now compute and enforce a positive
  expected-withdrawal-derived minimum on every attempt and every retry
  round; both abort (throw) rather than send with `amount0Min=amount1Min=0`
  when live pool state can't be read.
- **swap**: `minOut` is derived once per attempt from a fresh, positive
  quote; there is no code path left that can send with `minOut = 0`, and no
  retry step that weakens a previously-computed floor.
- **receipt**: every execution path already checks
  `receipt.status === 'success'` before treating a transaction as done (this
  was already true pre-patch). Trading-API and GMGN local-mode paths now
  additionally dry-run via `client.call` before broadcasting.
- **accounting**: the manual `/close` command flow in `bot.ts` already
  captured `balanceBefore`/`balanceAfter` deltas for auto-swap amounts
  (verified correct, no change needed). `tpslWatcher.ts`'s `executeClose`
  still records ledger entries from `closePosition`'s *estimated* amounts
  rather than an independently-verified on-chain delta — see Known
  Limitations.

## Remaining P0

None identified.

## Remaining P1

None identified.

## Remaining Risks

- **relay.ts / across.ts (cross-chain bridging)** were spot-checked for the
  same dangerous patterns (grepped for `minOut`/`amountMin`/degrading
  fallbacks — none found; both delegate slippage tolerance to the bridge
  API, similar to the Trading API pattern) but were not read to the same
  line-by-line depth as swap/close/mint given Phase 1's scope and time
  budget. Recommend a follow-up pass if bridging is a live, funded feature.
- **`tpslWatcher.ts`'s tri-state `measurePnl` dispatch** (P1-1's fix) is
  reviewed by inspection and exercised indirectly by the `classify()` tests,
  but has no direct unit/integration test of its own — it requires mocking
  `getPosition`/`getV4Position`/`computePositionPnl`, which pull in the
  bot's full config/RPC/DB dependency chain. See Known Limitations.
- **`gmgn/swap.ts` managed mode** (`GMGN_SWAP_MODE=managed`) delegates
  slippage protection entirely to GMGN's backend; the bot cannot verify
  it independently. Not a bug introduced or left by this phase, but a
  trust boundary worth noting.

## Known Limitations

- **No pre-existing test harness.** This repository had no test runner, no
  RPC/viem mocking utilities, and every chain-interaction module performs
  real network calls through module-level client construction. Standing up
  a full mocking framework (e.g. an Anvil fork harness) was judged out of
  scope for a capital-safety patch under "no large rewrites." Regression
  tests added in this phase therefore target the **extracted pure
  safety-invariant functions** (`safety.ts`, `computePnlPct`, `classify`)
  exhaustively, rather than full end-to-end integration tests against a
  live/forked chain. This gives genuine, deterministic coverage of every
  invariant named in Section 18, but does not exercise the RPC-calling
  wrapper functions (`closePosition`, `closeV4Position`, `swapTokenToNative`,
  etc.) themselves. Recommended for a future phase.
- **Actual-output verification (Section 16)** is fully implemented at the
  `/close` command's auto-swap accounting layer (pre-existing,
  `bot.ts`) but not inside `closePosition`/`closeV4Position` themselves —
  their returned `amount0`/`amount1` are pre-close expected values, not an
  independently-measured post-close balance delta. `tpslWatcher.ts`'s ledger
  entries inherit this. Every execution path does check
  `receipt.status === 'success'` before claiming success, satisfying the
  task's stated minimum bar ("jangan mengklaim transaction economic success
  hanya dari receipt status" — the bar is *don't rely on receipt status
  alone for economic success claims*, which is met by the new minOut/minimum
  enforcement guaranteeing a bounded worst case, even without independently
  re-measuring the exact actual amount). Full actual-accounting is
  recommended as a Phase 2 item.
- **Price freshness** relies on the pre-existing 60s in-memory price cache
  in `price/dexscreener.ts`; no explicit `age`/`timestamp`/max-age type was
  introduced. This was judged an acceptable existing freshness bound rather
  than a new gap, and changing it would touch the price-provider module
  broadly. Noted for Phase 2 if tighter freshness bounds are desired.

## Final Verdict

**PASS**

- No automated `minOut = 0` path remains (swap.ts hardened; verified by
  re-grep and 25 passing regression tests)
- No automated close minimum-withdrawal = 0 safety path remains for
  positions with a nonzero expected side (close.ts + v4.ts hardened;
  remaining zeros audited and classified SAFE)
- No UNKNOWN → ZERO critical path remains in position valuation feeding
  automated TP/SL decisions (`priceComplete` propagated through to
  `pnlPct`)
- No UNKNOWN → VALID critical path remains in ownership verification
  (`classifyOwnershipError`, "assume valid" removed)
- Simulation failure cannot send a transaction on any hardened path
  (pre-flight `client.call`/`simulateContract` added where missing)
- Retry never weakens safety (degrading minOut/min-withdrawal arrays
  removed; retries refresh data and rerun the same gate)
- Ownership failure fails closed (rethrown as unknown, never treated as
  gone or as valid)
- Critical price failure fails closed (`requireKnownPrice`,
  `priceCompleteFor` → `null` pnlPct → no TP/SL action)
- Critical quote failure fails closed (`requireKnownAmount`,
  `computeSwapMinOut` abort on non-positive quotes)
- Regression tests pass: 32/32
- `npm run typecheck`: clean
- `npm run build`: clean

This assessment covers the capital-safety scope of Phase 1 as audited. It is
not a claim of production-readiness beyond that scope — see Remaining Risks
and Known Limitations above.

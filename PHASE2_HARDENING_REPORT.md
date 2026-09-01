# PHASE 2 (Part 1) — Execution Hardening: Nonce Safety + Slippage Telemetry

Scope of this pass, per explicit user direction: prioritize **retry & nonce
safety** and **slippage** (as telemetry, not a value change) to completion
before moving to the remaining Phase 2 items. No MULTI. No strategy/GMGN
screening/sizing changes. Architecture preserved.

## Audit Summary — all 11 Phase 2 focus areas

Full audit performed before any code change (including a full read of
`relay.ts` and `across.ts`, spot-checked only in Phase 1).

| Area | Status after this pass |
|---|---|
| Real executable quote | **Deferred.** Local swap path (`estimateAmountOut`) uses a rough slot0-only formula, not a real Quoter simulation. Trading API/GMGN/Relay/Across already quote from their backend. |
| Price impact | OK (Phase 1) — now also logged into telemetry for the local swap path. |
| Slippage | **Telemetry added this pass** (see below). No values changed — flat constants (`DEFAULT_SWAP_SLIPPAGE_BPS=1500`, `CLOSE_SLIPPAGE_BPS=1000`, per-caller defaults like the 5% used for stable/WETH pairs) are unchanged, by design, per your direction. |
| Actual output verification | **Extended this pass** for the four local execution paths (see below); Trading API/GMGN/Relay/Across paths still return quote-derived amounts, not measured. |
| Gas estimation | **Deferred.** Still hardcoded (`gas: 900_000n`-style) in swap/close/v4/mint. Bridging paths already estimate correctly. |
| Transaction state/recovery | **Deferred.** No persisted pending-op journal yet. |
| Retry & nonce safety | **Fixed this pass** (see below). |
| Price freshness | **Deferred** (typing). Functionally bounded already by the existing 60s price cache; no code path uses an unboundedly stale price. |
| Trading API simulation | OK (Phase 1) |
| GMGN managed/local | OK (Phase 1) — managed mode remains a documented trust boundary |
| Cross-chain/bridge audit | Read `relay.ts` + `across.ts` in full this pass. Both delegate slippage/minOut to their backend's calldata, both check `receipt.status`, both already avoid local gas hardcoding. No dangerous-zero pattern. `getRelayQuote`'s `slippageBps` param exists but is never actually passed by any caller — bridges/swaps use Relay's own default tolerance (noted, not fixed — out of this pass's priority). |

## 1. Retry & Nonce Safety — Fixed

### Finding
No nonce manager, no mutex/queue anywhere in the codebase serializing
wallet-writing calls. `viem`'s `privateKeyToAccount` was constructed
without a `nonceManager`. Every `wallet.writeContract`/`wallet.sendTransaction`
call independently fetches the "pending" nonce from the RPC at send time.

**Concrete race:** `tpslWatcher.ts` arms a TP/SL trigger and schedules its
confirmation via an independent `setTimeout(..., CONFIRM_MS)` per position.
If two different positions on the same chain/wallet both confirm within the
same few hundred milliseconds, their `closePosition` calls can both reach
`wallet.writeContract` concurrently. Both read the RPC's "pending" nonce
before either broadcast is visible to the node — a real, reachable
nonce collision (one send fails "nonce too low", gets stuck, or
unexpectedly replaces the other). The same risk applies to a manual bot
command racing the watcher, or two bridging steps in `relay.ts`/`across.ts`.

### Fix
New [`src/chain/txLock.ts`](src/chain/txLock.ts): a minimal per-key
promise-chain queue (`withTxLock(key, fn)`), documented as intentionally
non-reentrant (only ever called from the wrapper below, never nested).

Wired in exactly once, in [`src/chain/clients.ts`](src/chain/clients.ts)'s
`getWalletClient`: immediately after each wallet client is created, its own
`sendTransaction` and `writeContract` methods are reassigned to versions
that acquire the `${chainId}:${walletId}` lock before calling the original
method. Because every existing call site across the codebase (mint, close,
swap, TP/SL, bridging, revoke, transfer, wrap/unwrap) already calls
`wallet.sendTransaction(...)`/`wallet.writeContract(...)` as object methods
on the client returned by `getWalletClient`, **every one of them is now
automatically serialized with zero changes to any of those files.**

The lock is keyed by `(chainId, walletId)`, not just `chainId`, so it
correctly does not over-serialize two genuinely different wallets sending
on the same chain (the multi-wallet store supports switching/multiple
stored wallets).

Scope of the lock is deliberately tight: it covers only the nonce-fetch
through broadcast (the actual `sendTransaction`/`writeContract` call), not
`simulateContract` or `waitForTransactionReceipt` — so unrelated operations
can still simulate and wait for confirmation concurrently; only the
nonce-sensitive instant is serialized.

### Regression tests
[test/txLock.test.ts](test/txLock.test.ts) — 4 tests: same key serializes
(second task provably starts only after the first ends), different keys
run concurrently (not falsely serialized), a rejected task doesn't poison
the queue for the next task on the same key, and per-call results/errors
are preserved independently under contention.

## 2. Slippage — Telemetry Added, No Values Changed

### Your question, answered directly
> Berapa slippage maksimum yang benar-benar diperlukan untuk setiap tipe
> transaksi, dan apakah bot bisa membatasi slippage berdasarkan kondisi
> pool/token tanpa memperlemah proteksi ketika retry?

**Mechanically: yes** — an impact-derived dynamic bound (slippage tied to
the trade's own measured price impact, capped by the existing ceiling) is
technically straightforward and was scoped out in this session's audit as
the recommended design (see the earlier turn's proposal). It would not
weaken retry protection: it's computed once per attempt from fresh pool
state, feeding the exact same non-degrading `computeSwapMinOut`/
`computeWithdrawalMins` choke points Phase 1 already locked down — only the
`slippageBps` *input* would become smarter, not the invariant.

**But the actual numbers cannot be honestly justified yet.** You were right
to hold off: picking a tighter bound (or even calibrating the dynamic
formula's buffer/floor/ceiling) requires knowing what slippage this bot's
trades *actually* realize, on the actual pools it trades, and this
codebase had **zero execution telemetry** — no record of estimated vs.
actual output for any past trade. Any number I proposed now (1%, 2%, an
"impact × 1.5 + buffer" formula) would be exactly the kind of unfounded
guess you asked me not to make.

So this pass ships the prerequisite instead: **telemetry that makes a
future data-driven answer possible**, with the flat constants completely
unchanged.

### What was added
- **DB layer** ([src/db/index.ts](src/db/index.ts)): a new
  `execution_telemetry` collection (capped at 5,000 rows, oldest trimmed) —
  `recordExecutionTelemetry()` / `listExecutionTelemetry()`. Best-effort:
  a telemetry write failure is caught and logged, never allowed to fail the
  trade it's describing.
- **Analysis primitive** ([src/chain/safety.ts](src/chain/safety.ts)):
  `computeRealizedSlippageBps(estimatedRaw, actualRaw)` — the pure metric
  ("how many bps worse/better was the actual result than the pre-trade
  estimate") that a future calibration pass would aggregate across trades,
  bucketed by pool liquidity/TVL, to answer your question with data instead
  of a guess.
- **Wired into the four local execution paths** where the bot itself
  controls the slippage bound (the ones actually relevant to calibrating
  *our* constants — Trading API/GMGN/Relay/Across delegate slippage to
  their own backend and were left out of this pass's telemetry, noted as a
  scoping decision):
  - `swapTokenToNative` (swap.ts) — native-out leg, `DEFAULT_SWAP_SLIPPAGE_BPS`
  - `swapExactInLocal` (swap.ts) — token-out leg, plus the price-impact bps that was already computed for the safety gate
  - `closePosition` v3 (close.ts) — both token legs, `CLOSE_SLIPPAGE_BPS`
  - `closeV4Position` (v4.ts) — both legs (native-aware: a native currency leg reads wallet native balance, not an ERC-20 `balanceOf`), `CLOSE_SLIPPAGE_BPS`

Each records: chain, op type, dex, slippage bps actually used, price-impact
bps estimate (when computed), and per leg — the pre-trade *estimated*
amount, the enforced *minimum*, and the *actual* amount received (measured
via a `balanceBefore`/`balanceAfter` delta captured around the send,
reusing Phase 1's `resolveReceivedAmount`; `null` when unmeasurable, never
silently defaulted to the estimate). This also **extends actual-output
verification** (item 4 of the Phase 2 list) for these four paths, beyond
Phase 1's existing coverage at the `bot.ts` `/close` command level.

### Regression tests
`computeRealizedSlippageBps` — 5 cases in
[test/safety.test.ts](test/safety.test.ts): worse-than-estimate (positive
bps), exact match (0), better-than-estimate (negative bps), unmeasurable
actual → `null` (never fabricates a number), no estimate → `null`. The DB
read/write layer itself (`recordExecutionTelemetry`/`listExecutionTelemetry`)
is not independently unit tested — consistent with Phase 1's documented
limitation (no RPC/env mocking harness in this repo; `db/index.ts` requires
live config that isn't available in a bare test run). It's covered by
inspection and by the fact that it's wrapped in its own try/catch so a
failure there is inert with respect to the trade.

### How to use this data later
Once enough live (or paper) trades accumulate,
`listExecutionTelemetry({opType, chainId})` returns everything needed to,
per pool-liquidity bucket: compute the distribution of
`computeRealizedSlippageBps` for each leg, and see how far actual results
sat from both the estimate and the enforced minimum. That's the OOS
evidence base for revisiting `DEFAULT_SWAP_SLIPPAGE_BPS`/`CLOSE_SLIPPAGE_BPS`
— a follow-up pass, not this one.

## Files Changed

| File | Change |
|---|---|
| `src/chain/txLock.ts` (new) | Per-`(chain, wallet)` send serialization primitive |
| `src/chain/clients.ts` | Wraps `sendTransaction`/`writeContract` on every created wallet client with `withTxLock` |
| `src/chain/safety.ts` | `computeRealizedSlippageBps` |
| `src/db/index.ts` | `execution_telemetry` store, `recordExecutionTelemetry`, `listExecutionTelemetry`, `ExecutionOpType`/`ExecutionTelemetryLeg`/`ExecutionTelemetryEntry` types |
| `src/chain/swap.ts` | `swapTokenToNative` + `swapExactInLocal` capture balance-before/after and record telemetry; `swapExactInLocal`'s price-impact check now also captures the impact bps for telemetry |
| `src/chain/close.ts` | `closePosition` (v3) captures balance-before/after (both legs) and records telemetry |
| `src/chain/v4.ts` | `closeV4Position` captures balance-before/after (both legs, native-currency-aware) and records telemetry |
| `test/txLock.test.ts` (new) | 4 nonce-serialization tests |
| `test/safety.test.ts` | +5 `computeRealizedSlippageBps` tests |

## Test Results

```
tests 41
pass  41
fail  0
```
`npm run typecheck`: clean. `npm run build`: clean.

## Deferred to Next Pass (per your prioritization)

1. Real executable quote (local Quoter integration)
2. Gas estimation (replace hardcoded `gas:` constants with `estimateContractGas` + padding, fallback to current constants only if estimation itself fails)
3. Price freshness explicit typing (`{price, age, source}`) for the TP/SL valuation path
4. Transaction state/recovery journal (persisted pending-op log for crash recovery)
5. Actual output verification completion for Trading API / GMGN / Relay / Across paths
6. The slippage *value* question itself — once telemetry has accumulated real fill data

## Final Verdict (this pass's scope)

**PASS** for retry/nonce safety and slippage telemetry:
- No two wallet writes on the same (chain, wallet) can race on nonce — enforced structurally, not by convention, and tested.
- No slippage-protection invariant from Phase 1 was touched or weakened.
- No slippage value was changed on a guess — the honest answer to "what's the right number" is "we don't have the data yet," and this pass builds the mechanism to get it.
- 41/41 tests pass, typecheck clean, build clean.

This is not a claim that Phase 2 is complete — 5 items remain deferred by
your own choice, listed above for the next pass.

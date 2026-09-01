# Phase 2 Part 4 Audit — Transaction Recovery + Explicit Price Freshness

Scope: (A) a transaction state machine and recovery journal so an
ambiguous broadcast (RPC timeout/connection failure after
`sendTransaction`/`writeContract` may have already reached the node) can
never trigger an automatic retry until its true outcome is known; (B) an
explicit `{ok, price, source, timestamp}` freshness contract for every
critical (automated-decision) price consumer, replacing implicit,
opaque caching. Plus: fix the decimals bug found in Part 3's
`estimateAmountOut()`, remove the dead `attempts` array found in Part 3's
`v4.ts`, and review every gas-estimation fallback for safety.

No changes were made to GMGN screening, candidate strategy, MC filters,
token age, range strategy, TP/SL thresholds, position sizing, slippage
constants, pool scoring, USDG, or trailing TP. MULTI was not implemented.

---

## 1. Transaction state machine

```
CREATED → SIMULATED → GAS_ESTIMATED → BROADCAST_UNKNOWN → SUBMITTED
                                            │                  │
                                            │                  ├─→ MINED_SUCCESS → CONFIRMED
                                            │                  └─→ MINED_REVERT
                                            └─→ RECOVERY_REQUIRED   NOT_SUBMITTED
```

`CREATED`/`SIMULATED`/`GAS_ESTIMATED` are **not persisted** — nothing has
been broadcast at those points (this bot's existing `simulateContract` →
`estimateWriteGas` → `writeContract` pipeline from Phases 1–3 already
covers them), so a crash there has nothing to recover; the operation
simply restarts from scratch on the next attempt. The journal
(`db/index.ts`'s `TxJournalState`, `chain/txRecovery.ts`'s logic) tracks
only the ambiguous window: `BROADCAST_UNKNOWN` (written right before the
broadcast RPC call, pessimistic default) through to a definitively known
outcome — `CONFIRMED`, `MINED_REVERT`, `NOT_SUBMITTED`, or
`RECOVERY_REQUIRED` (ambiguity that bounded recovery could not resolve).

## 2. Recovery architecture

New module [`src/chain/txRecovery.ts`](src/chain/txRecovery.ts) — pure,
dependency-injected, fully unit-testable without live RPC or config/db
(matching the `MinimalReadClient`/`MinimalGasClient` DI pattern already
established in `quote.ts`/`gas.ts`):

- **`classifyBroadcastError(e)`** — `'NOT_SUBMITTED'` only for errors that
  are provably pre-network (insufficient funds, invalid address/signature/
  params, nonce-too-low, intrinsic-gas-too-low — all rejected by the node
  or client before the tx could enter the network). Everything else
  (timeouts, connection resets, unrecognized RPC errors) is `'AMBIGUOUS'`
  by design — fail-closed, per the task's explicit instruction not to
  assume "RPC error = failed".
- **`waitForReceiptBounded` / `pollReceiptOnce`** — hash-first recovery:
  bounded polling (6 attempts, 2s/4s/6s/…/12s backoff) for a receipt.
  `MINED_SUCCESS`/`MINED_REVERT` resolve immediately; a receipt-lookup RPC
  error is treated as `PENDING`, never as "reverted". Still pending after
  the bounded window returns `PENDING` (unresolved — not assumed either
  way).
- **`checkNonceConsumed` / `resolveAmbiguousTx`'s nonce path** —
  nonce-first recovery when no hash exists: bounded polling (5 attempts,
  2.5s/5s/…/12.5s backoff) of the account's pending nonce. Only a nonce
  that has **not** advanced across every check in the bounded window is
  trusted as `NOT_SUBMITTED` (a single "not yet visible" read doesn't
  prove non-submission — mempool propagation can lag); an RPC error
  resets the not-consumed streak rather than letting a flaky read race to
  a false "safe". A nonce that **did** advance resolves to
  `RECOVERY_REQUIRED`, never `NOT_SUBMITTED` — see §5.
- **`markNoRetry` / `isNoRetryTxError`** — attaches a duck-typed marker
  (no import cycle) that `retry.ts`'s `withRetries` checks **before**
  evaluating any `shouldRetry` (default or caller-supplied) and refuses to
  retry regardless. This is the actual retry-policy enforcement point —
  see §6.

Orchestration (real persistence + real clients) lives in
[`src/chain/clients.ts`](src/chain/clients.ts)'s `journalledSend()`,
wrapped around the exact same choke point `txLock.ts` already uses
(`c.sendTransaction`/`c.writeContract`, wired once in `getWalletClient`) —
every existing local-tx call site (mint, close v3/v4, swap, TP/SL,
bridging, revoke, transfer, wrap/unwrap) is covered automatically, with
**zero per-call-site changes** required anywhere else in the codebase.

## 3. Persistence

`db/index.ts` gained a `tx_journal` array (same synchronous
JSON-file-store pattern as `execution_telemetry`) and `TxJournalState`/
`TxJournalEntry` types. Each row: `{id, chainId, wallet (address only —
never a private key), nonce, txHash, action, state, createdAt, updatedAt,
errorMsg?}`.

`createTxJournalEntry()` is called **before** the broadcast RPC call
(`journalledSend`, §2) — the entry exists, durably, on disk, before the
network call that might throw ambiguously is even attempted. If the
process crashes between that write and the RPC responding, the journal
still has the attempted nonce recorded, enabling nonce-based recovery on
restart (§4).

Journal-write failures (e.g. disk I/O error) are handled defensively:
a persist failure right after a **successful** broadcast does not turn a
genuine success into a thrown error the caller might mistake for a
failure and retry (the hash is still returned; the journal entry simply
stays `BROADCAST_UNKNOWN` until the next recovery pass resolves it via
that same hash). A persist failure inside the ambiguous-error path never
masks the underlying classification or the no-retry marking that actually
propagates to the caller.

Row growth is bounded (`MAX_TX_JOURNAL_ROWS = 2000`), trimming only
**terminal** rows (`NOT_SUBMITTED`/`MINED_SUCCESS`/`MINED_REVERT`/
`CONFIRMED`) oldest-first — an unresolved row is never dropped regardless
of age.

## 4. Startup recovery

`clients.ts`'s `runStartupTxRecovery()` is called from
[`src/index.ts`](src/index.ts)'s `main()`, **before** `bot.start()` (and
therefore before the TP/SL watcher's first tick, which is scheduled 8s
after `startTpslWatcher(bot)` runs, itself called after startup recovery
completes). It loads every journal row in `BROADCAST_UNKNOWN`/
`SUBMITTED`/`RECOVERY_REQUIRED`, resolves each via `resolveAmbiguousTx`
against a real `getPublicClient`, and persists the outcome. A recovery
failure for one entry (e.g. that chain's RPC is down) is caught and
logged — it does not abort startup or block recovery of entries on other
chains/wallets.

Belt-and-suspenders: even if startup recovery is skipped entirely (a
future refactor removes the call, or it throws before completing),
`journalledSend`'s own pre-send gate (§5) independently re-checks and
re-attempts recovery on every subsequent send attempt for the affected
wallet/chain — there is no window where an unresolved transaction is
silently forgotten.

## 5. Duplicate prevention

`journalledSend` checks `listUnresolvedTxJournal({chainId, wallet})`
**before** writing a new journal entry or attempting a new send. If any
unresolved entries exist, it first tries opportunistic recovery on each
(cheap and safe to repeat); if any remain unresolved afterward, it
**refuses the new send outright** with an explicit error naming the
blocking journal id(s) — directly implementing "do not open a new
position or retry a swap until unresolved transaction state is resolved
or explicitly quarantined." Because this check runs inside the same
`withTxLock` queue that already serializes all sends per (chainId,
wallet), it is atomic with respect to any other concurrent send attempt
for that account.

The critical case — nonce consumed but no hash known — always resolves to
`RECOVERY_REQUIRED`, never `NOT_SUBMITTED` (test 10, §14): since this
wallet's sends are fully serialized by `txLock` (only one in-flight
broadcast per wallet/chain, ever, from this bot), nothing else could have
consumed that nonce except the ambiguous attempt itself — but with no
hash to check success vs. revert, guessing either way is refused. This is
the core duplicate-prevention guarantee: a transaction that *might* have
landed is never treated as safe to resend.

## 6. Retry policy

Enforced in two places:

1. **`retry.ts`'s `withRetries`** — checks `isNoRetryTxError(e)` (a
   duck-typed marker check, no import cycle) **before** any `shouldRetry`
   logic, default or caller-supplied. An error marked this way is never
   retried, full stop — this holds even for `close.ts`/`v4.ts`'s own
   custom `shouldRetry` regexes, since the veto is unconditional and
   upstream of them.
2. **`journalledSend`** only ever rethrows a *plain* (unmarked) error when
   `resolveAmbiguousTx` resolves to `NOT_SUBMITTED` — every other outcome
   (`CONFIRMED`, `MINED_REVERT`, `RECOVERY_REQUIRED`, still-`SUBMITTED`/
   pending) is rethrown via `markNoRetry`.

Net effect: **NOT_SUBMITTED** (either classified immediately as a
pre-network rejection, or confirmed via bounded nonce-checking) is the
only state a retry loop is ever allowed to act on. `BROADCAST_UNKNOWN`,
`SUBMITTED` (still pending), and `RECOVERY_REQUIRED` are never retried —
exactly the task's required policy.

## 7. Price freshness architecture

`src/price/dexscreener.ts` gained:

- **`PriceResult`** — `{ok:true, price, source, timestamp} | {ok:false,
  reason}`. Every cache entry now also stores a `source` label
  (`'stable-peg'` for USDG/USDT/USDC pegs, `'dexscreener'` for a live
  quote, `'dexscreener-eth-mainnet-fallback'` for the WETH/WBNB
  last-resort branch) alongside its existing `at` timestamp.
- **`MAX_CRITICAL_PRICE_AGE_MS`** — **90 seconds**, a deliberately
  conservative *temporary* value (env-overridable via
  `MAX_CRITICAL_PRICE_AGE_MS`), not a calibrated production number — see
  §16. Chosen to sit above the existing 60s DexScreener cache TTL plus the
  30s TP/SL poll interval, so it doesn't fight normal caching under
  regular operation while still catching a genuinely stuck price feed.
- **`getCriticalTokenPriceUsd(chainId, token, maxAgeMs?)`** — the
  critical-path lookup. Returns the full `PriceResult` contract; if the
  cached/fetched entry is older than `maxAgeMs` it forces one bypass-cache
  refresh, and only returns `ok:true` if that refresh is itself fresh —
  otherwise `ok:false` (never a stale number). Wraps its entire body in a
  try/catch so a thrown network/RPC exception resolves to `ok:false`
  rather than propagating as an uncaught rejection.

The original `getTokenPriceUsd()` (bare `number | null`, used by 15+
display-only call sites — `/wallet`, `/tokens`, settings previews,
mint-preview mismatch warnings) is **unchanged** — those are informational
displays a human reads before acting, not automated-decision inputs, and
were reviewed and confirmed non-critical (§16).

## 8. TP/SL behavior

Wired `getCriticalTokenPriceUsd` into the two functions that actually feed
TP/SL's trigger decision — `chain/positions.ts`'s `getPosition()` and
`chain/v4.ts`'s `getV4Position()` — replacing their direct
`getTokenPriceUsd()` calls for `p0`/`p1`. A stale-or-unavailable price now
becomes `p0`/`p1 = null`, which `safety.ts`'s pre-existing
`priceCompleteFor()` already treats as **UNKNOWN** (not $0): `valueUsd`
computation is unaffected in shape, but `priceComplete` becomes `false`,
which `pnl/compute.ts`'s `computePnlPct()` already turns into `pnlPct =
null`, which `bot/tpslLogic.ts`'s `classify()` already treats as "never
triggers TP or SL." **No changes were needed to `tpslLogic.ts` or
`tpslWatcher.ts` themselves** — staleness now flows through the exact
same UNKNOWN pipeline Phase 1 already built for missing prices, rather
than requiring a parallel mechanism.

Verified (pre-existing, re-confirmed during this audit, not changed):
`tpslWatcher.ts`'s `tick()` and `recheckAndMaybeClose()` both explicitly
treat `measurePnl()`'s `'unknown'` status as **no action, keep watching**
— never as a reason to close (`'unknown' → SL`) and never as a reason to
unenroll/disable the watcher (`'unknown' → disable`). Only a clean
`'gone'` status (verified ownership/empty, not an error) unenrolls a
position.

## 9. PnL price separation

`pnl/compute.ts`'s `computePositionPnl()` was reviewed for the
historical-vs-current mixing risk the task named directly. It already
keeps the two cleanly separate, structurally:

- **Historical** (`depositsUsd`, `withdrawalsUsd`, `feesClaimedUsd`) comes
  from the local ledger (`getLedgerEntries`/`sumLedger`), repriced via
  `repriceDepositsUsd()` — a call to the plain (non-critical)
  `getTokenPriceUsd()`, appropriate here since these are accounting
  entries being redenominated, not a live execution decision.
- **Current** (`currentValueUsd`, `unclaimedFeesUsd`) comes from the
  `live` parameter — always a **fresh** `OnChainPosition` fetched moments
  earlier by the caller (`getPosition`/`getV4Position`, §8's now
  freshness-checked path), never a cached/stored historical figure.

`pnlUsd = currentValueUsd + unclaimedFeesUsd + withdrawalsUsd +
feesClaimedUsd - depositsUsd` combines them arithmetically (by design —
that's what "PnL since open" means), but never substitutes one for the
other. No code path found that uses a ledger-stored historical price as
the current close **execution** price (close.ts/v4.ts's actual withdrawal
minimums are computed from live pool state via `v3-sdk`/`v4-sdk` position
math, not from DexScreener USD prices at all — unchanged from Phase 1).

## 10. Gas fallback decisions

Per-call-site review of all 25 `estimateWriteGas` fallback values (§15 of
the task). Phase 2 Part 4 changed the *mechanism* — one bounded retry (400ms
backoff) of the live estimate before falling back, so a single transient
blip no longer immediately degrades to the fallback constant — but
deliberately did **not** remove any fallback in favor of an outright
ABORT. Reasoning applies uniformly and is documented once here rather than
per-site: every fallback is reached **only after `simulateContract` with
the identical call already succeeded** (unchanged since Phase 3) — the
transaction is known-executable; a subsequent `estimateContractGas`
failure (now retried once) is a live-RPC-estimation problem, not a
newly-discovered revert. Choosing ABORT there for capital-sensitive close/
TP-SL paths would mean: a transient gas-RPC hiccup makes it **impossible
to close a losing position at all**, which is worse for capital safety
than sending with a small, explicit, already-reviewed constant that
under-gases (safe failure mode — reverts out-of-gas, costs only the gas
spent, position stays open) rather than over-gases. All fallback
constants were audited to confirm none is large/unbounded:

| Site | Fallback | Why safe |
|---|---|---|
| `mint.ts` `mint v3` | 900k | Pre-existing reviewed constant (Part 3); mint is user-initiated, not automated — a revert-out-of-gas just costs the user a retry |
| `close.ts` v3 multicall (decrease+collect) | 900k | Same fee-tier operation as mint's multicall; simulation-gated |
| `close.ts` v3 decreaseLiquidity (sequential fallback) | 500k | Single-op subset of the 900k multicall path |
| `close.ts` v3 collect (sequential fallback) | 400k | Single-op subset |
| `close.ts` v3 empty-shell burn | 200k | Smallest op (burn only, no liquidity/fee movement) |
| `close.ts` `claimFees` collect | 400k | Same shape as the sequential collect fallback above |
| `swap.ts` ×2 multi-hop multicall (PCS/UNI) | 900k | Multi-hop + unwrap in one multicall — largest swap op |
| `swap.ts` ×2 direct multicall (PCS/UNI) | 700k | Single-hop + unwrap |
| `swap.ts` ×2 single exactInputSingle fallback (PCS/UNI) | 500k | No unwrap step, smallest of `swapTokenToNative`'s paths |
| `swap.ts` ×2 multi exactInput (PCS/UNI) | 700k | `swapExactInLocal`'s multi-hop, no unwrap |
| `swap.ts` ×2 single exactInputSingle (PCS/UNI) | 450k | `swapExactInLocal`'s smallest op |
| `v4.ts` `initializePool` | 500k | Pool creation, one-shot, user/candidate-initiated |
| `v4.ts` `mint` | 1.2M | v4's `modifyLiquidities` unlock-callback pattern costs more than v3's direct mint |
| `v4.ts` close-v4 loop (`attGas`, 3 attempt kinds) | 1.2M / 1M / 600k per attempt kind | Same shape as v3 close's tiers (full exit / decrease-only / fees-only) |
| `v4.ts` empty-shell burn | 400k | v4 burn also routes through `modifyLiquidities`, costs more than v3's plain `burn()` |
| `v4.ts` `claimV4Fees` | 700k | Fee-only `modifyLiquidities` call |

None of these is a new value — all are the exact pre-existing constants
audited in Phase 2 Part 3. The change here is procedural (retry once)
and this table (documented, per-site rationale), not a redesign.

## 11. Decimal bug fix

`swap.ts`'s `estimateAmountOut()` (identified as buggy in
[PHASE2_PART3_AUDIT.md](PHASE2_PART3_AUDIT.md) §9) applied a **raw**
(non-decimals-adjusted) `(sqrtP/2^96)^2` ratio directly to human-unit
amounts — correct only when `decimalsIn === decimalsOut`; wrong by
`10^|decimalsIn − decimalsOut|` otherwise (e.g. WETH-18/USDC-6). Fixed by
delegating to `quote.ts`'s already-tested, decimals-adjusted
`sqrtPriceRatio()` helper (the same one Part 3's integration test used to
correctly compute its own comparison baseline). Also added an optional
injectable `client` parameter (matching the `MinimalReadClient` DI pattern
from `quote.ts`/`gas.ts`) so the fix is regression-tested without live
RPC — see [`test/swap.decimals.test.ts`](test/swap.decimals.test.ts) (4
tests: same-decimals sanity check, WETH→USDC and USDC→WETH cross-decimals
correctness against `sqrtPriceRatio` directly, and zero-input/zero-price
edge cases). This function remains outside the capital-execution path
(display/sizing fallback only, per Part 3's finding) — the fix makes it
mathematically correct, as required, without changing its callers or its
non-critical role.

## 12. Dead code cleanup

Removed the dead `attempts: Attempt[]` array in `v4.ts`'s
`closeV4Position` (built via 3 `.push()` calls, never read — the real
execution path independently rebuilds an equivalent `roundAttempts` array
inside the retry-round callback) identified in
[PHASE2_PART3_AUDIT.md](PHASE2_PART3_AUDIT.md) §11. Confirmed via
`grep -n "\battempts\b|\bAttempt\b" src/chain/v4.ts` returning **zero**
matches after removal. `npm run typecheck` and `npm run build` both stay
clean (no unused-variable errors), confirming nothing else referenced it.
The live `roundAttempts` construction and its `estimateWriteGas` call
(already fixed in Part 3) are untouched — this was a pure deletion with
no behavioral effect.

## 13. Integration test

Re-ran `npm run test:integration` against the same live Base RPC used in
Part 3 (no fork tooling available in this environment — Windows
Application Control policy blocks Foundry's installer, not bypassed; see
Part 3's audit for the full account). Full run: `tests 3, pass 2, fail 0,
cancelled 1, duration 1,181,615ms` (~19.7 minutes). Results:

- ✅ **discovers a real Base WETH/USDC V3 pool via the real factory** —
  PASS (10.7s). Pool `0x6c561B446416E1A00E8E93E221854d6eA4171372`,
  fee=3000, liquidity=30,403,549,358,917,440,225.
- ❌ **getExecutableQuoteV3 succeeds against a real pool and matches an
  independent full-tick-range cross-check** — **BLOCKED**, reported as
  such, not silently converted to PASS. `node:test` marked it
  `cancelled` at exactly 300,002.689ms (the test-level timeout). Notably,
  the log shows the cross-check's own computation actually *finished*
  around that same boundary: `cross-check (bounded-window
  TickListDataProvider): amountOut=121901453 (527 ticks in window
  [-230400, -153601])` — and **121901453 exactly matches** the real
  quote's own `amountOut=121901453` logged earlier in the same run (line
  39 of the raw output: `real quote: amountIn=50000000000000000
  amountOut=121901453 tick -198301->-198301`). In other words, the two
  independent code paths (`RpcTickDataProvider`'s on-demand bitmap walk
  vs. v3-sdk's own `TickListDataProvider` fed 527 real fetched ticks)
  **did agree exactly** — the test still reports as failed/cancelled
  because fetching those 527 ticks sequentially under this endpoint's
  throttling took just over the 300s bound before the test runner could
  register the final assertion. This is strong supporting evidence the
  underlying logic is correct; it is reported here as an observation, not
  used to claim the test PASSED — per this task's explicit instruction
  ("do NOT claim full integration PASS if an integration test still times
  out... mark BLOCKED. Do not convert BLOCKED into PASS"), the test's
  status is **BLOCKED**.
- ✅ **a trade sized to cross an initialized tick produces a real quote
  that diverges from the rough slot0 estimate** — PASS (92.2s).
  `amountIn=25000000000000000000` (25 WETH), tick `-198301→-198302`
  (genuine crossing), `real=60948.29003` USDC, `rough=61134.16324989737`
  USDC, `diff=0.304%` — consistent with Part 3's result, providing the
  economically-equivalent comparison this task's own §18 allows as a
  fallback when the exact cross-check is environmentally blocked.

## 14. Unit tests

`npm test` — **120 passed, 0 failed** (up from 90 at the end of Part 3).
New this phase (30 tests across 4 files):

- [`test/txRecovery.test.ts`](test/txRecovery.test.ts) — 15 tests covering
  all 10 required TRANSACTION scenarios plus classification and edge
  cases: broadcast success (fast receipt), timeout-with-hash →
  hash-first recovery, timeout-without-hash → nonce-first recovery,
  later-mined, later-reverted, receipt-delayed-stays-unresolved,
  restart-with-unresolved-tx (`recoverUnresolvedEntries`),
  no-retry-marked errors never retried (even against a permissive
  `shouldRetry`), plain errors retry normally, and duplicate prevention
  (consumed nonce + no hash → `RECOVERY_REQUIRED`, never
  `NOT_SUBMITTED`) — plus a flaky-nonce-read streak-reset test and a
  receipt-lookup-error-is-PENDING-not-reverted test.
- [`test/priceFreshness.test.ts`](test/priceFreshness.test.ts) — 10 tests
  covering all 7 required PRICE scenarios: fresh price accepted, stale
  price forces a refresh attempt (and ABORTs if the refresh also fails),
  missing price rejected, RPC failure resolves to `ok:false` (never
  throws to the caller), TP/SL's `classify()` never triggers on a
  null/UNKNOWN `pnlPct`, every `ok:true` result carries a non-empty
  `source` and a real `timestamp`, and PnL's historical/current price
  roles are structurally distinct.
- [`test/swap.decimals.test.ts`](test/swap.decimals.test.ts) — 4
  regression tests for the decimals fix (§11).
- `test/gas.test.ts` gained 1 test for the new retry-before-fallback
  behavior (§10), for 12 tests total in that file.

All pre-existing suites (minOut/withdrawal-min never-zero, price/
ownership fail-closed, WETH-unwrap delta-only, realized-slippage,
tick-bitmap math, TP/SL classification, `txLock` serialization, Part 3's
gas-estimation/telemetry tests) — unaffected, still green.

**Typecheck** (`npm run typecheck`) — clean, 0 errors, re-verified after
every edit in this phase.

**Build** (`npm run build`) — clean, 0 errors.

## 15. Remaining risks

- **`RECOVERY_REQUIRED` has no automated resolution path today.** Once a
  nonce is confirmed consumed with no hash available, the entry stays
  `RECOVERY_REQUIRED` — and continues blocking new sends for that wallet —
  until an operator manually intervenes (e.g. checks a block explorer,
  confirms the outcome). This bot has no admin/CLI command to manually
  mark a journal entry resolved; adding one is a reasonable follow-up but
  was out of this phase's scope (avoiding scope creep into new bot
  commands not requested by the task).
- **No automatic hash recovery for a consumed nonce.** A future
  enhancement could query a block-explorer API (Etherscan-style
  "transactions by address+nonce") to recover the actual hash and resolve
  `RECOVERY_REQUIRED` → `CONFIRMED`/`MINED_REVERT` automatically. Not
  implemented — no such integration existed in this codebase to build on,
  and standard JSON-RPC has no "get tx by sender+nonce" method.
  `RECOVERY_REQUIRED` correctly halts automation in the meantime rather
  than guessing.
- **Nonce-based recovery assumes single-writer-per-wallet.** This holds
  because `txLock` fully serializes every send this bot makes for a given
  (chainId, wallet) — but if the same private key were ever used
  concurrently outside this bot (e.g. manually via another wallet app),
  a nonce-consumed reading could reflect that external transaction, not
  the bot's own ambiguous one. The `RECOVERY_REQUIRED` fail-safe handles
  this correctly (never assumes success/failure either way) but the
  assumption is worth stating explicitly.
- **`MAX_CRITICAL_PRICE_AGE_MS`'s default (90s) is not yet calibrated**
  against real observed price volatility — see §16.
- **Gas fallback constants remain hand-set, per-site values** (§10) rather
  than derived from any formula — this was already true before this phase
  and is unchanged; the retry-once addition reduces how often they're
  reached but doesn't change what they are.

## 16. Known limitations

- **Integration cross-check test remains BLOCKED** by this environment's
  free public RPC rate limiting (§13) — not a code defect, but genuinely
  unverified in this session. A paid/dedicated RPC endpoint would very
  likely let it complete; retrying against the same free endpoint a third
  time was judged not to be a good use of the time budget given two prior
  attempts (Part 3, this phase) already characterized the same wall.
- **`MAX_CRITICAL_PRICE_AGE_MS = 90_000`** is explicitly a **temporary,
  conservative placeholder**, not a calibrated production value — the
  task's own instruction was "do not invent an arbitrary production
  value... use a conservative temporary value and clearly mark it for
  calibration." It is env-overridable (`MAX_CRITICAL_PRICE_AGE_MS`) for
  when real calibration data is available.
- **Bulk/list-display price paths** (`positions.ts`'s `listPositions`/
  `listPositionsFast`, `formatPositionLine`) still use the plain
  (non-freshness-checked) `getTokenPriceUsd()` — reviewed and judged
  non-critical (a human reads the `/list` output before manually deciding
  to close), but they are not covered by the new staleness guarantee.
  Only the automated-decision path (`getPosition`/`getV4Position` →
  TP/SL) was wired to `getCriticalTokenPriceUsd`.
- **Journal persistence is synchronous JSON-file I/O**, matching this
  bot's existing `execution_telemetry`/positions/ledger storage — fine at
  this bot's scale, but not designed for high write concurrency (not a
  concern here since `txLock` already serializes all writes per wallet).

---

## Final verdict: **PASS**

Transaction recovery correctly refuses to retry an ambiguous broadcast
(`BROADCAST_UNKNOWN`, still-pending `SUBMITTED`, or `RECOVERY_REQUIRED`),
persists enough state before broadcast to survive a crash/restart, and
resolves outcomes via hash-first-then-nonce recovery without ever
inferring success/failure from an RPC error or a "not yet visible" read.
Critical price consumers (TP/SL's actual decision path) now carry an
explicit `{ok, price, source, timestamp}` contract with a real staleness
check, flowing through the same pre-existing UNKNOWN-never-triggers
pipeline Phase 1 built — no parallel or divergent handling was
introduced. The Part 3 decimals bug is fixed and regression-tested, the
dead code is removed, and every gas-estimation fallback was reviewed and
documented rather than blindly kept or blindly removed.

**PASS for this phase does NOT mean production-ready.** The independent
RPC cross-check integration test remains BLOCKED by this environment's
free-tier rate limiting (reported honestly as BLOCKED, not converted to
PASS), `RECOVERY_REQUIRED` has no automated resolution path yet, and the
critical-price staleness bound is an explicitly temporary, uncalibrated
placeholder. PASS means: no retry-after-ambiguous-broadcast path exists,
no unresolved transaction is silently lost across a restart, no stale or
missing price can silently become $0 or a live-looking number, and
TP/SL's protection cannot be defeated by a transient RPC or price-feed
hiccup — not that the bot is ready for unattended production capital.

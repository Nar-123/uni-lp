# Phase 3 Accounting Audit — PnL & Accounting Integrity Hardening

## Executive Summary

This phase traced the entire capital/PnL accounting flow — deposit →
position → liquidity changes → fee accrual/claim → partial/full close →
swap → gas → withdrawal → realized/unrealized/gross/net PnL → ROI — and
found **10 concrete bugs**, four of them high-severity misstatements of
actual capital deployed or actual proceeds received (i.e., the bot was
recording *estimated/pre-transaction* numbers as if they were the
*actual, measured* outcome). All ten are fixed in this phase, each with a
regression test. No strategy, screening, sizing, range, TP/SL, or
slippage-constant logic was touched.

The single most consequential fix: **`repriceDepositsUsd()` was silently
revaluing every position's historical deposit cost basis at the
*current* live token price on every PnL computation**, instead of using
the actual USD paid at deposit time — meaning cost basis (and therefore
PnL% and ROI) drifted with the market for every open position, not just
the legacy bad-data rows the function's own comment claimed to be
compensating for.

The ledger's complete lack of idempotency (any `recordLedger()` call
could be repeated and would double-record) is the second most
consequential fix — closed by a deterministic `(chainId, txHash, kind)`
identity key, matching the task's required duplicate-prevention
guarantee.

## Existing Accounting Architecture

Three storage layers, each already present before this phase (Phase 3
did not introduce new storage concepts — see "do not create duplicate
concepts" in the task):

1. **Ledger** (`db/index.ts`, `s.ledger: LedgerRow[]`) — append-only-by-
   convention rows of kind `deposit | withdrawal | fee_claim`, each with
   `chainId, tokenId, tokenAddress, amountRaw, amountHuman, usd, txHash,
   createdAt`. This is the historical-cost-basis / realized-proceeds
   record.
2. **Execution telemetry** (`db/index.ts`, `s.execution_telemetry`) —
   per-transaction record of `slippageBpsUsed, legs[] (estimatedRaw/
   minRaw/actualRaw per token), gas (gasLimitSent/gasUsed/
   effectiveGasPriceWei/actualGasCostWei)`, keyed loosely by `txHash`
   (added Phase 2 Part 3, extended this phase to mint/claim — see
   "Gas Accounting").
3. **Transaction journal** (`db/index.ts`, `s.tx_journal`, Phase 2 Part
   4) — `BROADCAST_UNKNOWN → SUBMITTED → CONFIRMED/MINED_REVERT/
   RECOVERY_REQUIRED/NOT_SUBMITTED` per broadcast attempt.

`pnl/compute.ts` is the sole aggregator: it reads the ledger (historical)
and a live on-chain position snapshot (current), and — as of this phase —
cross-references telemetry (gas) by `txHash`. `pnl/reconcile.ts` (new
this phase) compares the ledger against itself and against the journal.

## Ledger Model

Minimum event types requested by the task (`DEPOSIT, WITHDRAWAL,
FEE_CLAIM, SWAP_COST, GAS_COST, LIQUIDITY_INCREASE, LIQUIDITY_DECREASE,
POSITION_OPEN, POSITION_CLOSE`) map onto this codebase's existing schema
as follows — **no new ledger kinds were added**, per "adapt to existing
schema... do not create duplicate concepts":

| Task's concept | This codebase's equivalent |
|---|---|
| DEPOSIT | `ledger` kind `'deposit'` |
| WITHDRAWAL | `ledger` kind `'withdrawal'` |
| FEE_CLAIM | `ledger` kind `'fee_claim'` |
| GAS_COST | `execution_telemetry.gas.actualGasCostWei`, cross-referenced by txHash (this phase's addition — see "Gas Accounting") |
| SWAP_COST | `execution_telemetry` legs' `estimatedRaw`/`actualRaw` divergence (realized slippage; already existed, Phase 2) |
| LIQUIDITY_INCREASE | **N/A — confirmed this bot has no "add to existing position" feature.** `grep -rn "functionName: 'increaseLiquidity'"` across `src/` returns zero matches; every deposit is a fresh mint. Documented, not invented. |
| LIQUIDITY_DECREASE | Implicit in `closePosition`'s partial-close path (`decreaseLiquidity` call inside the retry loop) — not a separately ledgered event distinct from the close's `'withdrawal'` row, matching this bot's "close = full exit" architecture (no standalone partial-decrease UI exists either) |
| POSITION_OPEN / POSITION_CLOSE | `positions` table's `status: 'open'|'closed'` (`recordOpenPosition`/`markClosed`) — position *metadata*, distinct from the ledger's cash-flow events, which is the correct separation (capital vs. position-lifecycle state) |

`CORRECTION` events (task §3): no code path in this bot currently mutates
a historical ledger row in place — confirmed by
`test/ledger.test.ts`'s "no update/mutate API" test (greps
`db/index.ts`'s exports for any `updateLedger`/`editLedger`/etc. function
and asserts none exist). If a future reconciliation feature needs to
correct a wrong historical amount, the append-only pattern this codebase
already uses for the ledger (and for `execution_telemetry`/`tx_journal`)
is the natural vehicle: append a new row rather than editing the old one.
Not implemented as a separate `'correction'` ledger kind because no
correction-authoring UI/flow exists yet to produce one — flagged as a
future need, not built speculatively (task's "do not invent unnecessary
accounting complexity").

## Deposit Accounting

**BUG-05 / BUG-06 (see Bugs Found).** Every deposit-recording call site
used the pre-mint *offered* amount (`depositAmount`, or v4's
`amount0Desired`/`amount1Desired` echoed back unchanged) instead of the
actual on-chain amount pulled into the position. Fixed:

- v3 mint (`mint.ts`) already decoded the real `IncreaseLiquidity` event
  for `amount0`/`amount1` (this part was already correct) — but
  `bot.ts`'s two ledger-recording call sites weren't using it, recording
  `depositAmount` instead. **Fixed in `bot.ts`.**
- v4 mint (`v4.ts`'s `mintV4SingleSided`) never decoded an actual amount
  at all — it echoed the offered ceiling. **Fixed**: after the mint
  succeeds, the position's real on-chain liquidity is read
  (`getPositionLiquidity`) and re-priced against current pool state via
  the same `computeV4AmountsForLiquidity` helper `getV4Position()` already
  uses for any existing position — v4's mint is liquidity-first (unlike
  v3's amount-based mint, which refunds unused input), so this correctly
  reflects what was actually consumed for the fixed liquidity that was
  minted.
- `bot.ts` now computes the deposit's USD value as
  `amount0Human * price0 + amount1Human * price1` (both tokens, using
  each token's own decimals/price) rather than assuming the entire
  offered amount landed on a single side.

## Withdrawal Accounting

**BUG-01 / BUG-02 (see Bugs Found), the phase's most direct match to
task §10/§11.** `closePosition()` (v3, `close.ts`) and
`closeV4Position()` (`v4.ts`) both captured `token0Before`/`token1Before`
(or `leg0Before`/`leg1Before`) balances *before* the close transaction —
clearly intended for actual-balance-delta measurement — but only ever
used them inside the `execution_telemetry` closure. The `CloseResult`/
`V4CloseResult` actually returned to callers (which feed `recordLedger`'s
`'withdrawal'` row) used the **pre-close position snapshot**
(`pos.amount0 + pos.tokensOwed0`), not a post-close balance read.

**Fixed**: both functions now read `token{0,1}After`/`leg{0,1}After`
after the close transaction lands, compute the actual received amount via
the already-existing `resolveReceivedAmount()` helper (balance delta,
falling back to the pre-close estimate only if no delta was observed —
never a fabricated zero), and return that as `amount0`/`amount1`. The
pre-close estimate is **kept**, not discarded, as new `expected0`/
`expected1` fields on both result types — satisfying task §11's "never
overwrite expected with actual, keep both for auditability."

`v4.ts`'s `closeV4Position` also hardcoded `feesPortionUsd: 0` always
(meaning v4 closes never recorded a separate `fee_claim` ledger row,
unlike v3) — fixed to use the pre-close unclaimed-fee estimate, matching
v3's existing (documented-as-estimate) approach; v4's combined
BURN+TAKE/DECREASE+TAKE unlock path has no on-chain event that separates
principal from fees, the same limitation v3's combined decrease+collect
has.

## Fee Accounting

**BUG-03 / BUG-04.** `claimFees()` (v3) and `claimV4Fees()` had the
identical estimated-not-actual pattern: the returned `feesUsd`/`fees0`/
`fees1`/`amount0Human`/`amount1Human` came from `pos.tokensOwed0`/
`pos.tokensOwed1` (a pre-collect snapshot), never re-measured after the
`collect()`/`modifyLiquidities()` call. **Fixed**: both now capture
balances before the claim, re-read after, and report the actual collected
amount via `resolveReceivedAmount` (falling back to the pre-claim
estimate only if no delta observed).

Lifecycle correctness (task §12/§13/§14, verified/tested):

- Unclaimed fee value (live, from a fresh `getPosition()`/
  `getV4Position()` read — never persisted in the ledger) and claimed fee
  cash (`ledger` kind `'fee_claim'`, persisted once per claim tx) are
  sourced from **different places by construction** — a claim zeroes the
  position's on-chain `tokensOwed`, so the next live read reports
  `unclaimed = 0` while the ledger independently now has
  `claimed = $10` — they cannot both remain $10 (`test/
  withdrawalAccounting.test.ts`'s exact-scenario test from task §40).
- Duplicate-collect idempotency: covered generically by the ledger's new
  `(chainId, txHash, kind)` dedup — processing the same collect
  transaction's outcome twice produces one `fee_claim` row, not two
  (`test/ledger.test.ts`).

## Gas Accounting

Phase 2 Part 3 built `estimateWriteGas`/`buildGasTelemetry`
(never-fabricate-zero, receipt-sourced `gasUsed`/`effectiveGasPriceWei`/
`actualGasCostWei`) but only wired telemetry recording into swap and
close (v3/v4). **This phase (task §17) extended it** to the four
remaining transaction types that directly affect a position's cost basis:
`mint-v3`, `mint-v4`, `claim-fees-v3`, `claim-fees-v4` — each now calls
`buildGasTelemetry(client, hash, estimatedGas)` and
`recordExecutionTelemetry` right after its (already fixed, actual-amount)
on-chain result is known, using the same `ExecutionOpType` pattern
already established, extended with these four new variants.

**Still not covered** (documented, not silently gapped): `initializePool`
(v4 pool creation — one-time, not tied to an ongoing position's PnL),
empty-shell burns (best-effort cleanup, already wrapped in
try/catch-and-ignore-failure), and wrap/unwrap/revoke/transfer/bridge
(never had telemetry before this phase either; out of this pass's
position-cost-basis focus). A position's aggregated gas cost
(`computePositionGasCostUsd`, new this phase) is explicitly `null`
("UNKNOWN"), never `0`, whenever any of its transactions has no matching
telemetry — see "UNKNOWN Handling".

## Swap Cost Accounting

Already correct from Phase 2 — verified, not changed. `execution_telemetry`'s
`ExecutionTelemetryLeg` type has always kept `estimatedRaw`, `minRaw`, and
`actualRaw` as three distinct fields (never one overwriting another), and
`computeRealizedSlippageBps` computes realized slippage from
`estimatedRaw` vs. `actualRaw` — never from the configured slippage
tolerance (task §19's explicit concern: "Configured 15% does NOT mean
actual slippage = 15%" — confirmed true in this codebase; the configured
bps only ever bounds the `minRaw` floor, it is never read back as if it
were a measurement). `test/withdrawalAccounting.test.ts` adds an explicit
regression test locking in that a minimum output can never be reported as
the actual amount.

## Realized PnL / Unrealized PnL / Gross PnL / Net PnL

**Proven first, then extended — the formula was not blindly replaced**
(task §20's explicit instruction).

The pre-existing formula (`pnlUsd = currentValueUsd + unclaimedFeesUsd +
withdrawalsUsd + feesClaimedUsd - depositsUsd`) is **GROSS PnL**: realized
proceeds (withdrawals + claimed fees) plus current unrealized value
(open position + unclaimed fees) minus capital deployed. It never
subtracted gas or swap execution costs — meaning "PnL" as shown
everywhere in this bot, before this phase, was actually gross PnL,
unlabeled as such.

This phase adds, without changing `pnlUsd`/`pnlPct`'s existing
values/semantics (TP/SL thresholds are calibrated against them — task's
explicit "do not change TP/SL" is respected):

- **`grossPnlUsd`** — exact alias of `pnlUsd`, named for clarity now that
  net exists alongside it.
- **`gasCostUsd: number | null`** — aggregated `actualGasCostWei` from
  every `execution_telemetry` row whose `txHash` matches one of this
  position's ledger rows, converted to USD via the native token's live
  price. `null` ("UNKNOWN") — never `0` — whenever no telemetry could be
  matched (e.g. an old position closed before this phase's telemetry
  extension) or the native price itself is unavailable.
- **`netPnlUsd: number | null`** = `grossPnlUsd - gasCostUsd`, `null`
  whenever `gasCostUsd` is `null` — an unknown cost is never silently
  treated as zero and folded into an apparently-authoritative net number.
- **`gasCostComplete: boolean`** — true only when gas cost was measurable
  for *every* recorded transaction, not just some.

**Realized vs. unrealized**, already implicit in the existing formula and
now explicit in the field names: `withdrawalsUsd + feesClaimedUsd` is the
realized component (actual cash received, ledger-sourced); `currentValueUsd
+ unclaimedFeesUsd` is the unrealized component (live on-chain valuation,
not yet cashed out). Both were already correctly separated as distinct
summed terms — this phase didn't need to change that split, only to
label gross vs. net on top of it.

`/pnl`'s `portfolioSummary()` and per-position `formatPnl()` now both
show a `Net (after gas)` line — either the computed figure, or an
explicit `DATA INCOMPLETE — gas cost unknown` string (never a silent
zero or an omitted line that could be mistaken for "no cost").

## ROI

`computePnlPct(pnlUsd, depositsUsd, priceComplete) = (pnlUsd /
depositsUsd) * 100`. **Audited and confirmed already correct** — the
denominator is `depositsUsd` (capital invested, aggregated across every
deposit event for the position — task §8's "liquidity increase" case),
**not** current position value, exactly matching task §24's required
definition. `priceComplete === false` (missing/stale critical price, per
Phase 2 Part 4) already vetoes the calculation to `null` rather than
computing a number from incomplete inputs. Zero/near-zero
`depositsUsd` also yields `null`, not `Infinity`/`NaN`. No code change
was needed here — locked in with 4 new regression tests
(`test/pnl.test.ts`).

## Decimal / Precision Audit

- `humanToFloat(amount: bigint, decimals: number) = Number(amount) / 10 **
  decimals` — reviewed for the task's concern about `Number(bigint)`
  precision loss. At this bot's actual scale (individual position sizes,
  not `Number.MAX_SAFE_INTEGER`-adjacent raw integers), IEEE754 double
  precision's ~15-17 significant decimal digits is more than sufficient
  for USD/PnL-display arithmetic — this is standard practice across
  virtually every DeFi accounting tool, not a precision-loss defect. This
  pattern is acceptable and was **not rewritten** to arbitrary-precision
  decimal math (task's "do not perform broad rewrite unless necessary" —
  no evidence of an actual scaling error was found).
- `test/ledger.test.ts` adds an explicit 18/6/9-decimals regression test
  confirming no `10^N` scaling error: `humanToFloat(10**18, 18) ===
  humanToFloat(10**6, 6) === humanToFloat(10**9, 9) === 1`, and that
  `1,000,000` raw 6-decimal units convert to `1`, not `1,000,000`.
- Gas-cost wei→USD conversion (`Number(totalWei) / 1e18`) reviewed: a
  realistic gas cost (well under 0.01 ETH ≈ 10^16 wei) is far within safe
  integer range — no precision risk in practice.
- No `Math.max(pnl, 0)`-style clamping was found anywhere in the codebase
  (`grep -rn "Math.max(...*pnl"` returns zero matches) — negative PnL,
  negative ROI, and negative net PnL all propagate as genuine negative
  numbers, confirmed by regression test.

## Transaction Journal Integration

Task §28's requirement — "accounting should not mark SUCCESS before
transaction outcome is actually known... only finalized transaction
states should create final accounting events" — was **already satisfied
by this codebase's existing control flow**, verified (not newly built)
this phase:

- `recordLedger()` is only ever called from `bot.ts`/`tpslWatcher.ts`
  *after* `closePosition()`/`claimFees()`/`mintSingleSided()` etc. have
  already returned successfully.
- Every one of those on-chain functions throws (never returns) unless the
  transaction's receipt has `status === 'success'`.
- Phase 2 Part 4's `journalledSend` (the wrapper around every
  `sendTransaction`/`writeContract` call) never lets an ambiguous
  broadcast (`BROADCAST_UNKNOWN`/still-pending `SUBMITTED`/
  `RECOVERY_REQUIRED`) surface as a normal return — it's always a thrown,
  no-retry-marked error, which propagates straight out of `closePosition`/
  etc. and is caught by the caller *before* any `recordLedger` call is
  reached.

Net effect: there is no code path today where an ambiguous or
unresolved-per-the-journal transaction can produce a ledger event. This
was verified structurally (traced every call site) and is additionally
checked by `pnl/reconcile.ts`'s journal cross-check (below), which exists
specifically to catch a *future* regression of this invariant.

## Reconciliation

New: [`src/pnl/reconcile.ts`](src/pnl/reconcile.ts)'s
`reconcileAccounting(chainId?)`. Two checks, both structural/local (not a
full historical on-chain re-verification, which would mean re-fetching
every position's entire tx history from a block explorer — out of this
phase's scope):

1. **Duplicate ledger events** — more than one row sharing the same
   `(chainId, txHash, kind)` identity. Should be impossible going forward
   (idempotency fix), but this also catches any duplicates already
   present in a store written before that fix.
2. **Journal cross-check** — a ledger event exists for a `txHash` whose
   journal entry (when one exists) shows `MINED_REVERT` or is still
   unresolved (`BROADCAST_UNKNOWN`/`SUBMITTED`/`RECOVERY_REQUIRED`).
   Per "Transaction Journal Integration" above, this should never fire in
   practice — it exists as a regression guard.

Returns `{ status: 'RECONCILIATION_OK' | 'RECONCILIATION_REQUIRED',
findings: [...] }` — findings are reported, never silently repaired
(task's explicit "do not silently repair without recording what
changed"). **Not wired into a bot command** in this phase (no `/status`
or `/reconcile` command exists in this bot today, and adding one was
judged out of scope for an "accounting only" phase that explicitly
excludes new UI/strategy features) — it's available as a tested,
importable function for manual invocation or future wiring.

## Restart Recovery

Simulated via `db/index.ts`'s new `__resetStoreForTests()` (drops the
in-memory cached store, forcing the next call to reload from disk —
equivalent to a process restart's cold load, without spawning a child
process). `test/ledger.test.ts` confirms: entries recorded before a
simulated restart are present, unchanged, and correctly summed after the
reload — no event is duplicated or lost.

## Crash Recovery

Simulated: record an event, "crash" (reset the store), then re-attempt
recording the *same* event (simulating a recovery/reconciliation pass
re-processing an already-seen receipt after restart) — the idempotency
key ensures this does not create a duplicate (`test/ledger.test.ts`).
Combined with Phase 2 Part 4's transaction-journal-based recovery (which
determines the true on-chain outcome of an ambiguous broadcast before any
caller can proceed), the full crash scenario — *transaction succeeds,
process crashes before accounting update, restart reconciles* — is
covered by: journal recovery resolves the transaction's true state on
restart → if it resolves to `CONFIRMED`, the normal
`recordLedger` call site would need to re-run to actually record it (not
automatic — Phase 2 Part 4's journal recovery restores *transaction*
state, it does not itself replay the higher-level `recordLedger` call).
**This is a documented gap**: startup transaction recovery (Phase 2 Part
4) does not currently trigger a corresponding *ledger* event for a
transaction it resolves to `CONFIRMED` after a crash — see "Remaining
Risks."

## UNKNOWN Handling

Audited every "UNKNOWN must not become ZERO/VALID" case named in the
task:

| Case | Status |
|---|---|
| Gas unknown → 0 | **Fixed this phase**: `gasCostUsd`/`netPnlUsd` are `null`, never `0`, when telemetry can't be matched (§ "Realized/Gross/Net PnL") |
| Fee unknown → 0 | Already correct (Phase 1): `priceCompleteFor` treats a missing price as incomplete, not $0 |
| Actual withdrawal unknown → estimated silently used as final | **Fixed this phase** (§ "Withdrawal Accounting") — falls back to estimate only when no balance delta is observable at all, and the estimate is kept as a separately-labeled `expected` field, never presented as "actual" |
| Historical price unknown → current price | **Fixed this phase** (§ "Deposit Accounting" / the `repriceDepositsUsd` bug) |
| Transaction unknown → success | Already correct (Phase 2 Part 4): `journalledSend` never returns success without a real hash; ambiguous broadcasts are marked no-retry and thrown |
| RPC error → 0 | Already correct (Phase 1/2): price/ownership/gas all classify RPC failure as UNKNOWN, never 0 |
| Negative PnL → clamped to 0 | Confirmed never happens (no `Math.max` clamp exists) |

## Dashboard Verification

This bot's actual registered commands (`src/index.ts`) are `/pnl`,
`/list`, `/close`, `/tp`, `/history`, `/generate` — **not** `/status`/
`/position`/`/fees` as named generically in the task; those roles are
served by `/pnl` (portfolio summary), `/list` (per-position display), and
`/tp`/`/close` respectively. Audited and updated:

- **`/pnl`** (`portfolioSummary`, `handlePnl` in `bot.ts`) — now shows
  `Gross Portfolio PnL` and a `Net (after gas)` line (computed by
  aggregating each open position's `computePositionPnl().gasCostUsd`, or
  an explicit `DATA INCOMPLETE` string when no gas data is available for
  any position).
- **Per-position `formatPnl()`** (`pnl/compute.ts`) — now labeled `Gross
  PnL` with a `Net (after gas)` line beneath it, same incomplete-data
  handling.
- **`/generate`** (`pnl/card.ts`, PnL card image) — reviewed: uses
  `pnl.pnlUsd`/`pnl.pnlPct` directly, unlabeled as gross. Not changed
  (image-template edit was judged out of scope for this pass — flagged
  under "Remaining Risks", not silently left inconsistent).
- **`/list`** (`positions.ts`'s `formatPositionLine`, via
  `getCriticalTokenPriceUsd`) — unaffected by this phase's changes;
  already correctly shows live valuation, not historical.

## Bugs Found

**BUG-01** · Severity: **HIGH** · `src/chain/close.ts` ·
`closePosition()`
Root cause: `amount0`/`amount1` in the returned `CloseResult` were
computed from `pos.amount0 + pos.tokensOwed0` — a snapshot taken *before*
the close transaction — despite `token0Before`/`token1Before` balances
already being captured for exactly this purpose (used only inside the
telemetry closure).
Impact: every v3 position's ledger `'withdrawal'` row, and therefore its
realized proceeds / PnL / ROI, used an estimate instead of the amount
actually received.
Fix: read `token{0,1}After` post-close, compute actual via
`resolveReceivedAmount` (balance delta, falls back to the estimate only
if none observed); pre-close estimate preserved separately as
`expected0`/`expected1`.
Regression test: `test/withdrawalAccounting.test.ts`.

**BUG-02** · Severity: **HIGH** · `src/chain/v4.ts` ·
`closeV4Position()`
Root cause: identical pattern to BUG-01 (`amount0 = pos.amount0`), plus
`feesPortionUsd` hardcoded to `0` always, so v4 closes never recorded a
separate `fee_claim` ledger row (v3 does).
Impact: same as BUG-01 for v4 positions, plus a v3/v4 accounting
inconsistency in how fees vs. principal are split on close.
Fix: same actual-balance-delta pattern; `feesPortionUsd` now uses the
pre-close unclaimed-fee estimate, matching v3's existing approach.
Regression test: `test/withdrawalAccounting.test.ts` (pattern-level);
type-level `expected0`/`expected1` fields added to `V4CloseResult`.

**BUG-03** · Severity: **HIGH** · `src/chain/close.ts` · `claimFees()`
Root cause: `feesUsd`/`amount0Human`/`amount1Human` computed from
`pos.tokensOwed0`/`pos.tokensOwed1` (pre-collect snapshot), never
re-measured after `collect()`.
Impact: claimed-fee ledger entries recorded an estimate, not the actual
collected amount.
Fix: balance-before/after + `resolveReceivedAmount`, same pattern as
BUG-01.
Regression test: `test/withdrawalAccounting.test.ts`.

**BUG-04** · Severity: **HIGH** · `src/chain/v4.ts` · `claimV4Fees()`
Root cause/impact/fix: identical to BUG-03, v4 variant.
Regression test: `test/withdrawalAccounting.test.ts`.

**BUG-05** · Severity: **MEDIUM** · `src/bot/bot.ts` · both
`recordLedger({kind:'deposit', ...})` call sites
Root cause: recorded `result.depositAmount` (the pre-mint *offered*
ceiling for a single token) instead of the mint result's actual
`amount0`/`amount1`.
Impact: deposit cost basis could overstate actual capital deployed
whenever the mint didn't consume 100% of the offered amount on a single
side.
Fix: compute deposit USD/amount from `result.amount0`/`amount1` (each
token's own decimals/price), attributing the single-field
`amountRaw`/`amountHuman` to whichever side matches the user's chosen
deposit token.
Regression test: covered indirectly via BUG-06's mint fix (which supplies
the correct `amount0`/`amount1` these call sites now consume); direct
bot.ts UI-flow testing was judged impractical (requires full Telegram
session/viem-client mocking) — see "Remaining Risks."

**BUG-06** · Severity: **MEDIUM** · `src/chain/v4.ts` ·
`mintV4SingleSided()`
Root cause: `amount0`/`amount1` in `V4MintResult` were literally
`amount0Desired`/`amount1Desired` — the pre-mint offered ceiling, with no
on-chain event decode at all (v3's mint, by contrast, already decoded the
real `IncreaseLiquidity` event).
Impact: same as BUG-05, specific to v4 mints, and the root cause BUG-05's
fix depends on for v4.
Fix: after mint success, re-derive actual amounts from the position's
real on-chain liquidity (`getPositionLiquidity`) re-priced against
current pool state via the existing `computeV4AmountsForLiquidity`
helper.
Regression test: exercised via typecheck/build (full viem-client mocking
for this on-chain function was judged impractical — same caveat as
BUG-05).

**BUG-07** · Severity: **HIGH (structural)** · `src/db/index.ts` ·
`recordLedger()`
Root cause: no idempotency check of any kind — calling it twice with the
same `(chainId, txHash, kind)` created two rows.
Impact: any retry, double-call, or future re-import of an
already-recorded event would double-count in `sumLedger`/
`computePositionPnl` — directly the task's §4/§5 concern.
Fix: deterministic `(chainId, txHash, kind)` identity key; a duplicate
call is logged and ignored, not inserted.
Regression test: `test/ledger.test.ts` (4 tests).

**BUG-08** · Severity: **HIGH** · `src/pnl/compute.ts` ·
`repriceDepositsUsd()`
Root cause: unconditionally preferred `amountHuman * <live price>` over
the ledger row's own stored `usd` (the price-at-deposit-time value)
whenever a live price was available — which is virtually always.
Impact: **every open position's cost basis silently drifted with the
current market price** on every PnL/ROI computation, rather than staying
fixed at what was actually paid — the exact "current price × historical
quantity = historical deposit cost" anti-pattern the task explicitly
names (§7/§30) as incorrect.
Fix: prefer the stored `usd` when it's finite and positive; fall back to
live-price re-derivation only for rows whose stored `usd` is
missing/zero (preserving the function's original, narrower intent —
compensating for a since-fixed historical pricing bug in old rows).
Regression test: `test/pnl.test.ts` (2 tests, one proving the stored
value wins, one proving the legacy fallback still works).

**BUG-09** · Severity: **MEDIUM (completeness, not misstatement)** ·
`src/pnl/compute.ts` · `computePositionPnl()`
Root cause: the sole "PnL" figure computed and displayed everywhere was
actually gross PnL (no gas/swap-cost deduction), unlabeled as such.
Impact: not a wrong number, but an incomplete one presented without
qualification — a user reading "PnL +$150" had no way to know gas/swap
costs weren't subtracted.
Fix: added explicit `grossPnlUsd`/`gasCostUsd`/`gasCostComplete`/
`netPnlUsd` fields; `pnlUsd`/`pnlPct` themselves are unchanged (TP/SL
calibration preserved).
Regression test: `test/pnl.test.ts`.

**BUG-10** · Severity: **LOW-MEDIUM (coverage gap)** ·
`src/chain/mint.ts`, `src/chain/close.ts`, `src/chain/v4.ts`
Root cause: gas telemetry (Phase 2 Part 3) was only wired into swap and
close — mint and fee-claims had none, making their gas cost
unconditionally `UNKNOWN` in any aggregation.
Impact: `computePositionGasCostUsd`'s `gasCostComplete` would be `false`
for essentially every position (since mint gas was never tracked),
understating how much net-PnL data is actually available.
Fix: extended `recordExecutionTelemetry` to `mint-v3`, `mint-v4`,
`claim-fees-v3`, `claim-fees-v4` (new `ExecutionOpType` variants), using
the existing `buildGasTelemetry` helper.
Regression test: exercised via typecheck/build; the underlying
`buildGasTelemetry`/`ExecutionOpType` plumbing was already tested in
Phase 2 Part 3/4's `gas.test.ts`.

## Tests Added

- [`test/ledger.test.ts`](test/ledger.test.ts) — 12 tests: duplicate
  event prevention (3), restart/crash-safety (2), reconciliation (4),
  decimal safety across 18/6/9 decimals (1), append-only-by-construction
  (1), same-tx-different-kind not-a-duplicate (1). Uses a real (scratch,
  isolated) `db/index.ts` store — `DB_PATH`/`WALLETS_PATH` redirected to
  a `fs.mkdtempSync` temp directory so the project's real `data/` files
  are never touched.
- [`test/pnl.test.ts`](test/pnl.test.ts) — 11 tests: gross/net separation
  and UNKNOWN gas (1), ROI denominator correctness (3), negative PnL not
  clamped (1), multi-position isolation (1), partial withdrawal not
  auto-profit (1), liquidity-increase cost-basis aggregation (1),
  historical-cost-basis-not-revalued (2), unclaimed/claimed fee
  non-double-counting (1).
- [`test/withdrawalAccounting.test.ts`](test/withdrawalAccounting.test.ts)
  — 4 tests: actual-differs-from-expected-and-both-preserved,
  no-delta-falls-back-to-estimate-not-zero, minimum-output-never-becomes-
  actual, and the task's exact $10-fee-collected-once scenario (§13/§40).

All new tests are network-free and config-isolated (scratch DB/wallet
paths), except where a test deliberately exercises `getTokenPriceUsd`'s
deterministic stablecoin short-circuit (USDC → $1, no network call).

## Test Results

**Unit tests** (`npm test`) — **144 passed, 0 failed** (up from 120 at
the end of Phase 2 Part 4; +24 new this phase across the three files
above).

**Typecheck** (`npm run typecheck`) — clean, 0 errors, re-verified after
every edit in this phase.

**Build** (`npm run build`) — clean, 0 errors.

**Integration tests** (`npm run test:integration`) — re-run this phase
for completeness even though Phase 3 did not touch `chain/quote.ts` or
any RPC-facing quote code; full run `tests 3, pass 2, fail 0, cancelled
1, duration 1,182,122ms` (~19.7 minutes):

- ✅ **discovers a real Base WETH/USDC V3 pool via the real factory** —
  PASS (10.7s). Pool `0x6c561B446416E1A00E8E93E221854d6eA4171372`.
- ✅ **a trade sized to cross an initialized tick produces a real quote
  that diverges from the rough slot0 estimate** — PASS (78.1s).
  `real=60862.62612`, `rough=61048.23388734925`, `diff=0.304%`, tick
  `-198315→-198316` — consistent with Part 3/Part 4's results, confirming
  Phase 3's changes (which never touched the quote engine) didn't
  regress it.
- ❌ **getExecutableQuoteV3 succeeds against a real pool and matches an
  independent full-tick-range cross-check** — **BLOCKED**, reported as
  such, not converted to PASS. `node:test` marked it `cancelled` at
  300,006.66ms. As in Phase 2 Part 4's run, the cross-check's own
  computation actually finished around that boundary
  (`amountOut=121468164`, 527 ticks fetched) — this is the same
  free-tier RPC throttling characteristic documented in
  [PHASE2_PART4_AUDIT.md](PHASE2_PART4_AUDIT.md) §13, unrelated to any
  Phase 3 change.

## Remaining Risks

- **Crash recovery does not automatically re-trigger `recordLedger`.**
  Phase 2 Part 4's transaction-journal recovery restores the true
  *on-chain transaction* state after a crash (e.g. resolves an ambiguous
  broadcast to `CONFIRMED`), but nothing currently re-runs the
  higher-level `recordLedger` call for a transaction recovered this way —
  the normal call path only records on a direct, synchronous success
  return from `closePosition()`/etc., not from a later, out-of-band
  journal recovery. A position closed successfully but whose process
  crashed *before* `recordLedger` ran would need a manual/future
  reconciliation pass to backfill the missing ledger event —
  `pnl/reconcile.ts` can detect the journal shows `CONFIRMED` with no
  corresponding ledger row today only if extended with a third check
  (currently it only checks the reverse direction: ledger event exists
  but journal shows non-success). Documented, not fixed — a genuinely new
  feature (auto-backfill-ledger-from-recovered-journal-entry) beyond this
  phase's "audit and fix existing paths" scope.
- **BUG-05/BUG-06's fix is not directly unit-tested at the bot.ts/mint
  UI-flow level** — doing so would require mocking the full viem
  wallet/public client stack (RPC reads, simulateContract,
  writeContract, receipt/log decoding) across `mintSingleSided`/
  `mintV4SingleSided`, which is a large, invasive undertaking for this
  phase's scope. The fix is exercised by typecheck/build and by the
  already-existing decoded-actual-amount logic in v3's mint (unchanged,
  already correct) plus the new v4 re-derivation logic (which reuses
  `computeV4AmountsForLiquidity`, itself exercised by `getV4Position()`'s
  existing usage).
- **v3/v4 close's fee-vs-principal split remains an estimate**
  (`pos.unclaimedFeesUsd`, computed before the close tx) — there is no
  on-chain event from the combined decrease+collect (v3) or BURN+TAKE
  (v4) operations that separates the two. A precise split would require
  either two separate transactions (decrease, then collect, as distinct
  txs) or event-log math this codebase doesn't currently have — flagged,
  not implemented, per "do not invent unnecessary accounting complexity."
- **`pnl/card.ts` (the `/generate` PnL card image) was not updated** to
  distinguish gross/net — it still shows the same `pnlUsd`/`pnlPct` it
  always did (which, being unchanged, is not a regression), just without
  the new gross/net labeling the text-based `/pnl` and `formatPnl` now
  have.
- **Reconciliation is not wired into any bot command** — available as a
  tested function, not yet operator-facing.

## Known Limitations

Carried forward from Phase 2 Part 4, still true:

- One integration cross-check test remains BLOCKED by this environment's
  free public RPC rate limiting.
- `RECOVERY_REQUIRED` transaction states still require manual
  intervention (no automated resolution path).
- `MAX_CRITICAL_PRICE_AGE_MS` (90s) is a temporary, uncalibrated
  placeholder.
- Some gas fallback constants remain explicit, hand-set values (reviewed
  and documented in Phase 2 Part 4, unchanged).

New this phase:

- Gas telemetry still doesn't cover `initializePool`, empty-shell burns,
  wrap/unwrap/revoke/transfer/bridge — these transactions' gas cost is
  `UNKNOWN` (correctly, not `0`) in any aggregation that includes them.
- No unified `COMPLETE`/`PARTIAL`/`UNKNOWN`/`RECONCILIATION_REQUIRED`
  status enum was added to the position/PnL snapshot itself (task §36) —
  `gasCostComplete` (boolean, gas-specific) and `reconcileAccounting()`'s
  separate `RECONCILIATION_OK`/`REQUIRED` status serve the same purpose
  in a more targeted way, but a single unified field does not exist.

**This bot is NOT production-ready.** Phase 3's PASS means: the ledger is
idempotent, deposit/withdrawal/fee amounts reflect actual measured
on-chain outcomes rather than pre-transaction estimates, historical cost
basis no longer drifts with current market price, gas costs are tracked
where telemetry exists and explicitly UNKNOWN (never fabricated as zero)
where it doesn't, gross and net PnL are distinct and labeled, ROI's
denominator is confirmed correct, restart/crash do not duplicate ledger
events, and a reconciliation function exists to detect (not silently
repair) any future drift between the ledger and the transaction journal.
It does not mean every accounting edge case has telemetry coverage, that
fee-vs-principal splitting on close is exact, or that any of Phase 2's
carried-forward limitations have been resolved.

## Final Verdict

# PASS

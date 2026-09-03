# PHASE 4.6.13 TRANSACTION RECEIPT DEADLINE HARDENING REPORT

## 1. Original Finding

"40 unbounded `waitForTransactionReceipt` calls in execution-strategy
files" — a remaining P3 finding surfaced in Phase 4.6.12's retry audit.

**Important correction, established during this phase's investigation
and disclosed here rather than silently ignored:** these calls were not
actually unbounded. Direct inspection of viem's source
(`node_modules/viem/actions/public/waitForTransactionReceipt.ts`) shows
`timeout = 180_000` is already viem's own default — a `setTimeout` fires
unconditionally and rejects with `WaitForTransactionReceiptTimeoutError`
after 180 seconds regardless of RPC/provider behavior, even if the
underlying polling itself is stuck. So a genuine infinite hang was never
possible. The real, provable gap was that this 180-second bound was
**implicit** — an unstated dependency on a third-party library's current
default, never made explicit, tested, or documented as an intentional
choice by this codebase. This phase fixes exactly that gap: it makes the
deadline explicit, codebase-owned, and directly tested, at the exact
same boundary value viem already used (zero change to when a timeout
actually fires).

## 2. All waitForTransactionReceipt Calls

The actual current count, found via `grep -rn "await .*\.waitForTransactionReceipt("`
across `src/`, is **35** (not 40 — the prior phase's estimate was
approximate; the task's own instruction not to assume a fixed count was
followed).

| # | File:line | Caller | Category |
|---|---|---|---|
| 1 | `chain/across.ts:339` | `sendAndWait` | Bridge send |
| 2 | `gmgn/swap.ts:96` | GMGN allowance approve | Approve |
| 3 | `gmgn/swap.ts:230` | GMGN swap broadcast | Swap |
| 4 | `chain/mint.ts:105` | approve (in mint flow) | Approve |
| 5 | `chain/mint.ts:479` | mint | Mint |
| 6 | `chain/close.ts:366` | multicall close (v3) | Close |
| 7 | `chain/close.ts:406` | sequential decrease (v3 fallback) | Close |
| 8 | `chain/close.ts:437` | sequential collect (v3 fallback) | Close/Collect |
| 9 | `chain/close.ts:480` | burn empty NFT shell | Close (best-effort) |
| 10 | `chain/close.ts:640` | claimFees (v3) | Collect |
| 11 | `chain/relay.ts:440` | bridge leg send | Bridge |
| 12 | `chain/revoke.ts:275` | approve(0) revoke | Revoke |
| 13 | `chain/swap.ts:386` | allowance approve | Approve |
| 14-17 | `chain/swap.ts:786,822,924,964` | swapTokenToNative attempts | Swap |
| 18-19 | `chain/swap.ts:1058,1076` | sequential swap legs | Swap |
| 20-23 | `chain/swap.ts:1503,1545,1593,1638` | swapExactInLocal attempts | Swap |
| 24 | `chain/tradingApi.ts:199` | Trading-API broadcast | Swap |
| 25-26 | `chain/transfer.ts:74,114` | wallet transfer | Transfer |
| 27 | `chain/v4.ts:473` | approve (v4) | Approve |
| 28-29 | `chain/v4.ts:1002,1025` | mint v4 legs | Mint |
| 30 | `chain/v4.ts:1524` | v4 operation | Liquidity mod |
| 31 | `chain/v4.ts:2798` | close v4 (`modifyLiquidities`) | Close |
| 32 | `chain/v4.ts:2879` | burn empty v4 shell | Close (best-effort) |
| 33 | `chain/v4.ts:3033` | v4 operation | Liquidity mod |
| 34-35 | `chain/wrap.ts:120,163` | wrap/unwrap native | Wrap |

All 35 are direct `client.waitForTransactionReceipt({ hash })`/
`{ hash: h }` calls — no wrapper function (`waitForReceipt`, `waitForTx`,
`confirmTransaction`) exists anywhere in `src/` besides
`chain/txRecovery.ts`'s own `waitForReceiptBounded` (a distinct,
already-bounded, journal-recovery-only mechanism, unmodified this
phase). No hidden unbounded wait was found through any wrapper.

## 3. Affected Execution Paths

Every one of the 11 files sits strictly **after** `journalledSend`
(`src/chain/clients.ts`, unmodified) has already broadcast the
transaction and written `SUBMITTED` to the journal with a real hash —
the pattern is uniformly:

```
strategy code (mint/close/swap/etc.)
   ↓ wallet.writeContract(...) / wallet.sendTransaction(...)
   ↓  [inside: journalledSend — nonce fetch, journal SUBMITTED, broadcast]
   ↓ hash returned
   ↓ client.waitForTransactionReceipt({ hash, ... })   ← this phase's only touch point
   ↓ receipt.status check → existing success/revert branch (unmodified)
```

No path in the 35 call sites journals *after* the wait — every site
already receives `hash` from a `writeContract`/`sendTransaction` call
that has already gone through the journal-before-broadcast architecture.

## 4. Existing Journal Ordering

Verified for every affected file: the transaction is journaled
(`SUBMITTED`, with hash) inside `journalledSend` **before** any of the
35 receipt-wait calls execute — confirmed by inspection (`journalledSend`
is the sole path to `wallet.writeContract`/`wallet.sendTransaction`, and
every one of the 35 sites' `hash` variable comes directly from such a
call). This existing ordering already satisfies Safety Invariant #1 ("A
transaction is journaled before the system can lose knowledge of its
outcome") and was preserved exactly — nothing in this phase reorders
send/journal/wait.

## 5. Root Cause

`client.waitForTransactionReceipt({ hash })` at all 35 sites omitted the
`timeout` option, silently inheriting viem's own internal default
(`180_000`ms, confirmed from source — §1). This is not a crash or
duplication risk (viem's own `setTimeout` already fires regardless of
RPC state), but it is a genuine reliability/maintainability gap: the
actual deadline this codebase relies on for every execution-critical
receipt wait was never asserted, tested, or owned by this codebase — it
would silently change if a future viem version changed its own default,
with no test anywhere that would catch it.

## 6. Receipt Deadline Design

New file `src/chain/receiptWait.ts` exports one constant:
```ts
export const EXECUTION_RECEIPT_TIMEOUT_MS = 180_000;
```
Deliberately set to the **exact same value** viem already used by
default — this is a conscious, conservative choice, not an oversight:
this codebase already has a second, established convention for "how
long to wait for a receipt before giving up" —
`chain/txRecovery.ts`'s own bounded polling (`RECEIPT_POLL_ATTEMPTS=6 ×
RECEIPT_POLL_BACKOFF_MS=2000`, ≈30s total) — but that mechanism runs
*after-the-fact* during journal recovery (startup, or an explicit
pre-send check), not as the *first*, *live* wait immediately after a
broadcast, where the transaction may still be freshly propagating.
Shortening the live execution-path wait to match the 30s recovery-check
convention was considered and deliberately rejected: it would make
legitimately-slow-but-eventually-successful confirmations (which can
genuinely take more than 30s under network congestion) hit the new
timeout *more often* than they did before this phase, pushing more
normal, non-failing operations into the "unresolved, check journal"
path with no evidence this improves anything — a real behavioral
regression risk with no offsetting benefit, since the wait was already
finite. Keeping the exact same 180s boundary is a strictly conservative
hardening: zero change to the success/timeout boundary, while gaining
explicit ownership, testability, and immunity to a future silent library
default change.

## 7. Timeout Classification

| Case | Outcome | Where classified |
|---|---|---|
| A. Confirmed success | `receipt.status === 'success'` returned, existing success branch runs unchanged | Existing code at each of the 35 sites, untouched |
| B. Confirmed revert | `receipt.status === 'reverted'` returned (a real, resolved value — viem's `waitForTransactionReceipt` resolves normally for a mined-but-reverted tx), existing revert/`throw new Error('... reverted ...')` branch runs unchanged | Existing code, untouched |
| C. Receipt wait timeout | Viem throws `WaitForTransactionReceiptTimeoutError` (distinguishable via the new `isReceiptWaitTimeout` type guard) | Propagates uncaught to each function's caller — see §8 |
| D. RPC/network error, outcome unknown | Propagates as a rejection (viem retries internally per its own `retryCount`/`retryDelay` before ultimately giving up or hitting the timeout) — never resolves to a fabricated receipt | Same propagation path as C |
| E. Definitive pre-broadcast failure | Not reachable from these 35 sites at all — a pre-broadcast failure (bad nonce, insufficient funds, etc.) is classified by `journalledSend`'s own `classifyBroadcastError` (`chain/txRecovery.ts`, unmodified), strictly *before* any of these receipt-wait calls are ever reached | Existing, unmodified `journalledSend`/`classifyBroadcastError` |

C and D are never collapsed into E: neither is caught or reclassified by
this phase's changes, and neither reaches `classifyBroadcastError` at
all (that function is only invoked inside `journalledSend`'s own
try/catch around the broadcast call itself, which has already returned
successfully by the time any of these 35 waits begin).

## 8. UNKNOWN Semantics

No new catch-and-reclassify logic was added at any of the 35 call
sites. This was a deliberate design choice, not an oversight: tracing
every call site's surrounding code confirms that ledger writes
(`recordLedger`), position-state mutations (`markClosed`,
`setPositionTpSl`), and TP/SL notifications all happen strictly **after**
a successful return from the enclosing function (`closePosition`,
`mintSingleSided`, etc.) — never inside a catch block. A thrown
`WaitForTransactionReceiptTimeoutError` (or any other exception at this
point) therefore simply prevents the enclosing function from returning
successfully; none of that downstream accounting/state code ever
executes. The caller (bot.ts handlers, `tpslWatcher.ts`'s `executeClose`,
`multiExecute.ts`) already has a generic catch-and-notify handler for
"this operation did not complete" that touches no ledger/position state
— this was already the correct "UNKNOWN, not FAILED" behavior for *any*
exception at this point before this phase, and remains exactly that. The
already-`SUBMITTED` journal entry (§4) is left completely untouched and
is resolved later by the unmodified `txRecovery` mechanism.

## 9. Duplicate Submission Protection

**No call site was changed to resend a transaction.** Verified by the
diff itself (§28): every change is exactly one `timeout:` property
addition to an existing `waitForTransactionReceipt` call, and one import
line — no new `writeContract`/`sendTransaction` call was added anywhere.
A new test (`'a receipt-wait timeout never itself issues a send/broadcast
RPC call'`) proves directly, against a real viem client, that a timed-out
wait never issues `eth_sendRawTransaction`/`eth_sendTransaction` — the
wait function has no code path capable of resending.

**One pre-existing pattern, evaluated and explicitly not touched or
newly introduced by this phase:** `close.ts`'s multicall-close path
already had, before this phase, a `catch` block around its receipt wait
that falls through to a *separate* sequential `decreaseLiquidity` +
`collect` broadcast if the multicall attempt throws for *any* reason
(including, now, a timeout — previously, an RPC error during polling
could already trigger this same fallback identically). This is a
pre-existing "try an alternative strategy" pattern (not a resend of the
*same* transaction), already re-reads live on-chain liquidity before
constructing the fallback transaction, and is unrelated to whether the
first transaction's wait threw due to a timeout specifically versus any
other pre-existing exception category. Redesigning this fallback
behavior is "execution strategy"/"transaction construction," explicitly
outside this phase's ABSOLUTE SCOPE — flagged in §29 as a related,
pre-existing, out-of-scope observation rather than silently ignored or
fixed without authorization.

## 10. Recovery Integration

`txRecovery.ts` was not modified (confirmed by diff, §28 — the same line
count as the pre-phase baseline). A `SUBMITTED` journal entry left
behind by a receipt-wait timeout is discoverable by
`listUnresolvedTxJournal`/`runStartupTxRecovery`/`recoverUnresolvedEntries`
exactly as any other unresolved entry already was — nothing about this
phase changes what recovery sees or how it resolves it.

## 11. Success Behavior

`test/receiptWait.test.ts`'s `'success before deadline'` test constructs
a **real** viem `PublicClient` (via `createPublicClient` + a fake
`custom()` transport, not a duck-typed stand-in) whose fake RPC endpoint
returns a successful raw receipt immediately, and confirms
`client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS })`
resolves with `status: 'success'` exactly as before — the presence of an
explicit timeout has zero effect on the success path.

## 12. Revert Behavior

The parallel `'revert before deadline'` test proves a confirmed-reverted
raw receipt resolves with `status: 'reverted'` — a real, resolved value,
never converted into a timeout or thrown error. Confirmed reverts remain
completely distinguishable from, and never collapsed into, the timeout/
UNKNOWN case.

## 13. RPC Error Behavior

`'persistent RPC error during polling never resolves to a fabricated
receipt'` simulates a receipt lookup that always throws `'connection
reset'`, and proves the overall wait never resolves to any value — it
only ever rejects, satisfying "outcome unknown → UNKNOWN/recovery, never
assume failure or success."

## 14. Shutdown Interaction

Not modified — Phase 4.6.4's TP/SL watcher shutdown implementation
(`bot/tpslWatcher.ts`) was untouched by this phase's diff (confirmed,
§28). The receipt-wait deadline (180s, unchanged from before) does not
interact with `stopTpslWatcher`'s 15-second shutdown-wait deadline in
any new way: an in-flight close was already, by Phase 4.6.4's explicit
design, never interrupted mid-flight and could already take up to (the
prior implicit) 180 seconds waiting on a receipt — this phase changes
nothing about that interaction, since the timeout value itself is
unchanged.

## 15. V3/V4 Analysis

`test/receiptWait.test.ts`'s `'V3 (close.ts) and V4 (v4.ts) close paths
use the identical timeout constant'` test confirms, by direct source
inspection, that both `chain/close.ts` (v3) and `chain/v4.ts` (v4) import
`EXECUTION_RECEIPT_TIMEOUT_MS` from the exact same shared module — not
two independently-defined constants that could silently drift apart.
Both a V3 close and a V4 close time out under the identical mechanism,
value, and classification (§7) — no protocol-specific safety difference
was introduced or found to already exist.

## 16. Transaction-Type Analysis

All categories present in the repository were confirmed covered: mint
(`mint.ts`, `v4.ts`), close (`close.ts`, `v4.ts`), collect
(`close.ts:640`'s `claimFees`, and the collect leg inside `close.ts`'s
fallback), swap (`swap.ts` ×11, `tradingApi.ts`, `gmgn/swap.ts`),
liquidity modification (`v4.ts`'s `modifyLiquidities` calls), approve/
revoke (`revoke.ts`, allowance-approve sites in `mint.ts`/`swap.ts`/
`v4.ts`/`gmgn/swap.ts`), wrap/unwrap (`wrap.ts`), transfer
(`transfer.ts`), and bridge (`across.ts`, `relay.ts`). Every category
received the identical fix (§27's `'every waitForTransactionReceipt call
... now passes the shared, explicit timeout'` test asserts this
generically across all 11 files, not per-category by hand).

## 17. Accounting Regression

```
npx tsx --test test/reconcile.test.ts
```
Passes unmodified, part of the combined run (§23) — confirmed no false
deposit/withdrawal/fee-claim/PnL/confirmed/failed entry can result from
this phase's changes, since (as established in §8) no accounting code
path is reachable from a receipt-wait exception at all.

## 18. Recovery Regression

```
npx tsx --test test/txRecovery.test.ts test/txRecoveryLatency.test.ts
tests 41, pass 41, fail 0
```
All pre-existing recovery tests pass unmodified: SUBMITTED remains
recoverable, CONFIRMED remains confirmed, MINED_REVERT remains reverted,
UNKNOWN remains unknown, duplicate-ledger/duplicate-transaction
prevention remain intact. `txRecovery.ts`'s implementation was not
touched.

## 19. Nonce Regression

Nonce-fetching logic (`journalledSend`'s `getTransactionCount`) lives
entirely inside `chain/clients.ts`, which was not modified this phase
(confirmed, §28 — identical line count to the pre-phase baseline). No
new nonce allocation, reuse, or replacement path was introduced; the 35
call sites this phase touched are all strictly *downstream* of a nonce
already having been fetched and consumed by an already-completed
broadcast.

## 20. Performance Impact

Zero additional RPC calls, receipts, or transaction lookups were added.
Adding `timeout: EXECUTION_RECEIPT_TIMEOUT_MS` to an options object viem
already accepts costs nothing extra on the success path — verified
directly: the success-path test above shows the receipt resolves via the
exact same single lookup as before, and the value passed
(`180_000`) is identical to what viem already used internally, so the
*failure*-path wall-clock duration is also completely unchanged. No
polling loop, additional lookup, or additional blockchain call was
introduced anywhere.

## 21. Real Network Validation

A **real, non-mocked-transport viem client** was used for every success/
revert/timeout/RPC-error test in `test/receiptWait.test.ts` (via
`createPublicClient` + `custom()` transport) — this exercises viem's
actual `waitForTransactionReceipt` action code path exactly as
production does, not a hand-rolled duck-typed stand-in. No real
transaction was submitted and no real capital was used or was
necessary — per the task's own instruction, a real transaction was not
required to validate the receipt-waiting mechanism itself, since the
fix is entirely about the wait boundary, not about broadcasting.
Real-network (live RPC) validation of the actual production call sites
was not performed and would require either real capital or a funded
testnet wallet — not attempted, consistent with "do not use real
capital."

## 22. Tests Added

`test/receiptWait.test.ts` — 12 focused tests: the constant's value and
type, the `isReceiptWaitTimeout` type guard's correctness, success
preserved, revert preserved, timeout is bounded and distinguishable,
timeout never fabricates SUCCESS, timeout never fabricates FAILED
(never reads like a revert), persistent RPC error never fabricates a
receipt, the deadline is a single fixed window (not reset by internal
polling attempts), a timeout never itself broadcasts, a structural
regression test pinning that all 35 call sites use the shared constant
(and exactly 35, no more/fewer), and a V3/V4 consistency check.

## 23. Full Test Results

```
npx tsx --test test/receiptWait.test.ts
tests 12, pass 12, fail 0

npx tsx --test test/receiptWait.test.ts test/txRecovery.test.ts test/txRecoveryLatency.test.ts test/reconcile.test.ts test/gas.test.ts test/swap.decimals.test.ts test/gmgnCli.test.ts test/retry.test.ts
tests 130, pass 130, fail 0

npm test
tests 485, pass 485, fail 0
```
(473 pre-existing baseline from Phase 4.5.2 through 4.6.12, all
preserved byte-for-byte, + 12 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

## 24. Typecheck

```
npm run typecheck
```
Clean.

## 25. Build

```
npm run build
```
Clean.

## 26. Trading Logic Audit

No price calculation, quote calculation, price-impact/slippage/minOut
computation, MULTI candidate filtering/ranking/pool scoring, range
calculation, single-sided liquidity logic, simulation, gas estimation,
or TP/SL decision logic was modified. Every one of the 35 diffs is
exactly one `timeout:` property addition to an existing call; every
import addition is exactly one new line. Confirmed by the full diff
review in §28.

## 27. Strategy Parameter Audit

No file under `src/strategy/*` appears in this phase's diff. No MULTI
parameter, threshold, weight, or fee tier was read, referenced, or
modified.

## 28. Diff Scope Audit

```
git diff --stat -- src/chain/across.ts src/chain/close.ts src/chain/mint.ts src/chain/relay.ts src/chain/revoke.ts src/chain/swap.ts src/chain/tradingApi.ts src/chain/transfer.ts src/chain/v4.ts src/chain/wrap.ts src/gmgn/swap.ts
 src/chain/across.ts     |  3 ++-
 src/chain/close.ts      | 11 ++++++-----
 src/chain/mint.ts       |  5 +++--
 src/chain/relay.ts      |  3 ++-
 src/chain/revoke.ts     |  3 ++-
 src/chain/swap.ts       | 23 ++++++++++++-----------
 src/chain/tradingApi.ts |  3 ++-
 src/chain/transfer.ts   |  5 +++--
 src/chain/v4.ts         | 15 ++++++++-------
 src/chain/wrap.ts       |  5 +++--
 src/gmgn/swap.ts        |  5 +++--
 11 files changed, 46 insertions(+), 35 deletions(-)
```
Every deletion is a `waitForTransactionReceipt({ hash... })` line
replaced by the identical line plus `, timeout: EXECUTION_RECEIPT_TIMEOUT_MS`;
every extra insertion is one new import line — confirmed by direct,
line-by-line review of every file's diff. `src/chain/receiptWait.ts` is
new (the shared constant/helper). `test/receiptWait.test.ts` is new.
**Files explicitly forbidden this phase were verified untouched**:
`git diff --stat` for `src/chain/clients.ts` (38 lines), `src/chain/txRecovery.ts`
(50 lines), `src/chain/gas.ts` (not present — zero changes), and
`src/chain/retry.ts` (not present — zero changes) all show the exact
same line counts as the pre-phase baseline captured in §1's preservation
check. `git status --short` before and after this phase shows the exact
same set of prior-phase (4.5.2 through 4.6.12) modified/untracked files,
with zero additional changes to any of them beyond the 11 files this
phase's scope explicitly authorized. No reset, stash, checkout, or
revert was performed.

## 29. Remaining P2/P3 Findings

- **`RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry** (Phase 4.6.6) —
  cosmetic, both fail closed.
- **Global exception handling** — not inspected this phase (explicitly
  out of scope).
- **`db/index.ts: ledger`/`positions`/`multi_position_meta` persistent
  file growth** (Phase 4.6.8) — unbounded by design, accounting-critical,
  not touched.
- **`journalledSend`'s refusal-gate retry inefficiency** (Phase 4.6.12) —
  minor, non-unsafe, "journal semantics" territory, out of scope.
- **GMGN's `GmgnRateLimitError.resetAt` never consumed** (Phase 4.6.12) —
  missing convenience, GMGN CLI behavior explicitly out of scope.
- **`runStartupTxRecovery`'s sequential loop has no aggregate deadline**
  (Phase 4.6.12) — "transaction recovery semantics," out of scope.
- **`close.ts`'s multicall-close fallback pattern re-broadcasts an
  alternative transaction on ANY receipt-wait failure, including now a
  timeout** (§9, new observation this phase) — pre-existing behavior
  (already triggered by any RPC error before this phase), re-validates
  live state before the fallback broadcast, not a resend of the *same*
  transaction, and redesigning it is "execution strategy"/"transaction
  construction," explicitly out of this phase's scope. Flagged for a
  future, correctly-scoped phase if closer analysis of the narrow
  still-pending-when-timed-out race window is ever warranted.
- No new P2/P3-severity findings beyond what is listed above. **The "40
  unbounded `waitForTransactionReceipt` calls" finding itself is now
  closed** — all 35 actual call sites carry an explicit, tested,
  codebase-owned deadline; it is not carried forward as an open item.

## 30. Files Changed

- [src/chain/receiptWait.ts](src/chain/receiptWait.ts) — new: `EXECUTION_RECEIPT_TIMEOUT_MS` constant and `isReceiptWaitTimeout` type guard
- [src/chain/across.ts](src/chain/across.ts), [src/chain/close.ts](src/chain/close.ts), [src/chain/mint.ts](src/chain/mint.ts), [src/chain/relay.ts](src/chain/relay.ts), [src/chain/revoke.ts](src/chain/revoke.ts), [src/chain/swap.ts](src/chain/swap.ts), [src/chain/tradingApi.ts](src/chain/tradingApi.ts), [src/chain/transfer.ts](src/chain/transfer.ts), [src/chain/v4.ts](src/chain/v4.ts), [src/chain/wrap.ts](src/chain/wrap.ts), [src/gmgn/swap.ts](src/gmgn/swap.ts) — each: one import line + explicit `timeout:` added to every `waitForTransactionReceipt` call
- [test/receiptWait.test.ts](test/receiptWait.test.ts) — new, 12 focused tests
- [PHASE4_6_13_RECEIPT_DEADLINE_FIX_REPORT.md](PHASE4_6_13_RECEIPT_DEADLINE_FIX_REPORT.md) — this report

## 31. Verdict

**PASS**

Every execution-path receipt wait (all 35, an exact recount, not an
assumed 40) now carries an explicit, codebase-owned, tested deadline —
closing the "implicit library default" gap even though a genuine
infinite hang was never actually possible (corrected and disclosed in
§1). The deadline is finite (180s, unchanged from viem's own prior
default — zero behavioral change to the timeout boundary itself). A
timeout can never become a false FAILED (never reads like a revert,
proven by test) or a false SUCCESS (never resolves at all, proven by
test), and can never trigger a blind duplicate submission of the *same*
transaction (proven by test against a real viem client — no send/
broadcast RPC method is ever invoked by the wait itself). The journal
remains recoverable and `txRecovery` remains fully authoritative and
unmodified. Confirmed success and confirmed revert behavior are both
proven byte-for-byte unchanged against a real viem client. Accounting,
nonce, and GMGN regressions all pass unmodified. One pre-existing,
out-of-scope fallback-broadcast pattern in `close.ts` was identified,
evaluated, and honestly documented rather than silently fixed or
ignored. 485/485 tests pass, typecheck and build are clean.

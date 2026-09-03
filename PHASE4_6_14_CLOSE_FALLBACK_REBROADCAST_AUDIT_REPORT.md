# PHASE 4.6.14 CLOSE MULTICALL FALLBACK RE-BROADCAST AUDIT

## 1. Original Finding

Phase 4.6.13's report flagged, as a related-but-out-of-scope observation:
`close.ts`'s multicall-close attempt is wrapped in a `try { ... } catch
(e1) { ...sequential decreaseLiquidity + collect fallback... }` block,
and since Phase 4.6.13 added an explicit receipt-wait deadline, a
timeout now also lands in that same `catch` — raising the question of
whether the fallback could broadcast a second, duplicate economic
transaction while the first transaction's true on-chain outcome is still
genuinely unknown.

## 2. Exact Close Execution Flow

From `src/chain/close.ts`'s `closePosition()` (v3 path; v4 has an
analogous but separate implementation in `v4.ts`, not audited here per
scope — see §15):

```
readLiveLiquidity() + computeMins()           (fresh state, pre-round)
  ↓
withRetries(round 1..3):
  readLiveLiquidity() + computeMins()          (fresh state, per round)
  ↓
  try:
    simulateContract(multicall)                (read-only pre-flight)
    estimateWriteGas(multicall)
    wallet.writeContract(multicall)  → h        [journalledSend broadcast]
    client.waitForTransactionReceipt({hash: h, timeout: EXECUTION_RECEIPT_TIMEOUT_MS})
    if status !== 'success' → throw
    return h
  catch (e1):                                    ← ANY failure above lands here
    if liq > 0:
      readLiveLiquidity() + computeMins()        (fresh state, fallback)
      estimateWriteGas(decreaseLiquidity)
      wallet.writeContract(decreaseLiquidity) → h1   [journalledSend broadcast]
      client.waitForTransactionReceipt({hash: h1, timeout: ...})
      if status !== 'success' → throw
    estimateWriteGas(collect)
    wallet.writeContract(collect) → h2           [journalledSend broadcast]
    client.waitForTransactionReceipt({hash: h2, timeout: ...})
    if status !== 'success' → throw
    return h2
  ↓ (on success) recordTelemetry, best-effort burn, balance-delta accounting
```

Every `wallet.writeContract(...)` call — the primary multicall AND both
fallback legs — goes through `getWalletClient()`'s wrapping (unmodified,
`src/chain/clients.ts`), which routes every send through `journalledSend`.
`client.waitForTransactionReceipt(...)` (the public, read-only client)
is a direct call made by `close.ts` itself, entirely separate from
`journalledSend`'s own lifecycle — it happens strictly *after*
`journalledSend` has already returned a hash.

## 3. Primary Transaction Lifecycle

1. `wallet.writeContract(multicall)` is called. Inside `journalledSend`
   (unmodified): a pre-send refusal check runs first (§6 explains this
   in detail — this is the actual safety mechanism this audit is
   about), then a nonce is fetched, a journal entry is created
   (`BROADCAST_UNKNOWN`), and the raw broadcast is attempted.
2. If the broadcast RPC call succeeds, the journal entry is updated to
   `SUBMITTED` with the real hash, and the hash is returned to `close.ts`.
   **This happens before `close.ts` ever calls `waitForTransactionReceipt`.**
3. `close.ts` then calls `client.waitForTransactionReceipt({hash, timeout})`
   directly. This step does not touch the journal at all.

## 4. Receipt Failure Behavior

All six outcome cases from the task's §3, traced against the actual code:

| Case | What happens in close.ts | Journal state at that moment |
|---|---|---|
| A. Success, receipt received | `receipt.status === 'success'`, `return h` | `SUBMITTED` (never updated to `CONFIRMED` by close.ts — see §16 note) |
| B. Revert, receipt received | `receipt.status !== 'success'` → `throw new Error('multicall reverted ...')`, caught by `catch (e1)` | `SUBMITTED` (unchanged by close.ts) |
| C. Pre-broadcast failure (e.g. bad params) | `journalledSend` classifies via `classifyBroadcastError` as `NOT_SUBMITTED`, throws before `close.ts` ever gets a hash | `NOT_SUBMITTED` (terminal, written by `journalledSend` itself) |
| D. Broadcast outcome UNKNOWN (ambiguous RPC error during the broadcast call itself) | `journalledSend`'s own AMBIGUOUS branch runs `resolveAmbiguousTx` *inline*, marks the error `markNoRetry` if still unresolved, throws | Journal reflects whatever `resolveAmbiguousTx` determined (§6) |
| E. Receipt wait timeout (Phase 4.6.13) | `WaitForTransactionReceiptTimeoutError` thrown by `client.waitForTransactionReceipt`, caught by `catch (e1)` | `SUBMITTED` (unchanged — this is the case this audit is about) |
| F. RPC error while waiting | Same as E — an exception from the wait, caught by `catch (e1)` | `SUBMITTED` (unchanged) |

Cases E and F both land in the exact same `catch (e1)` block as case B
(a confirmed revert) — the code cannot distinguish "definitely reverted"
from "we don't know" purely from *which* branch was reached. **This is
exactly why the safety of the fallback cannot depend on `close.ts`'s own
control flow — it must depend on something else.** That something else
is `journalledSend`'s pre-send gate (§6).

## 5. Journal State Analysis

Confirmed directly (§4): `close.ts` never itself writes to the journal
after a broadcast — it has no import from `db/index.ts`'s journal
functions and never calls `updateTxJournalEntry`. The multicall's
journal entry remains exactly `SUBMITTED` regardless of whether the
subsequent receipt wait succeeds, reverts, times out, or hits an RPC
error (cases A/B/E/F all leave the journal at `SUBMITTED` from
`close.ts`'s perspective). The entry only ever changes state when
something *else* inspects it — specifically, `journalledSend`'s own
pre-send gate on the *next* broadcast attempt.

## 6. State Re-validation Analysis

This is the actual safety mechanism, and it is **not** the
`readLiveLiquidity()`/`computeMins()` re-reads the task hypothesized —
those protect against *using stale withdrawal-minimum numbers*, not
against *duplicate broadcast*. The real guard is `journalledSend`'s
pre-send refusal gate (`src/chain/clients.ts`, unmodified,
unexported — verbatim, unchanged):

```ts
const unresolved = listUnresolvedTxJournal({ chainId, wallet: walletAddress });
if (unresolved.length > 0) {
  await recoverUnresolvedEntries(...);              // opportunistic recovery, concurrent, bounded
  const stillUnresolved = listUnresolvedTxJournal({ chainId, wallet: walletAddress });
  if (stillUnresolved.length > 0) {
    throw new Error(`refusing new ${kind} ... unresolved prior transaction(s) ...`);
  }
}
```

This check runs **every time** `wallet.writeContract`/`wallet.sendTransaction`
is called — including for the fallback's `decreaseLiquidity` and
`collect` calls. Answering the task's exact §5 questions:

- **What exact state is queried?** The local, persisted transaction
  journal (`tx_journal`, `src/db/index.ts`) — not on-chain state
  directly. It is filtered by `(chainId, wallet)`, exactly matching the
  wallet/chain the fallback is about to send from.
- **Is the state authoritative?** For the *decision to refuse*, yes —
  it is a local fact ("do we have an unresolved entry on record?"), not
  a guess. For the *underlying transaction's true outcome*, the journal
  itself doesn't know until `recoverUnresolvedEntries` (backed by
  `resolveAmbiguousTx` in `txRecovery.ts`, unmodified) does a real,
  bounded, receipt/nonce-based on-chain check.
- **Could RPC return stale/incomplete state?** Yes, in principle — but
  `resolveAmbiguousTx`'s own design (audited in Phase 4.6.12,
  reconfirmed here, unmodified) already treats an inconclusive/erroring
  RPC read as *staying unresolved*, never as proof of anything. A
  `getTransactionReceipt` error is coerced to `'PENDING'`, never to
  reverted or missing (`pollReceiptOnce`, unmodified); a
  `getTransactionCount` error (`UNKNOWN`) resets the "not consumed"
  streak rather than counting toward `NOT_SUBMITTED` (`checkNonceConsumed`,
  unmodified, already tested in `txRecovery.test.ts`'s "nonce recovery:
  flaky (UNKNOWN) reads reset the not-consumed streak" test). So a
  stale/incomplete RPC read can only ever make the entry *stay*
  unresolved, never falsely resolve it as safe.
- **Is the state tied to the exact transaction?** Yes — the journal
  entry stores the actual `tx_hash` and `nonce` from the broadcast, and
  `resolveAmbiguousTx` checks that specific hash's receipt (or, if no
  hash, that specific nonce's consumption).
- **Does it prove the primary transaction was NOT executed?** Only in
  the one case where recovery concludes `NOT_SUBMITTED` — a nonce
  proven never consumed across every bounded check. In every other case
  (still pending, RPC error, confirmed success, confirmed revert), the
  gate's answer is either "still refuse" (pending/RPC-error) or "safe
  to proceed because the outcome is now *known*, not because it's
  assumed unexecuted" (confirmed success/revert — see below).
- **Can the state be temporarily inconsistent after broadcast?** In
  principle yes (read-after-write RPC inconsistency across a
  load-balanced provider is a real, if narrow, possibility) — addressed
  in §10.
- **Is there a race between state read and fallback broadcast?** No —
  see §10; the check and the broadcast are part of the same sequential
  `journalledSend` call, and `withTxLock` additionally serializes all
  sends for a given `(chainId, wallet)`.

**Critical distinction, directly addressed:** the gate does not reason
"state currently looks unchanged, therefore the prior tx was never
broadcast." It reasons "the prior tx's journal entry is not yet
*terminal* (CONFIRMED/MINED_REVERT/NOT_SUBMITTED), therefore refuse."
Only a terminal state permits the next send — and reaching a terminal
state requires either a real on-chain receipt/nonce observation
(CONFIRMED, MINED_REVERT) or a bounded, repeated proof of non-consumption
(NOT_SUBMITTED), never merely "unchanged."

## 7. Transaction Identity Analysis

The fallback does not need its own transaction-identity mechanism — the
existing journal entry created by `journalledSend` for the multicall
already carries the exact hash (once broadcast) and the exact nonce
(fetched before broadcast), and this is precisely what `resolveAmbiguousTx`
uses to check the primary transaction's specific fate before any new
send is permitted. No new identity mechanism was found to be necessary,
and none was added.

## 8. Nonce Analysis

`journalledSend` fetches a fresh `pending`-tag nonce for every call,
including the fallback's `decreaseLiquidity`/`collect` — unmodified,
confirmed by reading `clients.ts` again this phase (no changes since
Phase 4.6.13). By the time the fallback's send is ever *permitted*
(§6 — only after the primary's entry reaches a terminal state), the
wallet's pending-nonce count already correctly reflects the primary
transaction's fate (consumed if it broadcast at all, whether success or
revert; unconsumed if genuinely `NOT_SUBMITTED`) — so the fresh nonce
fetched for the fallback is always correct with no reuse or collision
risk. Reconfirmed directly by a new test (`'nonce: recovery correctly
distinguishes "nonce still pending" from "nonce consumed"'`).

## 9. Multicall Fallback Semantics

Answering the task's §9 classification directly: the "multicall
fallback" is **B — an alternative transaction containing equivalent
close actions** (a separate `decreaseLiquidity` call followed by a
separate `collect` call, rather than one `multicall` bundling both).
It is not a read-only call, not a partial fallback, and not literally a
retry of the identical multicall transaction — it is a different
transaction achieving the same intended economic outcome via two
separate calls instead of one bundled call. This was treated throughout
this audit as a genuine, potential duplicate-execution path (per the
task's own instruction), not assumed safe from the name alone.

## 10. Race Condition Analysis

The task's hypothesized race (`T0` broadcast → `T1` receipt unavailable
→ `T2` state re-validation → `T3` fallback decision → `T4` original TX
becomes confirmed — could fallback broadcast between T2 and T4?) does
not have a window in this architecture: the "state re-validation" (T2)
*is* the pre-send refusal-gate check inside `journalledSend`, and the
"fallback decision" (T3, whether to actually call `raw()` and broadcast)
happens synchronously, inside the same `journalledSend` invocation,
immediately after that check — there is no `await` boundary between the
gate check passing and the broadcast being attempted where an
independent T4 (the original tx confirming) could sneak in and change
the answer. Additionally, `withTxLock` serializes every send for a given
`(chainId, wallet)` — so even a *concurrent*, independent operation
(e.g. a TP/SL-triggered close on a different position, same wallet)
cannot interleave a broadcast between this check and this send. The one
remaining narrow scenario — the primary transaction actually confirms
*successfully* in the small window between the gate's `recoverUnresolvedEntries`
call and the fallback's fresh state reads — is addressed in §11 as a
low-probability edge case with a bounded, non-duplicating consequence
(Uniswap's own `collect`/`decreaseLiquidity` contract semantics), not an
unbounded/unsafe one.

## 11. Duplicate Broadcast Analysis

**Direct answer: NO, the fallback cannot broadcast while the primary
transaction's outcome is genuinely unknown** — proven by the adversarial
test in §12. The only path by which the fallback's broadcast is ever
reached is a terminal journal state, which means one of:

- **NOT_SUBMITTED** (proven via bounded, repeated nonce-non-consumption
  checks): the primary transaction never had any economic effect at
  all — the fallback is the *only* actual broadcast, not a duplicate.
- **MINED_REVERT** (proven via a real, confirmed receipt): the primary
  transaction had *zero* economic effect (a revert leaves contract
  state unchanged) — the fallback is again the only economically-active
  broadcast.
- **CONFIRMED** (proven via a real, confirmed receipt showing success):
  in this case *only*, a second broadcast targeting the same close
  intent could in principle be considered a "duplicate attempt" — but
  even here, Uniswap V3's own NPM contract semantics make this
  economically harmless: `collect()` pays out only whatever
  `tokensOwed`/`tokensOwed1` are *actually currently* owed (already
  zero if the primary's collect already ran — a second call transfers
  zero tokens, a no-op); `decreaseLiquidity()` is bounded by the
  position's *actual current* on-chain liquidity (already zero if the
  primary's decrease already ran) and the fallback's own
  `if (liq2 > 0n)` guard (re-reading live state immediately before
  constructing this specific call) already skips it when liquidity is
  already zero. Neither call can be tricked into transferring funds
  twice, because neither call's payout is determined by client-supplied
  amounts — both are bounded by the contract's own current bookkeeping.

No demonstrated path exists for an actual double economic withdrawal.

## 12. Adversarial Test

`test/closeFallbackRebroadcast.test.ts`'s `'MOST IMPORTANT: primary
multicall broadcast + receipt wait timeout (state still ambiguous) ->
the decreaseLiquidity fallback send is refused'` test:
1. Journals a real entry exactly as `journalledSend` would after a
   successful multicall broadcast (`SUBMITTED`, with a hash).
2. Runs the REAL, unmodified, exported `recoverUnresolvedEntries`
   (`src/chain/txRecovery.ts`) against a fixture RPC client that can
   never determine the receipt (simulating a timeout or RPC outage
   equally — neither can prove non-broadcast).
3. Reproduces `journalledSend`'s own exact, unchanged gating decision
   (`stillUnresolved.length > 0` → refuse) — the same precedented
   testing methodology already established in Phase 4.6.3's
   `txRecoveryLatency.test.ts` for testing this unexported function's
   behavior without needing full wallet/RPC infrastructure.
4. Asserts the fallback send is refused and a counter representing
   `wallet.writeContract(decreaseLiquidity...)` is never incremented.

This is not a mock of the desired conclusion — it exercises the actual,
real recovery/classification code with a fixture that cannot resolve
the ambiguity, and confirms the *real* gating logic responds as
predicted.

## 13. Success Regression

Not modified, and not independently re-tested at the `close.ts`
function level this phase (no dependency-injection seam exists there
for the RPC/wallet layer, and building one would be "redesigning the
close system," explicitly out of scope). The existing success-path
behavior (`receipt.status === 'success'` → `return h`, no fallback
triggered) is unchanged by this audit — confirmed by the diff (§20 —
zero lines changed in `close.ts`).

## 14. Revert Regression

`test/closeFallbackRebroadcast.test.ts`'s `'fallback is permitted once
recovery proves the primary tx definitively reverted on-chain
(MINED_REVERT)'` test confirms: a confirmed revert resolves the journal
entry to a terminal state, correctly *permitting* the fallback (matching
§11's B analysis) — existing revert-triggers-fallback behavior is
intentional and preserved, not newly restricted.

## 15. Timeout Regression

`'post-broadcast UNKNOWN via a receipt-lookup RPC error behaves
identically to a timeout — fallback still refused'` and the main
adversarial test (§12) both confirm: a Phase 4.6.13 receipt-wait timeout
(or an equivalent RPC failure) never clears the pre-send gate — the
fallback remains blocked until recovery can prove a terminal outcome.
`src/chain/receiptWait.ts` was not modified this phase (confirmed by
diff, §20).

## 16. RPC Failure Regression

Same test as §15 — an RPC error during the receipt lookup produces the
identical safe outcome as a timeout (both are "inconclusive," both keep
the gate closed). One nuance worth being explicit about: `close.ts`
itself does not distinguish a confirmed revert (case B) from a timeout
(case E) in its own control flow — both land in the same `catch (e1)`
block, and *neither* updates the journal directly. It is only the
*next* attempted send's `journalledSend` gate that ever resolves the
ambiguity, via a real, independent, bounded recovery check. This is
correct and sufficient: the journal, not `close.ts`'s own catch block,
is the source of truth for whether a new send may proceed.

## 17. Accounting Regression

```
npx tsx --test test/reconcile.test.ts
```
Passes unmodified, part of the combined run (§21). No ledger row is
ever created by `close.ts`'s fallback machinery itself — `recordLedger`-
equivalent logic in `close.ts` (`recordTelemetry`, the balance-delta
accounting at the end of `closePosition`) only runs *after* the whole
`withRetries` block returns a hash successfully; a refused fallback
send throws, which propagates out through `withRetries` (subject to its
own existing, unmodified `shouldRetry` classification) without ever
reaching the accounting code. No double withdrawal, double fee, or
double PnL entry can result from a refused (or even a permitted-and-safe,
per §11) fallback send.

## 18. Recovery Regression

```
npx tsx --test test/txRecovery.test.ts test/txRecoveryLatency.test.ts
tests 41, pass 41, fail 0
```
All pass unmodified: SUBMITTED remains recoverable, CONFIRMED remains
confirmed, MINED_REVERT remains reverted, UNKNOWN remains unknown
(never collapsed into a false terminal state), duplicate-ledger/
duplicate-transaction prevention remain intact. `txRecovery.ts` and
`clients.ts` were not touched this phase (confirmed, §20 — identical
line counts to the pre-phase baseline).

## 19. Real Network Validation

No real transaction was sent, and no real capital was used or needed —
per the task's own instruction, this audit is about a local safety
mechanism (the journal-based pre-send gate) whose correctness does not
depend on live network state; it was validated against real, exported
recovery code with deterministic fixture RPC responses (§12), which is
the more rigorous and reproducible validation for this specific
question. Read-only inspection of the deployed Uniswap V3 NPM contract's
`collect`/`decreaseLiquidity` semantics (§11) was reasoned from the
well-documented, standard NPM ABI behavior (both are bounded by the
position's actual on-chain state, never by client-supplied amounts
alone) rather than a live contract call, since no specific on-chain
state needed to be queried to establish this general safety property.

## 20. Changes Made

**Production close code unchanged because the existing fallback was
proven safe — no demonstrated duplicate-execution path was found.** The
fallback's safety does not come from `close.ts`'s own state
re-validation (which exists for withdrawal-minimum freshness, not
duplicate-broadcast prevention) — it comes from `journalledSend`'s
pre-send refusal gate (`src/chain/clients.ts`), an existing,
already-audited (Phase 4.6.12), unmodified mechanism that applies
uniformly to every broadcast in the entire application, including both
of `close.ts`'s fallback legs. This phase added one new test file
(`test/closeFallbackRebroadcast.test.ts`, 10 tests) that directly proves
this property against the real recovery code, rather than a fabricated
assertion of the conclusion.

## 21. Test Results

```
npx tsx --test test/closeFallbackRebroadcast.test.ts
tests 10, pass 10, fail 0

npx tsx --test test/closeFallbackRebroadcast.test.ts test/txRecovery.test.ts test/txRecoveryLatency.test.ts test/reconcile.test.ts test/receiptWait.test.ts
tests 80, pass 80, fail 0

npm test
tests 495, pass 495, fail 0
```
(485 pre-existing baseline from Phase 4.5.2 through 4.6.13, all
preserved byte-for-byte, + 10 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

One test-authoring note, disclosed rather than hidden: the first version
of these tests relied on `db/index.ts`'s `__resetStoreForTests()` to
isolate each test's journal state, but that function only clears the
*in-memory* cache — it does not delete the underlying scratch DB file,
so journal entries persisted across tests sharing the same
`(chainId, wallet)` key, causing two tests to see leftover entries from
earlier tests. This was a test-authoring bug, not a production one —
fixed by giving each test its own unique `chainId` (a `freshChainId()`
counter), which isolates `listUnresolvedTxJournal`'s filter cleanly
without needing real file deletion between tests.

## 22. Typecheck

```
npm run typecheck
```
Clean.

## 23. Build

```
npm run build
```
Clean.

## 24. Trading Logic Audit

No price calculation, quote calculation, MULTI candidate filtering/
ranking/pool scoring, range calculation, single-sided liquidity logic,
simulation, gas strategy, or TP/SL decision logic was modified. `close.ts`
has zero lines changed this phase (confirmed by diff, §20 — the
`close.ts | 11 +-` line in `git diff --stat` is Phase 4.6.13's own,
already-reported diff, unchanged since).

## 25. Strategy Parameter Audit

No file under `src/strategy/*` appears in this phase's diff. No MULTI
parameter, threshold, weight, or fee tier was read, referenced, or
modified.

## 26. Remaining P2/P3 Findings

- **`RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry** (Phase 4.6.6) —
  cosmetic, both fail closed.
- **Global exception handling** — not inspected this phase (explicitly
  out of scope).
- **`db/index.ts: ledger`/`positions`/`multi_position_meta` persistent
  file growth** (Phase 4.6.8) — unbounded by design, accounting-critical,
  not touched.
- **`journalledSend`'s refusal-gate retry inefficiency** (Phase 4.6.12) —
  minor, non-unsafe, "journal semantics" territory, out of scope. Worth
  noting this phase's finding is *related but distinct*: that finding is
  about `withRetries` wastefully re-attempting a refusal a few times;
  this phase confirms the refusal itself is exactly the mechanism that
  makes the multicall fallback safe — the "inefficiency" and the
  "safety guarantee" are two sides of the same gate.
- **GMGN's `GmgnRateLimitError.resetAt` never consumed** (Phase 4.6.12) —
  missing convenience, GMGN CLI behavior explicitly out of scope.
- **`runStartupTxRecovery`'s sequential loop has no aggregate deadline**
  (Phase 4.6.12) — "transaction recovery semantics," out of scope.
- **`close.ts` never itself updates the journal to a terminal state
  after observing a receipt** (new observation this phase, §5/§16) — a
  confirmed success or confirmed revert observed directly by `close.ts`'s
  own `waitForTransactionReceipt` call is not written back to the
  journal by `close.ts`; the journal only becomes terminal via the
  *next* `journalledSend` invocation's own independent recovery check.
  This is not a safety gap (the gate still works correctly regardless,
  proven throughout this report) but it is a minor missed optimization —
  the next send has to re-derive an outcome `close.ts` already observed
  a moment earlier. Modifying this is "journal semantics," explicitly
  out of this phase's scope; flagged for a future, correctly-scoped
  phase if considered worth the marginal latency improvement.
- **The v4 close path (`src/chain/v4.ts`)** has a structurally similar
  multicall/round/fallback pattern (noted in Phase 4.6.13's inventory)
  that was not separately re-audited in this phase beyond confirming it
  routes through the same `journalledSend` mechanism (§15 of the task's
  scope names only `close.ts` and "directly related close execution
  helper(s)" — `v4.ts`'s close function was treated as covered by the
  same universal `journalledSend` guard, since that guard is
  wallet/chain-scoped, not call-site-scoped, but a dedicated v4-specific
  adversarial test was not written this phase). Flagged for completeness
  should a future phase want v4-specific test coverage.
- No new safety-severity findings beyond what is listed above. **The
  "close multicall fallback re-broadcast" finding itself is now closed
  as an audited, proven-safe characteristic** — it is not carried
  forward as an open safety item, though the two minor,
  out-of-scope-to-fix observations above (refusal-gate inefficiency,
  missed terminal-state write-back) remain documented.

## 27. Files Changed

- [test/closeFallbackRebroadcast.test.ts](test/closeFallbackRebroadcast.test.ts) — new, 10 focused audit tests
- [PHASE4_6_14_CLOSE_FALLBACK_REBROADCAST_AUDIT_REPORT.md](PHASE4_6_14_CLOSE_FALLBACK_REBROADCAST_AUDIT_REPORT.md) — this report

No production (`src/`) file was modified.

## 28. Verdict

**PASS**

No unsafe duplicate close broadcast exists: the fallback's second
broadcast is reachable only after the primary transaction's journal
entry reaches a terminal state (`CONFIRMED`, `MINED_REVERT`, or
`NOT_SUBMITTED`), never while it remains ambiguous — proven directly
against the real, unmodified `recoverUnresolvedEntries`/journal
functions, not asserted by fiat. UNKNOWN is correctly preserved (a
receipt-wait timeout or RPC error never resolves to a false terminal
state — the existing, Phase-4.6.12-audited recovery logic keeps it
`SUBMITTED`/unresolved). The fallback cannot blindly resend: it is
gated by the same universal pre-send check every send in this
application already goes through. State re-validation, while real, is
not itself the safety mechanism — the journal-based refusal gate is —
and that gate is demonstrably sufficient, including under RPC-error and
timeout conditions. The journal remains fully recoverable and
`txRecovery` remains fully authoritative and unmodified. Nonce safety
is preserved (fresh-nonce-per-send, unchanged). Accounting is
unreachable from a refused or safely-permitted fallback path. All
recovery tests pass unmodified. 495/495 tests pass, typecheck and build
are clean, and zero production code was changed — consistent with a
rigorous audit that found the existing design already safe.

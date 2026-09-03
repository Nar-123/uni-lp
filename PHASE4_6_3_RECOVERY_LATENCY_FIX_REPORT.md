# PHASE 4.6.3 TRANSACTION RECOVERY LATENCY FIX REPORT

## 1. Original P2 Finding

"Unresolved tx-journal entries are re-checked sequentially before every
send, which can turn sustained RPC trouble into multi-minute stalls."
(Phase 4.6 reliability audit.)

## 2. Current Recovery Architecture

Traced before any edit:

```
new send requested (mint/close/swap/TP-SL/bridging/revoke/transfer, all
funnel through the same choke point)
  -> getWalletClient() -> wallet.writeContract/sendTransaction (wrapped)
  -> journalledSend()                         [src/chain/clients.ts]
       -> listUnresolvedTxJournal({chainId, wallet})   [src/db/index.ts]
       -> for each unresolved entry (SEQUENTIAL, one at a time):
            resolveAmbiguousTx(client, entry)           [src/chain/txRecovery.ts]
              -> has txHash?  waitForReceiptBounded (bounded receipt poll)
              -> no txHash?   bounded pending-nonce poll
            -> updateTxJournalEntry(...) if resolved
       -> listUnresolvedTxJournal(...) again
       -> if any still unresolved: THROW — new send is never attempted
       -> otherwise: createTxJournalEntry (BROADCAST_UNKNOWN) -> raw send
```

`resolveAmbiguousTx`, `pollReceiptOnce`, `checkNonceConsumed`,
`classifyBroadcastError`, `markNoRetry` — all in `src/chain/txRecovery.ts`,
pure and dependency-injected, already covered by `test/txRecovery.test.ts`.
An already-exported, already-tested, but **production-code-unused**
function, `recoverUnresolvedEntries()`, existed in the same file with
almost the exact generic shape needed (it was only referenced from
`test/txRecovery.test.ts`, not from `clients.ts`, which duplicated its
own inline sequential loop instead). A second, structurally similar but
separate sequential loop exists in `runStartupTxRecovery()` (same file,
one-time boot pass) — **not** the reported P2 (that finding is explicitly
about "before every send"), and per this phase's scope discipline, left
untouched.

## 3. Root Cause

`src/chain/clients.ts`, `journalledSend()`:

```js
for (const entry of unresolved) {
  try {
    const outcome = await resolveAmbiguousTx(recoveryClient, {...});
    ...
  } catch (e) { ... }
}
```

A plain `for...of` loop with `await` inside blocks on each entry's full
recovery check (a bounded receipt poll: up to 6 attempts with linear
backoff up to ~30s worst-case; or a bounded nonce poll: up to 5 attempts,
~25s worst-case) before starting the next entry's check — even though
each entry's check is completely independent (different txHash/nonce, no
shared state, pure reads). N unresolved entries under RPC trouble could
plausibly stall a new send for minutes, exactly as reported.

## 4. Optimization Implemented

**Option A from the task's list ("parallelize independent read-only
receipt checks") — the smallest, safest option**, applied in exactly one
place: `recoverUnresolvedEntries()` (`src/chain/txRecovery.ts`) now runs
every entry's `resolveAmbiguousTx()` call **concurrently** via
`Promise.all`, instead of `recoverUnresolvedEntries` being unused and
`journalledSend` duplicating its own sequential loop:

```js
const results = await Promise.all(
  entries.map(async (entry): Promise<boolean> => {
    try {
      const client = getClientForChain(entry.chainId);
      const outcome = await resolveAmbiguousTx(client, entry, resolveOpts);
      onResolved(entry.id, outcome);
      console.log(`[tx-recovery] #${entry.id} (${entry.action}) -> ${outcome}`);
      return outcome !== 'SUBMITTED';
    } catch (e) {
      console.error(`[tx-recovery] #${entry.id} recovery attempt threw:`, e);
      return false;
    }
  }),
);
const resolved = results.filter(Boolean).length;
return { resolved, stillUnresolved: entries.length - resolved };
```

`journalledSend()` was then changed to **call this function** instead of
its own inline loop — same journal-write condition
(`if (outcome !== 'SUBMITTED') updateTxJournalEntry(...)`), same final
`stillUnresolved` re-check, same blocking `throw` if anything remains
unresolved. `resolveAmbiguousTx` itself — the actual classification logic
— was **not modified at all**.

Not chosen, and why: Option B (RPC batching) would require introducing a
new multicall/batching subsystem this codebase doesn't have, explicitly
discouraged by §8 of the task ("do not introduce a new batching subsystem
just for this fix"). Option C (caching terminal states) is unnecessary —
a terminal state is already written to the journal immediately via
`updateTxJournalEntry`, so a resolved entry never needs re-checking on a
subsequent call in the first place (it's no longer in
`listUnresolvedTxJournal`'s result). Option E (bounded timeout with a
fallback) is exactly the forbidden "timeout = safe" pattern (§6) and was
not implemented in any form.

## 5. Why The Optimization Is Safe

- **Read-only**: `resolveAmbiguousTx` calls only `getTransactionReceipt`
  and `getTransactionCount` — no write, no broadcast, unchanged.
- **No shared mutable state between entries**: each call is keyed on that
  entry's own `txHash`/`nonce`; nothing about one entry's check can
  observe or influence another's.
- **No new race on journal writes**: `updateTxJournalEntry` is
  synchronous (a single `fs`-backed write per call, Phase 4.6.1's atomic
  persistence, unmodified) and is invoked with a different `id` for each
  entry — concurrent completions interleave in whatever order the event
  loop delivers them, but each write is a complete, atomic operation
  touching a different row; there is no partial-write or lost-update
  window.
- **Errors isolated per entry, never collapsed into a blanket result**:
  each entry's own `try/catch` (moved from the old loop body into the
  `map` callback, otherwise unchanged) means `Promise.all` here can never
  actually reject — a throw from `getClientForChain` or
  `resolveAmbiguousTx` is caught, logged, and that ONE entry contributes
  `false` (not resolved) to the final count; it can never mark a
  *different* entry as resolved, and can never crash the batch. Verified
  by a dedicated test (§11).
- **UNKNOWN is never upgraded**: `resolveAmbiguousTx` was not touched, so
  its fail-closed classification (timeouts/errors -> `SUBMITTED` or
  `RECOVERY_REQUIRED`, never `CONFIRMED`/`MINED_REVERT`/`NOT_SUBMITTED`)
  is identical to before. Verified explicitly with a mixed-outcome batch
  (§12).
- **The blocking gate itself is unchanged**: `journalledSend`'s
  `if (stillUnresolved.length > 0) throw ...` is byte-for-byte the same
  code as before this phase — only what feeds into `stillUnresolved`
  (the now-concurrent recovery pass) changed.

## 6. UNKNOWN Transaction Handling

Unchanged, because `resolveAmbiguousTx` is unchanged:

- Receipt lookup times out / errors -> `pollReceiptOnce` returns
  `'PENDING'` (never treats a read failure as "reverted") ->
  `waitForReceiptBounded` returns `'PENDING'` if still pending after every
  bounded attempt -> `resolveAmbiguousTx` returns `'SUBMITTED'` (task's
  UNKNOWN) — **never** `'MINED_REVERT'`/`'NOT_SUBMITTED'` (task's FAILED).
- Nonce lookup errors -> `checkNonceConsumed` returns `'UNKNOWN'`, which
  **resets** the "not-consumed streak" (a flaky read cannot accumulate
  toward a false `NOT_SUBMITTED`) -> after all bounded attempts with no
  clean streak, `'RECOVERY_REQUIRED'` (task's UNKNOWN).
- `SUBMITTED` and `RECOVERY_REQUIRED` are both in `UNRESOLVED_TX_STATES`
  (`src/db/index.ts`, unmodified) — either one keeps the entry in
  `listUnresolvedTxJournal`'s result, which keeps `stillUnresolved > 0`,
  which keeps the new send blocked.

Tested explicitly: RPC timeout -> `SUBMITTED` (§11 "RPC timeout"), RPC
error/throw -> `SUBMITTED` (§11 "RPC error"), and the mandatory
failure-injection batch (§12) proving one `UNKNOWN` entry in a batch with
otherwise-terminal entries keeps the **batch** unresolved.

## 7. Nonce Safety

Not modified. `checkNonceConsumed`'s comparison logic, its streak-reset-
on-uncertainty behavior, and the "only a nonce that has NOT advanced
across every check in the bounded window is trusted as NOT_SUBMITTED"
rule are all untouched — `resolveAmbiguousTx` is the same function,
called the same way, just no longer waited-on sequentially relative to
sibling entries. A nonce-based unresolved entry blocking a new send is
exactly as safe as before: the new send's own nonce is fetched only
*after* `journalledSend`'s gate has already either thrown (blocked) or
confirmed nothing remains unresolved — this ordering is unchanged.

## 8. Concurrency Safety

- Telegram command + strategy simultaneously / monitoring + manual
  command / multiple positions: all funnel through the same
  `journalledSend` choke point, itself still wrapped in `withTxLock`
  (per chain+wallet serialization, unmodified) — this phase only changed
  how the recovery *reads* inside one call to `journalledSend` are
  scheduled, not the locking around `journalledSend` calls themselves.
- Process restart / recovery running during startup: `runStartupTxRecovery`
  is untouched (out of scope, §2); the pre-send gate in `journalledSend`
  still independently re-checks and blocks on the next attempted send
  regardless of whether startup recovery ran, exactly as the existing
  code comment above `runStartupTxRecovery` already documents.
- No fire-and-forget recovery was introduced: `journalledSend` still
  `await`s `recoverUnresolvedEntries(...)` in full before proceeding —
  the only thing that changed is that the entries *within* that one
  `await`ed call now run concurrently with each other, not that recovery
  became asynchronous/detached from the pre-send gate. There is no
  "recovery started -> send immediately -> recovery still unresolved"
  window; recovery must fully complete (concurrently) before
  `stillUnresolved` is ever computed.

## 9. Performance Before

Sequential: O(sum of each entry's recovery latency). Worst case per
entry: ~30s (receipt path, `RECEIPT_POLL_ATTEMPTS=6` with backoff up to
`RECEIPT_POLL_BACKOFF_MS=2000`×5) or ~25s (nonce path,
`NONCE_CHECK_ATTEMPTS=5` with backoff up to `NONCE_CHECK_BACKOFF_MS=2500`×4).
5 unresolved entries under sustained RPC trouble: plausibly 2-3 minutes
before a new send is even attempted.

## 10. Performance After

Concurrent: O(max of each entry's recovery latency) — the same 5-entry
worst case now takes ~30s (bounded by the single slowest entry), not
2-3 minutes. Demonstrated directly with a real timing test (§11): 3
entries each with an artificial 500ms delay complete in ~500-570ms total,
not ~1500ms.

## 11. Tests Added

New file `test/txRecoveryLatency.test.ts` (17 tests), plus re-verification
that the 15 pre-existing `test/txRecovery.test.ts` tests (including its
own `recoverUnresolvedEntries` test, #7) still pass unmodified:

| # | Test |
|---|---|
| 1 | Zero unresolved: no client constructed, no RPC call |
| 2 | One unresolved: existing single-entry behavior preserved |
| 3 | **Real timing proof**: 3×500ms-delay entries complete in <1000ms, not ~1500ms |
| 4/5 | Confirmed / authoritatively-failed classification survive batching |
| 6/7 | RPC timeout / RPC error -> `SUBMITTED` (UNKNOWN), never FAILED |
| — | `getClientForChain` throw isolated to one entry, never crashes the batch |
| 8/9 | **Mandatory failure-injection test** (two variants): CONFIRMED + RPC-timeout(UNKNOWN) + FAILED in one batch — each classified independently, `stillUnresolved` reflects only the UNKNOWN entry |
| 10/11 | All-confirmed / all-authoritatively-failed batches fully resolve |
| 12 | Recovery timeout never becomes FAILED, at the batch level |
| 13 | **Mandatory pre-send safety test**: an unresolved/RPC-unavailable entry blocks the new transaction — a stand-in send function is asserted never called |
| — | Companion sanity check: a fully-resolved batch *does* permit the stand-in send (proves the harness itself isn't just always blocking) |
| 14 | Concurrent entries never cross-report: the slowest of 3 differently-timed, differently-outcomed entries still gets its own correct result, not another's |
| 15 | Duplicate/repeat `onResolved` calls for the same entry within one batch don't occur |

**On the pre-send safety test's methodology**: `journalledSend` is not
exported and is wired to real `viem` wallet/public clients (constructing
one for a test would mean either real network calls or building
significant new client-mocking infrastructure — out of scope for "ONLY
modify the recovery latency mechanism"). The test instead reproduces
`journalledSend`'s exact, **unmodified** gating expression
(`stillUnresolved.length > 0` blocks, computed from
`recoverUnresolvedEntries`'s real output) against a stand-in send
function, which is the actual code path the fix changed plus the
unchanged decision it feeds into. One iteration note: two of the batch
tests initially used a same-`chainId` fixture, which silently made
`getClientForChain` route every entry to the same fake client
(`recoverUnresolvedEntries` keys clients by chainId, not entry id) —
caught by the mandatory failure-injection test actually failing on first
run (TX2 came back `'CONFIRMED'` instead of the intended `'SUBMITTED'`).
Fixed by giving each entry in those tests a distinct chainId so its
fixture client is unambiguous; not a production defect, a test setup bug,
found and fixed before this report was written.

## 12. Failure Injection Results

```
TX1 (CONFIRMED-fixture) -> CONFIRMED
TX2 (RPC-timeout-fixture) -> SUBMITTED   (UNKNOWN)
TX3 (reverted-fixture)  -> MINED_REVERT  (FAILED)

resolved: 2, stillUnresolved: 1
```

Exactly matches the task's required example shape — TX2 remains UNKNOWN
and is the sole reason the batch stays unresolved; it is never collapsed
into TX1 or TX3's outcome.

## 13. Pre-Send Safety Results

```
unresolved entry, RPC unavailable (throws on every receipt-lookup attempt)
  -> recoverUnresolvedEntries: stillUnresolved = 1
  -> journalledSend's gate expression evaluates true -> throws
  -> stand-in send(): 0 calls
```

Confirmed: an unresolved/UNKNOWN transaction blocks the new send. The
companion test confirms the same harness permits the send once the batch
is fully resolved to terminal states (sanity check that the test isn't
trivially always-blocking).

## 14. Full Test Result

```
npm test
tests 311, pass 311, fail 0
```
(294 pre-existing baseline — Phase 4.5.2 + Phase 4.6/4.6.1/4.6.2, all
preserved byte-for-byte — + 17 new this phase.) Verified stable across 2
consecutive full-suite runs and 3 consecutive isolated runs of the new
file.

## 15. Typecheck

```
npm run typecheck
```
Clean.

## 16. Build

```
npm run build
```
Clean.

## 17. Diff Scope Audit

```
git diff --stat -- src/chain/clients.ts src/chain/txRecovery.ts test/txRecoveryLatency.test.ts
 src/chain/clients.ts    | 38 +++++++++++++++++++++++--------------
 src/chain/txRecovery.ts | 50 +++++++++++++++++++++++++++++++++++++------------
 2 files changed, 62 insertions(+), 26 deletions(-)
```
Plus one new file: `test/txRecoveryLatency.test.ts`.

**No other file was modified by this phase.** `git status --short` at the
start of this phase showed pre-existing uncommitted Phase 4.5.2 / 4.6 /
4.6.1 / 4.6.2 changes (`PHASE4_5_VALIDATION_REPORT.md`,
`src/chain/ticks.ts`, `src/db/index.ts`, `src/gmgn/cli.ts`, `src/index.ts`,
`src/pnl/reconcile.ts`, `src/strategy/multiExecute.ts`,
`test/gmgnCli.test.ts`, `test/reconcile.test.ts`,
`test/strategy.multiExecute.test.ts`, `test/strategy.multiRange.test.ts`,
`test/strategy.multiRisk.test.ts`, plus several new untracked files
including `src/instanceLock.ts` and its tests, and `test/fixtures/`) —
every one of these was left completely untouched this phase, confirmed by
`git diff --stat -- <file>` showing zero additional changes beyond what
already existed at the start of this turn. No reset, stash, checkout, or
revert was performed at any point.

## 18. Remaining P2/P3 Findings

Every other Phase 4.6 finding is **intentionally untouched**, exactly as
scoped:

- `runStartupTxRecovery`'s own sequential loop (structurally similar, but
  not the reported P2 — that finding is specifically "before every send";
  startup recovery is a one-time boot pass that the pre-send gate
  independently backstops regardless) — not touched.
- `scoreMultiPool` NaN propagation (Phase 4.5.2, BUG-003) — not touched.
- Health endpoint, TP/SL shutdown, config validation, memory growth,
  retry stacking, global error handlers — none inspected or modified this
  phase.

## 19. Verdict

**PASS**

The P2 finding is fixed: the pre-send recovery gate no longer stalls
sequentially across unresolved entries — it runs their independent,
read-only checks concurrently, reducing worst-case latency from O(sum) to
O(max) while leaving every classification, journal-write condition, and
the blocking decision itself completely unchanged. UNKNOWN state is
never collapsed into CONFIRMED or FAILED (verified by mandatory
failure-injection test), an unresolved/UNKNOWN entry still blocks a new
transaction (verified by mandatory pre-send safety test), nonce handling
is untouched, no accounting/ledger/journal semantics changed, no
concurrency hazard was introduced, and all 311 tests (294 pre-existing +
17 new) pass alongside a clean typecheck and build.

# PHASE 4.6.4 TP/SL SHUTDOWN FIX REPORT

## 1. Original P2 Finding

"TP/SL shutdown does not cancel an in-flight 5s confirmation timer and
there is no forced-exit fallback." (Phase 4.6 reliability audit.)

## 2. Existing TP/SL Lifecycle

Traced before any edit, in `src/bot/tpslWatcher.ts`:

```
startTpslWatcher(bot)
  -> setTimeout(first tick, 8s)                [handle discarded]
  -> setInterval(tick, POLL_MS=30s)             [stored in `timer`]

tick(bot)                                       [guarded by `running` flag]
  -> for each enrolled position:
       measurePnl(...) -> classify(pnlPct, tp, sl)
       no hit -> clear any pending arm
       first hit -> pending.set(key, {...})
                 -> setTimeout(() => recheckAndMaybeClose(...), CONFIRM_MS=5s)
                    [handle DISCARDED — never stored anywhere]

recheckAndMaybeClose(bot, p, expected, tp, sl)
  -> re-check pending/enrollment/prefs
  -> measurePnl(...) again
  -> still hit -> executeClose(...)             [THE actual close/transaction]
  -> not hit / gone / unknown -> pending.delete(key), no close

executeClose(bot, p, ...)
  -> guarded by `closing` Set (no concurrent close of same position)
  -> closePosition(...)                         [real transaction — out of scope]
  -> recordLedger(...) x1-2                     [accounting — out of scope]
  -> markClosed(...), setPositionTpSl(enabled:false)

stopTpslWatcher()                               [synchronous, pre-existing]
  -> clearInterval(timer); timer = null
  -> pending.clear(); closing.clear()
```

`src/index.ts`'s `SIGINT`/`SIGTERM` handlers (`process.once`) called
`stopTpslWatcher()` synchronously, without awaiting anything, alongside
`stopVolumeAlertWatcher()`, `bot.stop()`, `releaseInstanceLock()`.

## 3. Root Cause

The confirmation `setTimeout`'s return value was **discarded**:

```js
setTimeout(() => { void recheckAndMaybeClose(bot, p, hit, tp, sl); }, CONFIRM_MS);
```

`stopTpslWatcher()` had no handle to cancel it — it only *incidentally*
neutralized an already-armed trigger via `pending.clear()` (when the
timer eventually fired, `recheckAndMaybeClose`'s
`if (!pend || pend.kind !== expected) return;` guard would find nothing
pending and no-op), but:
- the underlying Node timer itself kept running, untracked and unclearable;
- an already-in-flight `executeClose` call (past the point where the
  `pending` check could matter) had **no lifecycle awareness of shutdown
  at all** — `stopTpslWatcher()` returned immediately with no way to know
  whether a close was in progress, and no way to wait for it;
- there was no bounded deadline of any kind — a caller awaiting shutdown
  (there wasn't one, since the function was synchronous) had nothing to
  await, and nothing prevented an indefinite wait if something *had* been
  added naively.

## 4. Cancellation Design

Three-state lifecycle (`WatcherState = 'stopped' | 'running' | 'stopping'`),
exactly the model the task specifies:

```
stopped --startTpslWatcher()--> running --stopTpslWatcher()--> stopping --(cleanup done)--> stopped
```

- `tick()` and `recheckAndMaybeClose()` both check `watcherState !== 'running'`
  at their very top and return immediately if not running — this is what
  "prevents new polling work" and "prevents new TP/SL transaction
  submission" (§5 of the task).
- Every armed confirmation timer's handle is now stored in a
  `Map<string, Timeout>` (`confirmTimers`), keyed by position. On
  shutdown, every entry is `clearTimeout`'d and the map cleared — **this
  is the actual P2 fix**: an armed-but-not-fired trigger genuinely cannot
  fire its recheck after shutdown, proven with a real (not mocked) timer
  in §11/§12.
- No `AbortController`/`AbortSignal` was introduced. This codebase has no
  existing Abort-based infrastructure for this watcher, and — critically
  — there is nothing *safe* to abort past the "haven't started closing
  yet" point: `closePosition()` (out of scope, untouched) is a real
  transaction submission already routed through the hardened
  journal/tx-lock pipeline; forcibly aborting it mid-flight would be far
  more dangerous than letting it finish. The smallest safe mechanism here
  is exactly what the task allows: an explicit state flag plus timer
  tracking, not a signal-based cancellation of already-committed work.

## 5. Confirmation State Model

Mapped onto this codebase's actual architecture (which does **not** have
a separate post-broadcast "wait for blockchain confirmation" step in the
TP/SL watcher itself — "confirmation" here means the 5s PnL-recheck
*before* any transaction exists, not a receipt wait *after* one):

| Task's abstract state | This codebase's concrete equivalent |
|---|---|
| Shutdown before submission -> **no transaction sent** | Confirmation timer cancelled before it fires -> `recheckAndMaybeClose`/`executeClose` never runs -> `closePosition` never called. Zero sends, verified directly (§8/§9). |
| Shutdown while confirmation pending -> **UNKNOWN unless authoritative** | The 5s recheck timer *is* the "confirmation wait" here — cancelling it before it fires means literally nothing was ever attempted, which is a strictly safer outcome than "UNKNOWN" (there is nothing to be uncertain about). |
| Authoritative CONFIRMED/FAILED wins the race | Once `executeClose` has actually started (past the point cancellation could apply), it is **never interrupted** — it runs to completion via its own unmodified, already-hardened path (`closePosition` -> `journalledSend` -> tx-lock -> journal -> receipt). Shutdown only ever *waits* for this (bounded), never touches its outcome. Verified in §12 by gating `closePosition`'s resolution deterministically and confirming the ledger is correctly written *after* shutdown was requested. |

No `PENDING -> CANCELLED -> FAILED` state was created anywhere — a
cancelled *timer* simply never fires (no transaction, no state to even
have an opinion about); an in-flight *close* is never cancelled at all,
so it can only ever end in whatever authoritative outcome its own
(untouched) logic produces.

## 6. Shutdown Lifecycle

```
stopTpslWatcher():
  1. idempotency check: an in-progress or already-completed shutdown
     returns the exact same promise / resolves immediately
  2. watcherState = 'stopping'                         (blocks new work immediately)
  3. clearInterval(timer); timer = null                (no more ticks scheduled)
  4. clearTimeout(startupTimer) if pending              (the delayed first-tick timer)
  5. clearTimeout every entry in confirmTimers; map cleared   (THE fix)
  6. pending.clear()
  7. snapshot inFlightCloses -> bounded wait (see §7)
  8. closing.clear(); watcherState = 'stopped'
```

Step 1 makes repeated `SIGTERM`/`SIGINT`/direct calls safe: only the
*first* call actually builds the shutdown sequence; every subsequent call
(concurrent or later) receives/awaits the identical promise. Verified by
reference-equality (`===`) across three concurrent calls, and by a
fourth call succeeding cleanly after full completion (§11).

## 7. Forced Shutdown Fallback

`SHUTDOWN_DEADLINE_MS = 15_000`. If any close was already in flight when
shutdown began, `stopTpslWatcher()`'s returned promise races
`Promise.allSettled(inFlight)` against a 15s timer — whichever finishes
first determines when the promise resolves. Chosen deliberately as a
*wait bound on this function's own returned promise*, never a kill switch
on the in-flight work itself:

- If the close finishes within 15s: shutdown resolves right after,
  having genuinely waited for the authoritative outcome (§12, first test).
- If it doesn't: shutdown resolves anyway at ~15s (proven to be neither
  "extremely short" nor unbounded — chosen as a reasonable middle ground:
  half of this codebase's own worst-case bounded receipt-poll window from
  Phase 4.6.3, `~30s`), and the close keeps running **completely
  independently and untouched** in the background. Nothing about giving
  up on waiting cancels it, marks it, or removes its journal entry —
  verified explicitly in §12's second test (no ledger row is created for
  the deliberately-never-resolving close, and `closePosition` was called
  exactly once, never retried).

No `process.exit()` was added anywhere in this phase. The task's own
instruction ("do not call process.exit() immediately on SIGTERM") is
satisfied by construction: `stopTpslWatcher()` only ever resolves a
promise; whether the *process* eventually exits is Node's own natural
behavior once nothing keeps the event loop alive — which this fix
actually *improves*, since dangling, uncancellable confirmation timers
(previously a class of handle that could keep the event loop open
indefinitely) are now always cleared.

## 8. Transaction Safety During Shutdown

- **A. Shutdown before submission**: verified directly — arm a trigger,
  shut down immediately, confirm `closePosition` is called 0 times, both
  by structural check (timer map empty) and by actually waiting past the
  real 5s window to prove the underlying timer never fires (§9's
  "pre-submission" and "real timer" tests).
- **B. Shutdown immediately after submission**: not reachable as a
  distinct case in this watcher's actual architecture — `executeClose`
  (which calls `closePosition`) either hasn't started yet (case A) or has
  already started and is tracked in `inFlightCloses` (case C below); there
  is no intermediate "submitted but not yet tracked" window, since the
  promise is registered in `inFlightCloses` synchronously, before any
  `await` inside `executeClose` can run.
- **C. Shutdown while a close is in flight**: the in-flight promise is
  never interrupted; `stopTpslWatcher()` waits for it (bounded). Verified
  with deterministic promise-gating (not wall-clock racing): a test-only
  `closePosition` override blocks on a manually-controlled gate,
  `stopTpslWatcher()` is confirmed to still be in `'stopping'` state while
  the gate is held, then the gate is released and the close completes
  normally — `getLedgerEntries` confirms exactly one withdrawal row was
  written, and `closePosition` was called exactly once (§12, first test).
- **D. Confirmation (here: the close's own authoritative outcome) arrives
  just before/during shutdown processing**: since the close is never
  interrupted, whatever it authoritatively produces is exactly what gets
  persisted — shutdown cancellation can never overwrite it, by
  construction (there is no code path where shutdown touches the ledger,
  journal, or position state at all).

## 9. Race Handling

Deliberately **not** implemented via wall-clock racing (the task
explicitly forbids depending on random timing). Instead:

- "Confirmation vs. shutdown, confirmation wins" (Case A/Case C in the
  task): tested by holding `closePosition`'s resolution open with a
  manually-controlled `Promise` gate, calling `stopTpslWatcher()` while
  it's held, confirming shutdown is genuinely still waiting (not
  resolved), then releasing the gate and confirming both the close
  result (ledger row) and the shutdown's own resolution follow
  deterministically — the ordering is enforced by the test's own control
  flow, not by timing.
- "Shutdown vs. confirmation, shutdown wins (nothing was submitted)"
  (Case B): tested by arming a trigger and calling `stopTpslWatcher()`
  before the real 5s timer elapses, then actually waiting past that
  window to prove the timer never fires — deterministic in outcome
  (zero calls) even though real time passes.

## 10. Timer Cleanup

- `timer` (the 30s poll interval): cleared, nulled.
- `startupTimer` (the one-time delayed first tick): tracked (previously
  also discarded) and cleared on shutdown.
- `confirmTimers` (every armed 5s recheck): each individually
  `clearTimeout`'d, map cleared — the core fix.
- No listener/reference leaks: `inFlightCloses`/`pending`/`closing` are
  plain `Map`/`Set` instances cleared on shutdown (or, for
  `inFlightCloses`, naturally emptied via each entry's own `finally`
  block as it completes — verified indirectly by the restart test
  succeeding cleanly with no leftover state).

## 11. Tests Added

New file `test/tpslWatcher.shutdown.test.ts` (11 tests), using this
codebase's established scratch-DB pattern plus a new test-only dependency
injection seam (`__setTpslDepsForTests`, mirroring the `mintFn`/`spawnFn`/
`runner` injection pattern used elsewhere this session) for
`measurePnl`/`closePosition` — no real RPC/chain call anywhere in this
suite, and neither function's own logic was modified, only how the
lifecycle code above them reaches them.

| # | Test | Real timer? |
|---|---|---|
| 1 | Watcher starts normally (`watcherState === 'running'`) | — |
| 2 | Shutdown while idle: resolves in <500ms, fully clean | — |
| 3 | Shutdown prevents new polling work (`tick()` no-ops, 0 PnL calls) | — |
| 4/16 | **Mandatory pre-submission test**: shutdown set, then a trigger occurs — `closePosition` called 0 times | — |
| 5 | An armed timer is structurally removed from tracking on shutdown | — |
| 6/14/7 | **Mandatory real-timer test**: arm, shutdown, wait the real 5s past `CONFIRM_MS` — proves the actual Node timer never fires, not just that a handle was cleared | ✅ ~5s |
| 8/9/10/15/17 | **Shutdown during in-flight close** (deterministic gate, not racing): close completes normally after shutdown is requested, exactly one send, ledger correctly written | ✅ ~5s to arm |
| 10/16/17 (task numbering) | **Mandatory forced-shutdown-fallback test**: a close that never resolves — shutdown still resolves at ~15s, zero fabricated ledger rows, exactly one send attempt | ✅ ~5s arm + ~15s deadline |
| 13/14 (task numbering) | Repeated `stopTpslWatcher()` calls return the identical promise; idempotent | — |
| — | Calling shutdown on a never-started watcher is a safe no-op | — |
| — | Restart after full shutdown works cleanly (proves timers were truly released, not just logically ignored) | — |

One iteration note: the first version of the in-flight and forced-fallback
tests used a non-numeric placeholder token ID (`"tpsl-test-1"`), which
made `executeClose`'s real `BigInt(p.tokenId)` call throw before ever
reaching the injected `closePosition` mock — caught immediately by both
tests failing on first run (`closeCalls` stayed 0). Fixed by using
realistic numeric token ID strings, matching how every other position-ID
in this codebase is represented; not a production defect, a test-fixture
bug, found and fixed before this report was written.

## 12. Focused Test Results

```
npx tsx --test test/tpslWatcher.shutdown.test.ts
tests 11, pass 11, fail 0
duration ~33-34s (dominated by the two mandatory real-timer tests, ~5s
and ~20s respectively — unavoidable given the task's explicit requirement
to exercise the real timer mechanism, not only mock clearTimeout)
```
Verified stable across 2 consecutive isolated runs.

## 13. Full Test Results

```
npm test
tests 322, pass 322, fail 0
```
(311 pre-existing baseline — Phase 4.5.2 + Phase 4.6/4.6.1/4.6.2/4.6.3,
all preserved byte-for-byte — + 11 new this phase.) Verified stable
across 2 consecutive full-suite runs.

## 14. Typecheck

```
npm run typecheck
```
Clean.

## 15. Build

```
npm run build
```
Clean.

## 16. Trading Logic Diff Audit

```
git diff -- src/bot/tpslWatcher.ts | grep -E "classify|resolveLevels|tpPercent|slPercent|pnlPct|CONFIRM_MS =|POLL_MS =|closePosition\(|recordLedger\(|withdrawalUsd|feesPortionUsd"
```
Only two matches, both pure call-site redirections with identical
arguments in identical order:
```
- const result = await closePosition(
+ const result = await deps.closePosition(
- await executeClose(bot, p, expected, m.pnlPct ?? 0, m.pnlUsd, m.label);
+ const closePromise = executeClose(bot, p, expected, m.pnlPct ?? 0, m.pnlUsd, m.label);
```
`CONFIRM_MS` (5000) and `POLL_MS` (30000) values themselves are
byte-for-byte unchanged. `classify()`, `resolveLevels()`, `measurePnl()`'s
own PnL computation, `executeClose()`'s `recordLedger()` calls and their
formulas, `closePosition()`'s call arguments — all unchanged. The only
non-comment additions to `executeClose`'s call site are promise-tracking
(`inFlightCloses.add`/`.delete`) around the exact same call.

`src/index.ts`: the only change is making the two signal handlers `async`
and adding `await` before `stopTpslWatcher()` — necessary for the fix to
take effect at the one real production entry point (same reasoning as
Phase 4.6.3's `clients.ts` wiring). `stopVolumeAlertWatcher()`,
`bot.stop()`, `releaseInstanceLock()` (Phase 4.6.1, untouched) run in the
identical order as before, now simply after TP/SL shutdown has actually
finished rather than merely been told to start.

## 17. Remaining P2/P3 Findings

Every other Phase 4.6 finding is **intentionally untouched**:

- `scoreMultiPool` NaN propagation (Phase 4.5.2, BUG-003).
- `runStartupTxRecovery`'s sequential loop (Phase 4.6.3, out of scope there too).
- Health endpoint, config validation, memory growth, retry stacking,
  global error handlers — none inspected or modified this phase.
- Instance lock, GMGN CLI, persistence implementation — confirmed
  untouched by this phase's diff (§16's `git diff` scoping).

## 18. Verdict

**PASS**

Confirmation-timer cancellation is bounded and proven with a real timer,
not just a cleared handle. Shutdown prevents all new polling and all new
transaction submissions from the moment it is requested. UNKNOWN (here:
"no transaction was ever attempted") is the outcome for any trigger
cancelled before it could act — never miscast as FAILED. An
already-in-flight close is never interrupted and its authoritative result
always wins, verified deterministically. No duplicate sends are possible
(each close registers itself in `inFlightCloses` and `closing` exactly
once). No timer leaks (every timer class — poll interval, startup delay,
per-position confirmation — is tracked and cleared). The forced-shutdown
fallback is bounded (~15s), observable (logged), safe (never fabricates a
result), and idempotent (repeated calls share one sequence). Unresolved
work created before the fallback deadline remains fully recoverable via
the existing, untouched journal/recovery system — nothing in this phase
touches accounting, ledger semantics, transaction construction, or any
TP/SL threshold/pricing logic. 322/322 tests pass, typecheck and build
are clean.

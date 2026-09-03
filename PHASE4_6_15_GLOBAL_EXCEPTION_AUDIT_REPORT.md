# PHASE 4.6.15 GLOBAL EXCEPTION & PROCESS LIFECYCLE AUDIT

## 1. Original Finding

"Global exception handling" — a remaining P3 finding carried forward
since Phase 4.6.12's report: no audit had yet confirmed whether
unexpected process-level failures (`uncaughtException`,
`unhandledRejection`) could terminate the bot silently, leave it alive
but unsafe, bypass shutdown, or leave an operator believing it was
healthy when it was not.

## 2. Process Entrypoint

`src/index.ts`'s startup sequence, confirmed unchanged by this phase:
```
health server start (Phase 4.6.5, non-critical)
  -> STRATEGY validation (Phase 4.6.10, fatal on invalid)
  -> instance lock acquisition (Phase 4.6.1, fatal on conflict)
  -> DB init / wallet touch
  -> startup tx recovery (Phase 2 Part 4, best-effort, logged)
  -> startup ledger recovery (Phase 3.5, best-effort, logged)
  -> bot creation
  -> MULTI config check (best-effort, disables MULTI only)
  -> webhook clear / command registration (best-effort)
  -> TP/SL watcher + volume-alert watcher start
  -> bot.start() (Telegram long-polling, NOT awaited)
  -> setLifecycleState('ready', ...)
  -> SIGINT/SIGTERM handlers registered (Phase 4.6.4)
```
`main().catch((err) => { ...; process.exit(1); })` wraps the entire
`main()` function call at the bottom of the file — this catches any
error thrown or any promise rejected **within `main()`'s own execution
path**, up through the point where `main()`'s body finishes running (it
resolves once the SIGINT/SIGTERM handlers are registered — everything
after that, including the bot's own polling loop and the two
background watchers, runs independently of `main()`'s own promise).

## 3. Existing Global Handlers

Repo-wide search (`process.on`, `process.once`, `uncaughtException`,
`unhandledRejection`) before this phase found exactly three
registrations, and no `uncaughtException`/`unhandledRejection` handler
anywhere:
- `src/instanceLock.ts:229` — `process.on('exit', () => releaseInstanceLock())`,
  guarded by an idempotency flag (`exitHandlerRegistered`).
- `src/index.ts:230,239` (pre-phase line numbers) — `process.once('SIGINT'/'SIGTERM', ...)`,
  Phase 4.6.4's graceful shutdown.

## 4. uncaughtException Analysis

**Before this phase**: unhandled. Node's own default behavior for an
`uncaughtException` with no registered handler is to print the error to
stderr and terminate the process (this has been Node's behavior across
all actively-supported versions) — so the process was never at risk of
hanging silently or continuing to trade after this specific event. The
actual, demonstrated gap was narrower: the crash happened **without**
`setLifecycleState('failed', ...)` ever being called (that call only
lives inside `main().catch()`, which an uncaughtException firing *after*
`main()` has already resolved never reaches), so `/ready` could in
principle still answer `200`/`ready` in the brief window between the
exception firing and the process actually terminating — and there was
no single, clearly-labeled log line identifying that a fatal,
unexpected (as opposed to an ordinary caught-and-logged operational)
error had occurred.

## 5. unhandledRejection Analysis

**Before this phase**: also unhandled, with the same Node-default-crash
caveat as §4. Two concrete (traced, not hypothetical) fire-and-forget
paths were found that could actually produce one:
1. **`src/index.ts`'s `bot.start({...})`** — called without `await` or
   `.catch()`. If grammy's internal long-polling loop ever definitively
   rejects (e.g. a revoked bot token, or a persistent network outage
   exceeding grammy's own internal retry budget), that rejection would
   be unhandled. `bot.catch(...)` (registered in `bot.ts`, confirmed
   present and unmodified) only covers errors thrown while processing an
   individual Telegram update — a narrower, already-safe mechanism
   (logs and continues, correctly treating a single failed command as
   an ordinary operational error, not a process-fatal one) — it does
   not cover this separate, top-level polling promise.
2. **`src/bot/tpslWatcher.ts`'s `void recheckAndMaybeClose(...)`** (the
   5-second one-shot confirmation timer, `tpslWatcher.ts` line 340) —
   traced line-by-line: unlike `tick()` (which has its own enclosing
   `try { ... } catch (e) { console.error(...) }`) and `executeClose()`
   (same pattern), `recheckAndMaybeClose` has **no enclosing try/catch
   of its own**. `deps.measurePnl` and `notifyAll` (both awaited inside
   it) are confirmed fully self-contained (every internal failure path
   already converts to a safe return value or is caught and logged
   internally) — but the function's own local, synchronous DB calls
   (`listTpSlEnrolledPositions()`, `listPrefsWithTpSlEnabled()`,
   `setPositionTpSl(...)`) are not wrapped, so an unexpected throw there
   (e.g. a corrupted DB file, a disk I/O error) would propagate
   unhandled out of the bare `void recheckAndMaybeClose(...)` call site.

## 6. Background Task Analysis

| Task | Classification | Finding |
|---|---|---|
| `tick()` (tpslWatcher.ts, 30s poll) | B — explicit catch | Full internal `try/catch`; never rejects. Safe. |
| `void recheckAndMaybeClose(...)` (tpslWatcher.ts, 5s one-shot) | D — fire-and-forget, **no** catch | The one concrete gap found (§5.2) |
| `tick()` (volumeAlertWatcher.ts, 60s poll) | B — explicit catch at call site (`.catch((e) => console.warn(...))`) | Safe — the function itself can reject (only a `finally`, not a `catch`, internally) but every call site already attaches `.catch()`. |
| `bot.start(...)` (index.ts) | D — fire-and-forget, **no** catch | The other concrete gap found (§5.1) |
| Per-update processing (grammy) | B — `bot.catch(...)` registered | Safe, already correct — logs and continues (an ordinary operational error, category A). |
| Health HTTP server | E — process-level, but bind failure already handled locally (`s.once('error', ...)` resolves `{started:false}`, never throws) | Already safe, unmodified. |
| `gmgn/cli.ts` child-process spawn | E — process-level, own SIGTERM/SIGKILL escalation (Phase 4.6.2) | Already safe, unmodified. |

## 7. Recoverable vs Fatal Errors

Applying the task's own A-F classification to what this codebase
actually does:
- **A. Expected operational error** (e.g. a single `/mint` command
  failing) → existing local handling: `bot.ts`'s per-handler
  try/catch + `bot.catch(...)`, unchanged.
- **B. Temporary RPC/API failure** → existing, unmodified retry/error
  handling (Phase 4.6.12's audited `withRetries`, receipt-wait deadline
  from Phase 4.6.13).
- **C. Transaction UNKNOWN** → existing, unmodified journal/txRecovery
  (Phase 2 Part 4, re-audited in Phase 4.6.14).
- **D. Programming invariant violation** (e.g. a corrupted local DB
  file causing a synchronous JSON parse/write to throw somewhere it
  wasn't expected) → correctly treated as potentially fatal by this
  phase's fix — not silently caught and turned into "operational,
  continue as normal."
- **E./F. Unhandled rejection / uncaught exception** → now an explicit,
  observable, process-level safety concern (§8), not left to an
  unlabeled Node default crash.

## 8. Fatal Shutdown Design

New file `src/fatalError.ts` exports `handleFatalProcessError` and
`registerFatalErrorHandlers`, wired into `src/index.ts` as the very
first statement the module executes (before `main()` is even defined),
via a single `registerFatalErrorHandlers();` call.

Deliberately does **not** reuse the SIGINT/SIGTERM path's full async
sequence (`await stopTpslWatcher(); stopVolumeAlertWatcher(); bot.stop();
releaseInstanceLock(lockPath); setLifecycleState('stopped'); await
stopHealthServer();`) — Node's own documented guidance for
`uncaughtException` is explicit that it is not safe to perform further
async work afterward, since the exception may have left arbitrary
in-process state (event loop, module-level variables, in-flight
promises) inconsistent; attempting `stopTpslWatcher()`'s own bounded
15-second wait, or `bot.stop()`, from inside a handler for an event that
signals exactly this kind of inconsistency, risks a second failure
compounding the first, or a hang.

Instead, the handler performs only synchronous, already-existing,
independently-safe primitives — the same two building blocks a startup
failure already uses via `main().catch()`:
```
observable log (kind, message, stack, current lifecycle state)
  -> setLifecycleState('failed', ...)   [Phase 4.6.5, pure, synchronous]
  -> releaseInstanceLock()              [Phase 4.6.1, ownership-checked,
                                          already documented safe to call
                                          multiple times or when unheld]
  -> exit(1)
```
This is not a new, redesigned shutdown path — it is the two synchronous
lifecycle primitives that were already proven safe by earlier phases,
composed in the one place they were missing.

## 9. Multiple Fatal Errors

`fatalErrorHandled` (module-level boolean in `fatalError.ts`) makes the
handler idempotent: a second fatal event (e.g. an `unhandledRejection`
firing immediately after an `uncaughtException`, before the process has
actually finished terminating) is a no-op — no second log line, no
second `setLifecycleState`/`releaseInstanceLock` call, no second
`exit()` call. Verified directly by test (`'duplicate fatal events...
do not double-log, double-release, or double-exit'`): exactly one log
line and one `exit(1)` call across two fatal events, and the log
reflects the **first** error (the one that actually drove the
shutdown), not the second.

## 10. Signal Interaction

Not modified — Phase 4.6.4's `SIGINT`/`SIGTERM` handlers in
`src/index.ts` are byte-for-byte unchanged (confirmed by diff, §26).
`uncaughtException`/`unhandledRejection` and `SIGINT`/`SIGTERM` are
entirely independent Node event types with no shared listener or state
beyond the same underlying `setLifecycleState`/`releaseInstanceLock`
primitives (both already idempotent) — there is no scenario where a
fatal error and a signal compete for the same resource in an unsafe way;
at worst, both paths call the same safe, idempotent functions in some
order, which is harmless by construction.

## 11. Instance Lock Safety

`releaseInstanceLock()` (Phase 4.6.1, unmodified) is invoked directly by
`handleFatalProcessError`, and — independently — `instanceLock.ts`'s own
`process.on('exit', ...)` handler fires as the final step of Node's
normal exit sequence regardless of how `exit()`/`process.exit()` was
reached, providing a second, redundant, already-existing safety net.
Both calls are documented as safe to invoke multiple times or when no
lock is held (ownership-checked internally). No lock-semantics change
was made or needed.

## 12. Health/Readiness Interaction

Verified directly by test (`'fatal error flips readiness to NOT_READY'`):
`buildReadinessResponse()` returns `503`/`not_ready`/`state: 'failed'`
immediately after `handleFatalProcessError` runs — `/ready` can never
report `200` once a fatal error has been observed and this handler has
run (as long as the health server is still able to answer in the brief
window before the process actually exits, which requires no code change
here — the health server's request handling is fully synchronous).
Liveness (`/health`) correctly continues to report the real
(`'failed'`) lifecycle state rather than a stale `'ready'`, confirmed by
a dedicated test. `health.ts` itself was not modified.

## 13. Transaction Safety

Traced against all four states from the task's §13:
- **A. Not yet submitted**: no journal entry exists yet; an abrupt exit
  here loses nothing that needed to be recovered — the operation simply
  never started.
- **B. Journaled but unresolved (`BROADCAST_UNKNOWN`/`SUBMITTED`)**:
  this is exactly the case the existing, unmodified journal-before-
  broadcast architecture (Phase 2 Part 4, re-confirmed safe against
  abrupt process death in Phase 4.6.14's audit) is designed for — the
  entry survives on disk and `runStartupTxRecovery` resolves it on the
  next boot.
- **C. Waiting for receipt**: same as B — the wait itself never
  mutates the journal (Phase 4.6.13/4.6.14 finding, reconfirmed
  unmodified); an abrupt exit here is indistinguishable, from the
  journal's perspective, from a receipt-wait timeout, which is already
  proven safe.
- **D. Confirmed**: already a terminal, resolved journal state — nothing
  to lose.
No fabricated transaction result, no duplicate submission, and no
change to `txRecovery`'s authority in any of these cases — `exit(1)`
from the fatal handler introduces no new risk beyond what an ordinary,
unplanned OS-level process kill already requires this architecture to
tolerate, which it already does.

## 14. Accounting Safety

`handleFatalProcessError` never calls `recordLedger`, never touches
`tx_journal` beyond the pre-existing, unmodified `releaseInstanceLock`/
lifecycle primitives, and never runs any accounting code. No false
ledger entry, no fabricated confirmed/failed transaction, no duplicate
accounting, and no fabricated PnL/fees can result from this handler —
it has no code path capable of producing any of them.

## 15. Logging / Observability

The log line includes the fatal-event kind (`uncaughtException`/
`unhandledRejection`), the error's message and stack trace, and the
current lifecycle state at the moment of failure (`getLifecycleState()`,
read before it's overwritten) — satisfying "where practical: error
type, message, stack trace, lifecycle state." The handler never reads
`process.env`, never touches any credential/wallet-key store, and only
ever logs the `Error` object it was handed (plus the fixed, static
lifecycle-state string) — there is no code path by which a private key,
seed phrase, API secret, or the full process environment could appear
in this log. Verified by test (`'fatal error logging never includes the
process env or a raw secret value'`).

## 16. Shutdown Error Handling

Every step inside `handleFatalProcessError` — the log call itself,
`setLifecycleState`, and `releaseInstanceLock` — is individually wrapped
in its own `try/catch`, so a failure in any one of them (including the
logger itself throwing) can never prevent `exit(1)` from being reached.
Verified directly by test (`'a throwing logger never prevents exit(1)
from being called'`): a deliberately-throwing `log` function still
results in exactly one `exit(1)` call.

## 17. Process Exit Semantics

Fatal errors now cause a deliberate, explicit `exit(1)` call from
`handleFatalProcessError` (test-injectable; the real registered
handlers call `process.exit(1)`) — a conventional non-zero fatal exit
code, reached only after the synchronous cleanup steps above have each
had a chance to run (or fail safely without blocking). `process.exit()`
is never called before those steps at least attempt to run, and nothing
in this design can turn a genuine fatal error into continued/silent
operation.

## 18. Tests

New file `test/fatalError.test.ts` — 13 tests: observable logging and
lifecycle transition for both `uncaughtException` and
`unhandledRejection` (including a non-`Error` rejection reason);
readiness flips to `NOT_READY`/503 and liveness reports the real
failed state; idempotency under duplicate fatal events (exactly one
log, one exit); a throwing logger never blocks `exit()`;
`releaseInstanceLock` is invoked without throwing when no lock is held;
no secret/env leakage in the log; two **real child-process** fixtures
(`test/fixtures/fatal-throw.mts`, `fatal-reject.mts`) proving the
actual registered `process.on(...)` handlers behave identically to the
unit tests' predictions in a genuine, fresh Node process — not merely a
simulation; and a registration test confirming
`registerFatalErrorHandlers()` attaches exactly one listener per event.

## 19. Changes Made

A real, demonstrated gap was found (§5) and fixed with the minimal
addition described in §8: one new file (`src/fatalError.ts`) and a
6-line addition to `src/index.ts` (one import + one registration call).
No existing file's control flow, shutdown sequence, trading logic, or
lifecycle semantics was altered — `handleFatalProcessError` only
composes two already-existing, already-safe, already-idempotent
primitives (`setLifecycleState`, `releaseInstanceLock`) that Phase 4.6.5
and Phase 4.6.1 had already established as safe to call from any
context.

## 20. Full Test Results

```
npx tsx --test test/fatalError.test.ts
tests 13, pass 13, fail 0

npx tsx --test test/fatalError.test.ts test/tpslWatcher.shutdown.test.ts test/health.test.ts test/instanceLock.test.ts test/txRecovery.test.ts test/reconcile.test.ts
tests 91, pass 91, fail 0

npm test
tests 508, pass 508, fail 0
```
(495 pre-existing baseline from Phase 4.5.2 through 4.6.14, all
preserved byte-for-byte, + 13 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

## 21. Typecheck

```
npm run typecheck
```
Clean.

## 22. Build

```
npm run build
```
Clean.

## 23. Trading Logic Audit

No price calculation, quote calculation, MULTI candidate filtering/
ranking/pool scoring, range calculation, single-sided liquidity logic,
simulation, gas strategy, nonce strategy, receipt deadline, close
fallback, retry architecture, TP/SL decision logic, or accounting
formula was modified. `bot/tpslWatcher.ts` has zero lines changed this
phase (confirmed by diff, §26 — identical line count to the pre-phase
baseline); the demonstrated `void recheckAndMaybeClose(...)` gap (§5.2)
is addressed by the new global safety net rather than by touching that
file, deliberately avoiding any change to TP/SL trading behavior.

## 24. Strategy Parameter Audit

No file under `src/strategy/*` appears in this phase's diff. No MULTI
parameter, threshold, weight, or fee tier was read, referenced, or
modified.

## 25. Remaining P2/P3 Findings

- **`RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry** (Phase 4.6.6) —
  cosmetic, both fail closed.
- **`ledger`/`positions`/`multi_position_meta` persistent file growth**
  (Phase 4.6.8) — unbounded by design, accounting-critical, not touched.
- **`journalledSend`'s refusal-gate retry inefficiency** (Phase 4.6.12) —
  minor, non-unsafe, "journal semantics" territory, out of scope.
- **GMGN's `GmgnRateLimitError.resetAt` never consumed** (Phase 4.6.12) —
  missing convenience, GMGN CLI behavior explicitly out of scope.
- **`runStartupTxRecovery`'s sequential loop has no aggregate deadline**
  (Phase 4.6.12) — "transaction recovery semantics," out of scope.
- **`close.ts`'s terminal-journal-write-back optimization** (Phase
  4.6.14) — minor missed optimization, "journal semantics" out of scope.
- **v4 close path dedicated adversarial test gap** (Phase 4.6.14) — the
  v4 close function relies on the same universal `journalledSend` gate
  but was not given its own dedicated adversarial test.
- **`bot.start()` remains un-awaited/un-`.catch()`-ed, and
  `recheckAndMaybeClose` remains without its own local try/catch** —
  both traced, concrete sources of a possible `unhandledRejection`
  (§5). This phase deliberately did **not** patch either call site
  individually — per the task's own explicit warning (§29, "do not
  convert programmer bugs into ordinary operational errors" / "do not
  add catch blocks merely to make tests pass"), silently swallowing
  either at the local call site would be the wrong fix: a DB read/write
  throwing inside `recheckAndMaybeClose` likely indicates a genuine
  invariant violation (category D) that *should* be process-fatal, not
  quietly absorbed into "TP/SL watching continues." The new global
  handler (§8) is the correct, intended safety net for exactly this
  case — it was fixed at the process level, not the call-site level.
  Not carried forward as an unresolved gap; documented here for
  completeness of the trace.
- No new safety-severity findings beyond what is listed above. **The
  "global exception handling" finding itself is now closed** — every
  fatal error (uncaught exception or unhandled rejection) is observable,
  cannot silently continue trading, and cannot leave the process
  reporting healthy while dead — it is not carried forward as an open
  P3 item.

## 26. Files Changed

- [src/fatalError.ts](src/fatalError.ts) — new: `handleFatalProcessError`, `registerFatalErrorHandlers`, and test-only helpers
- [src/index.ts](src/index.ts) — 6-line addition: import + `registerFatalErrorHandlers()` call, registered before `main()` is defined
- [test/fatalError.test.ts](test/fatalError.test.ts) — new, 13 focused tests including 2 real child-process fixtures
- [test/fixtures/fatal-throw.mts](test/fixtures/fatal-throw.mts), [test/fixtures/fatal-reject.mts](test/fixtures/fatal-reject.mts) — new real-process fixtures
- [PHASE4_6_15_GLOBAL_EXCEPTION_AUDIT_REPORT.md](PHASE4_6_15_GLOBAL_EXCEPTION_AUDIT_REPORT.md) — this report

## 27. Verdict

**PASS**

Every fatal process-level error (`uncaughtException` or
`unhandledRejection`) is now observable via a clearly-labeled log line
identifying the event kind, message, stack, and lifecycle state at
failure. Neither event can silently leave trading active: the handler
never attempts to resume normal operation, never retries, and exits the
process after (not instead of) marking lifecycle `'failed'` and
releasing the instance lock. Readiness correctly becomes `NOT_READY`
(503) immediately. Shutdown is idempotent (proven under duplicate fatal
events) and bounded (no async work, no retry loop — the handler cannot
hang). The instance lock remains safe (both the direct call and the
pre-existing `'exit'` handler are idempotent). Unresolved transactions
remain fully recoverable via the existing, unmodified journal/
`txRecovery` architecture, which was specifically designed to tolerate
exactly this kind of abrupt termination. No duplicate transaction or
accounting corruption is possible, since the handler has no code path
that touches either. Existing SIGINT/SIGTERM shutdown is untouched and
its tests remain green. 508/508 tests pass, typecheck and build are
clean.

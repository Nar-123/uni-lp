# PHASE 4.6.1 PERSISTENCE HARDENING REPORT

Scope: fix exactly the two P1 findings from the Phase 4.6 audit
(non-atomic persistence; no single-instance lock). No P2/P3 item was
touched. No trading/strategy/execution/accounting logic was changed.

## 1. P1-1 Root Cause

`src/db/index.ts`'s entire store (positions, ledger, execution telemetry,
and — critically — the transaction-recovery journal itself) lived in one
JSON file, rewritten in full via a direct, non-atomic
`fs.writeFileSync(storePath, ...)` on every mutation. A crash (kill,
OOM, power loss) mid-write could leave a truncated/invalid file. `load()`
had no `try/catch` around `JSON.parse`, so a corrupt file threw
uncaught out of `main()`'s very first line (`getDb()`, before any
recovery logic even runs), taking the whole bot down until an operator
manually inspected and repaired `data/bot.json` by hand — with no
backup, no atomic write, and no distinction between "genuinely no prior
data" and "there was data and it's now unreadable."

## 2. P1-1 Fix

`src/db/index.ts`, `persist()`: writes now go through a crash-safe
three-step sequence, all in the same directory as the primary (required
for the rename to be atomic):

1. Serialize the full state and write it to `<path>.tmp` via
   `fs.openSync(tmpPath, 'w')` + `fs.writeSync` + `fs.fsyncSync` +
   `fs.closeSync` — the temp file's contents are flushed to disk before
   anything else happens. A failure here throws immediately, naming the
   temp path, and — because nothing past this point has run yet — the
   existing primary is provably untouched.
2. If a primary already exists, `fs.renameSync(storePath, bakPath)`
   rotates it to `<path>.bak` — this is the previous fully-committed
   generation, always produced by an earlier successful atomic rename,
   never a partial write. This step is **best-effort**: a failure here
   is logged and does not block step 3, since the backup is a safety net,
   not the primary durability guarantee.
3. `fs.renameSync(tmpPath, storePath)` — the single atomic operation
   that installs the new state. A failure here throws, naming the temp
   path the fully-written new state can still be recovered from on next
   start.
4. Best-effort `fsyncDirBestEffort()` on the parent directory, so the
   rename is durable against a following power loss, not merely
   crash-consistent against a process kill.

At no point is the target path truncated in place, written to directly,
or deleted before its replacement is ready (verified by
`test/persistence.test.ts`'s temp-file-write-failure case, which asserts
the existing primary is byte-for-byte unchanged after a failed write
attempt).

**Directory fsync platform limitation (documented, not silently
ignored, per the task's instruction):** POSIX supports opening a
directory read-only and calling `fsync` on its file descriptor; Windows
does not expose this the same way through Node's `fs` API. `
fsyncDirBestEffort()` attempts it and silently no-ops on failure — this
is not a durability regression versus the pre-existing code (which never
attempted directory fsync at all), and the per-file fsync in step 1
still applies everywhere. This is the one place this phase accepted
"best-effort" rather than a hard guarantee, exactly as the task
anticipated or permitted ("If platform limitations prevent directory
fsync, document the limitation rather than pretending durability is
perfect").

## 3. Corruption Handling

`load()` was rewritten to distinguish "no data ever existed" (a
legitimate empty store, the only case that's allowed to happen) from
"a store existed and is now unreadable" (which must never resolve to an
empty store).

- **Primary exists but fails to parse / doesn't look like a `Store`**
  (checked via a light shape guard —`Array.isArray(.positions)` and
  `.ledger`): the corrupt file is renamed aside to
  `<path>.corrupt-<timestamp>` (`quarantineFile()`) — **never deleted,
  never overwritten** — and recovery is attempted from `<path>.tmp`
  (most recent complete write, checked first) then `<path>.bak`
  (previous generation, checked second). If recovered, the recovered
  state is immediately re-persisted to the primary path (through the
  same atomic `persist()`), and a `console.error` names exactly what was
  recovered from and recommends `/reconcile`.
- **Primary is missing entirely**: the same sidecar-recovery is
  attempted first (covers the exact crash window between the two renames
  in `persist()`, where the primary was moved to `.bak` but the new
  state hadn't yet been promoted from `.tmp`). Only if *no* sidecar
  exists at all is this treated as a genuine first run (fresh empty
  store, `persist()`ed once to create it).
- **Primary is missing/corrupt AND the sidecars are also
  missing/corrupt**: this is the one case where automatic recovery is
  genuinely impossible. `load()` throws a `FATAL` `Error` naming every
  quarantined file it produced along the way, and explicitly states it
  is "refusing to start with an invented empty ledger/journal." This
  propagates to `main().catch(...)` exactly as an uncaught error did
  before this phase — the difference is the message is now specific and
  actionable, and every corrupt file involved has been preserved on disk
  for inspection rather than left in an ambiguous half-truncated state
  or silently discarded.

**Backup/recovery design, documented as requested:**

| Sidecar | Created | Rotated/replaced | Authoritative when |
|---|---|---|---|
| `<path>.tmp` | Every `persist()` call, before anything else | Overwritten by the next `persist()` call | Primary is missing/corrupt AND `.tmp` parses as a valid `Store` — this is always preferred over `.bak` since it's the more recent state |
| `<path>.bak` | Every `persist()` call, by renaming the *current* primary aside right before installing the new one | Replaced every `persist()` call | Primary is missing/corrupt AND `.tmp` is unusable AND `.bak` parses as a valid `Store` — one generation behind, hence `/reconcile` is explicitly recommended after recovering from it |
| `<path>.corrupt-<timestamp>` | Only when `load()` finds an unparseable primary or sidecar | Never — a new one is created per incident, none are ever auto-deleted | Never authoritative — diagnostic only |

This design is deliberately minimal: exactly one backup generation, no
rotation history beyond it, no separate backup schedule/timer — the
backup is simply "whatever the primary was immediately before this
write," which is sufficient to survive the one failure mode P1-1
identified (a crash during a single write) without adding a second
persistence subsystem to reason about.

**Crash-safety invariants A and B (from the task) verified by
`test/persistence.test.ts`**: a failed write never erases existing state
(same test as above), and a malformed file is never interpreted as an
empty account (three dedicated tests: corrupt-with-no-sidecar throws;
corrupt-with-valid-`.tmp` recovers the entry, doesn't go empty;
missing-primary-with-corrupt-`.bak` throws).

## 4. P1-2 Root Cause

Nothing prevented two bot processes from sharing the same `DB_PATH` and
wallet. `withTxLock` (`chain/txLock.ts`) is explicitly documented as
per-process, in-memory only. A process-manager restart racing an old,
not-yet-exited instance (a realistic, well-known operational scenario,
not a contrived one) — or an operator error — could result in two
processes each with their own independent copy of the store, each
calling the (then non-atomic) `persist()` independently with
last-write-wins semantics, and each independently fetching the same
wallet's pending nonce from the RPC node with no cross-process
coordination — a genuine risk of a raced/duplicated broadcast.

## 5. P1-2 Fix

New module `src/instanceLock.ts`, wired into `src/index.ts` as the
**first statement in `main()`**, before `getDb()`, before wallet
resolution, before the bot or either watcher is created.

- **Mechanism**: `fs.openSync(lockPath, 'wx')` — `O_CREAT|O_EXCL`,
  atomic at the OS level. If the path already exists, the call fails
  instead of silently succeeding; nothing about acquisition depends on
  a separate check-then-act step that could itself race.
- **Lock file path**: `defaultLockPath(config.dbPath)` — derived the
  same way `db/index.ts` derives `storePath` from `config.dbPath`, so
  it's colocated with and specific to the same wallet/database this
  process is about to operate on (`data/bot.lock` next to
  `data/bot.json` by default), not a single machine-wide lock (this
  codebase's multi-wallet feature is one process managing several
  wallets via `/wallet`, not several processes each with their own
  wallet — the lock is scoped to match that).
- **Lock contents**: `{ pid, hostname, acquiredAt, owner? }` —
  identifiable metadata, written and `fsync`ed before the file descriptor
  is closed.
- **Second acquisition on an existing lock**: reads the existing file.
  If the recorded PID is confirmed alive (`process.kill(pid, 0)` not
  throwing `ESRCH`), acquisition fails closed with
  `HELD_BY_LIVE_PROCESS`, naming the existing PID/host/time so the
  operator's error message is actionable. If the lock file exists but
  is unreadable/malformed, acquisition **also fails closed**
  (`INDETERMINATE`) — an unreadable lock is never assumed stale, since
  that would risk stealing a live one whose write is simply mid-flight
  or was written by an incompatible version.
- **Stale-lock reclaim**: only when the recorded PID is *confirmed* not
  running (`ESRCH`) — every other outcome (alive, `EPERM`, any other
  error) is treated as "can't prove it's gone" and refuses to reclaim.
  Reclaim re-reads the file immediately before unlinking it and only
  unlinks if its content still matches what was just judged stale
  (narrows, though — as documented in the module and below — does not
  perfectly eliminate, a reclaim race against another process doing the
  same thing at the same instant); the subsequent retry of the atomic
  `O_EXCL` create is the actual arbiter of who wins, bounded to 3
  attempts.
- **PID-reuse residual risk (documented, not eliminated, per the
  instruction not to over-engineer this)**: if the OS reuses a PID
  extremely quickly after the original holder exits, this scheme could
  in principle mistake an unrelated new process for a live original
  holder (making reclaim *more* conservative, not less — the failure
  mode of PID reuse under this design is "refuses to reclaim an actually
  -stale lock a little longer," never "reclaims a live one"). No
  process-start-time cross-check was added — Node has no cheap portable
  way to read another process's start time, and this residual risk is
  the same one essentially every PID-file lock implementation carries.

## 6. Lock Lifecycle

- **Acquisition**: first statement in `main()` (`src/index.ts`). A
  failed acquisition logs a specific, actionable message
  (distinguishing "held by a live process, naming it" from "can't
  determine ownership, inspect manually") and calls `process.exit(1)`
  immediately — `getDb()`, wallet resolution, `runStartupTxRecovery()`,
  bot/watcher creation are never reached.
- **Normal shutdown** (`SIGINT`/`SIGTERM`): `releaseInstanceLock(lockPath)`
  added alongside the existing `stopTpslWatcher()`/
  `stopVolumeAlertWatcher()`/`bot.stop()` calls.
- **Startup/runtime failure**: `main().catch((err) => { ...;
  releaseInstanceLock(); process.exit(1); })` — the no-arg form releases
  whatever this process most recently acquired (tracked internally in
  `instanceLock.ts`), covering RPC-init failure, strategy-config
  failure, recovery failure, or any other uncaught error during startup
  or afterward.
- **Last-resort net**: `acquireInstanceLock` registers a synchronous
  `process.on('exit', () => releaseInstanceLock())` the first time it
  succeeds, covering any exit path not explicitly handled above.
  `releaseInstanceLock` is idempotent and ownership-checked (it only
  unlinks the file if it still records *this* process's own PID), so
  this firing in addition to an explicit release elsewhere is safe, not
  a double-release hazard.
- **Never deletes another process's lock**: every release path re-reads
  the file and compares its `pid` to `process.pid` before unlinking;
  a lock that no longer names this process (e.g. because it was already
  judged stale and reclaimed by someone else — not expected to happen
  while the original holder is still alive to call release, but checked
  regardless) is left untouched.

## 7. Tests Added

`test/instanceLock.test.ts` — 11 tests, all against the real (unmocked)
`instanceLock.ts`:

1. First acquisition succeeds; lock file contains identifiable PID/host/
   time metadata (also covers checklist item 8).
2. A second acquisition attempt against a lock whose recorded PID is
   this very test process's own (unimpeachably live) fails closed with
   `HELD_BY_LIVE_PROCESS`.
3. Release then re-acquire succeeds.
4. A lock naming a real, spawned-then-exited child process's PID is
   safely reclaimed.
5. A lock naming a real, currently-running child process's PID is
   **not** reclaimed, even after the reclaim-retry loop.
6. A malformed (non-JSON) lock file causes acquisition to fail closed
   (`INDETERMINATE`) rather than being guessed-at and stolen; the file
   is left untouched.
7. The no-arg release form (exactly as `main().catch(...)` calls it)
   releases the most recently held lock.
8. The explicit-path release form (exactly as the `SIGINT`/`SIGTERM`
   handlers call it) releases correctly and is safely idempotent on a
   second call.
9. Release never deletes a lock file that no longer records this
   process's own PID (simulated "someone else reclaimed it" case).
10. `defaultLockPath` is deterministic and distinct from the store path
    it's derived from.
11. **Two real child OS processes** racing `acquireInstanceLock` against
    the identical lock path — exactly one reports success. (True
    single-process-JS calls can only prove the underlying syscall is
    atomic in principle; this test exercises the actual cross-process
    race the task asked for, per its own "use child_process-based
    integration tests where practical" guidance. The winning child stays
    alive briefly after deciding its outcome so the loser's liveness
    check sees a genuinely live sibling rather than a race artifact of
    an already-exited one.)

`test/persistence.test.ts` — 10 tests, against the real (unmocked)
`db/index.ts` store:

1. A successful mutation leaves the primary as valid, complete JSON with
   no leftover `.tmp`.
2. Repeated writes accumulate — every earlier entry survives every later
   write (whole-state-rewrite correctness).
3. A tx journal entry survives a simulated restart (`__resetStoreForTests()`
   + reload).
4. A temp-file write failure (forced via a real, portable condition — a
   directory occupying the temp path, so `fs.openSync(..., 'w')`
   genuinely fails on every platform) throws rather than silently
   reporting success, **and** leaves the pre-existing valid primary
   byte-for-byte unchanged.
5. A backup-rotation failure (forced the same way, at the `.bak` target)
   is logged and non-fatal — the new state is still installed. (Real
   fault-injection of the *second*, critical rename specifically — as
   opposed to the first, best-effort rotation rename — would need a
   mocking framework this repo doesn't have or a fragile platform-
   specific file-locking trick; this test exercises the same
   `fs.renameSync` failure class via the rotation step instead, and the
   choice/limitation is documented in the test file's own comment.)
6. A corrupt primary with no usable `.tmp`/`.bak` throws — never falls
   back to an empty store — and the corrupt file is quarantined
   (renamed aside, found via directory listing), never deleted.
7. A corrupt primary recovers from a valid `.tmp` sidecar.
8. A missing primary recovers from `.bak` when no `.tmp` exists, and the
   recovered state is re-committed to the primary path.
9. A missing primary with only an unreadable `.bak` throws rather than
   starting empty.
10. A stray, superseded `.tmp` left next to a valid primary is cleaned
    up on load without affecting the (correct) loaded state.

**Existing-test interaction found and fixed during this phase**: running
the full suite after the P1-1 change surfaced that
`test/strategy.multiRisk.test.ts` and `test/strategy.multiExecute.test.ts`
each have their own `resetDb()` helper whose entire purpose is "delete
`DB_PATH` so the next test starts genuinely empty." Neither knew about
the new `.bak`/`.tmp` sidecars, so `load()` was — correctly, by the new
design — recovering from the leftover `.bak` instead of starting empty,
silently reintroducing cross-test state leakage that the original helper
was written specifically to prevent. All existing assertions still
happened to pass, but the isolation guarantee those tests document and
depend on was broken. Fixed both `resetDb()` helpers to also remove
`<path>.bak` and `<path>.tmp` — a minimal, directly-necessitated
consequence of introducing the sidecars, not a change to what either
test suite verifies. No assertion in either file was altered, weakened,
or removed.

## 8. Full Test Results

```
$ npm test
...
ℹ tests 283
ℹ suites 0
ℹ pass 283
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7823.3212
```

262 pre-existing (Phase 4.5.2 baseline) + 10 new persistence tests + 11
new lock tests = 283. All pass. Persistence and lock tests were also run
standalone first, per the task's instruction, before the full suite —
10/10 and 11/11 respectively, both green in isolation as well as within
the full run.

## 9. Typecheck

```
$ npm run typecheck
> tsc --noEmit
(clean — no output, exit 0)
```

## 10. Build

```
$ npm run build
> tsc
(clean — no output, exit 0)
```

## 11. Diff Scope Audit

```
$ git status --short
 M PHASE4_5_VALIDATION_REPORT.md         <- pre-existing Phase 4.5.2 (untouched)
 M src/chain/ticks.ts                    <- pre-existing Phase 4.5.2 (untouched)
 M src/db/index.ts                       <- THIS PHASE: P1-1
 M src/index.ts                          <- THIS PHASE: P1-2 wiring
 M src/pnl/reconcile.ts                  <- pre-existing Phase 4.5.2 (untouched)
 M src/strategy/multiExecute.ts          <- pre-existing Phase 4.5.2 (untouched)
 M test/reconcile.test.ts                <- pre-existing Phase 4.5.2 (untouched)
 M test/strategy.multiExecute.test.ts    <- THIS PHASE: resetDb() sidecar fix only
 M test/strategy.multiRange.test.ts      <- pre-existing Phase 4.5.2 (untouched)
 M test/strategy.multiRisk.test.ts       <- THIS PHASE: resetDb() sidecar fix only
?? PHASE4_5_2_VALIDATION_REPORT.md       <- pre-existing Phase 4.5.2 (untouched)
?? PHASE4_6_RELIABILITY_AUDIT.md         <- prior phase (this session), untouched
?? src/instanceLock.ts                   <- THIS PHASE: new module, P1-2
?? test/instanceLock.test.ts             <- THIS PHASE: new tests, P1-2
?? test/persistence.test.ts              <- THIS PHASE: new tests, P1-1
?? test/ticks.test.ts                    <- pre-existing Phase 4.5.2 (untouched)
```

`git diff` on every file marked "pre-existing Phase 4.5.2" was
byte-for-byte re-verified against this phase's own opening inspection
(§1) and found unchanged — confirmed above, not merely asserted.

Every line this phase actually changed is one of:
- Atomic write / corruption-safe load (`src/db/index.ts`).
- Lock acquisition/release wiring (`src/index.ts`).
- The new lock module (`src/instanceLock.ts`).
- New tests for the above (`test/persistence.test.ts`,
  `test/instanceLock.test.ts`).
- The minimal, directly-necessitated `resetDb()` sidecar-cleanup fix in
  two existing test files (§7).

No unrelated change was made; nothing needed to be reverted.

**Explicit confirmation — no trading logic changed.** Verified by
inspection of the diff (§11 above shows the complete file list) and by
the unchanged results of every pre-existing strategy/candidate/pool/
fee/range/quote/price-impact/simulation/TP-SL/accounting test: zero
changes were made to `src/strategy/{multiCandidates,multiPool,
multiConfig,multiRisk,multiRange,index,types}.ts`, `src/chain/{mint,
close,swap,quote,priceImpact,gas,fees,pools,positions,tokens,v4,
uniswap,tickBitmap,safety}.ts`, `src/bot/{tpslLogic,tpslWatcher,
quickMint,session}.ts`, `src/pnl/compute.ts`, or `src/gmgn/*.ts`. The
only line touched in `src/pnl/reconcile.ts` and `src/strategy/
multiExecute.ts` is the single pre-existing Phase 4.5.2 `strategy`
field each, confirmed identical to the version already present before
this phase began.

## 12. Remaining Phase 4.6 Findings

**Not fixed in this phase, by explicit instruction** — all still open,
exactly as documented in `PHASE4_6_RELIABILITY_AUDIT.md`:

- **P2-1** — `gmgn-cli` subprocess timeout has no `SIGKILL` escalation if
  `SIGTERM` is ignored.
- **P2-2** — `journalledSend`'s pre-send recovery loop resolves multiple
  unresolved journal entries sequentially rather than in parallel,
  risking multi-minute stalls on every send under sustained RPC
  instability.
- **P2-3** — Shutdown does not cancel an in-flight TP/SL 5-second confirm
  timer, and there is no forced-exit fallback if cleanup hangs.
- **P2-4** — No health/liveness/readiness signal exists anywhere; process-
  alive is the only external observability into whether the bot is
  actually functioning.
- **P2-5** — A couple of config values (env-supplied token addresses,
  RPC URLs) are used without runtime format validation at startup.
- **P2-6** — `scoreMultiPool` NaN propagation (Phase 4.5.2's own BUG-003)
  remains open and undocumented-as-fixed.
- **P3-1** — `positions`/`ledger` arrays are unbounded (unlike
  `execution_telemetry`/`tx_journal`, which are capped).
- **P3-2** — Retry-layer stacking between the viem transport's own retry
  and higher-level `withRetries` call sites.
- **P3-3** — The global `bot.catch` handler only logs to console, with no
  persisted log or operator alert.
- **P3-4** — No process-wide `uncaughtException`/`unhandledRejection`
  handler.

None of these were touched, and none of this phase's changes make any of
them better or worse — they are independent of the persistence/lock
layer this phase modified.

## 13. Production Readiness Verdict

**PASS WITH CONDITIONS** (upgraded from Phase 4.6's **NOT READY**,
specifically because both P0/P1-triggering findings from that audit are
now fixed, tested, and verified).

This verdict reflects only what changed: P1-1 and P1-2 — the two
findings that, under Phase 4.6's own rubric, were sufficient on their
own to force a NOT READY verdict — are now resolved, each with focused
regression tests exercising the real failure conditions (a genuine write
failure, a genuine cross-process race) rather than merely asserting
against mocks. No P0 was found in Phase 4.6 and none was introduced
here. The six P2s and four P3s listed in §12 are real, already-
documented, and **not** fixed — per the task's explicit instruction not
to touch them in this phase, and per its own instruction not to claim
production readiness while other findings remain outstanding, this is
not a full **PASS**. "PASS WITH CONDITIONS" per Phase 4.6's verdict
rubric (no P0, no direct critical capital-safety flaw, only manageable
P2/P3 issues remain) is the accurate characterization: live-capital
deployment is no longer blocked by an unresolved P1, but the P2 items —
particularly P2-4 (no health signal) and P2-2 (potential multi-minute
send stalls under RPC instability) — are worth closing before or shortly
after going live, and should not be considered optional polish.

# PHASE 4.6.2 GMGN TIMEOUT FIX REPORT

## 1. Original P2 Finding

From the Phase 4.6 reliability audit: `gmgn-cli`'s process timeout does
not escalate to `SIGKILL` if the child process ignores `SIGTERM`. A
single `SIGTERM` was sent on timeout with no follow-up — if the child
didn't react, it stayed alive indefinitely, and (more subtly) the
wrapper's own promise never settled either, since nothing but `close`/
`error`/max-buffer-exceeded could resolve it, and none of those fire for
a child that never terminates.

## 2. Root Cause

`src/gmgn/cli.ts`'s `runGmgnProcess()`, the timeout timer:

```js
const timer = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
}, opts.timeoutMs);
```

One signal, no escalation, no grace period, no fallback. If the child
ignores `SIGTERM`, this is the entire timeout-handling logic — nothing
else in the function was going to intervene.

## 3. Existing Behavior (traced before any edit, per instructions)

- Spawn: `crossSpawn(file, args, { env })` (Phase 4.5.1's Windows/`.cmd`
  fix — untouched this phase).
- Settlement: a single `finish(err | null)` closure, guarded by a
  `settled` boolean — already idempotent for whichever event reached it
  first. This part was already correct and is preserved unchanged.
- Events wired: `stdout`/`stderr` `data` (max-buffer enforcement),
  `error`, `close`. No `exit` listener (not needed — `close` always
  fires at or after `exit` and additionally guarantees stdio is fully
  drained, which this wrapper needs anyway).
- Gap found while tracing: the `error` handler passed its error straight
  to `finish()` with no check for `timedOut` — meaning a stream error
  arriving after a timeout had already been declared would have leaked a
  raw, unclassified error instead of the canonical timeout. Not the
  headline P2, but a related exactly-once-settlement gap fixed as part of
  the same change (§7 explicitly requires this).
- `gmgnJson()` (the caller): already classifies `err.killed === true` as
  `GMGN_CLI_TIMEOUT` — this logic is **unchanged**; the fix only had to
  guarantee `killed: true` is always present on the final error once a
  timeout has been declared, which it already was for the `close` path
  and now is universally.

## 4. New Timeout Lifecycle

```
T0  child spawned, sigtermTimer armed for opts.timeoutMs
T1  sigtermTimer fires -> timedOut = true, SIGTERM sent
T2  sigkillGraceTimer armed for SIGTERM_GRACE_MS (2000ms)
T3a if 'close' arrives before T2 fires -> settle now, GMGN_CLI_TIMEOUT
    (SIGKILL never sent — the child exited on its own)
T3b if sigkillGraceTimer fires and the child is still alive -> SIGKILL sent,
    sigkillWaitTimer armed for SIGKILL_WAIT_MS (2000ms)
T4a if 'close' arrives before T3b's wait elapses -> settle now, GMGN_CLI_TIMEOUT
T4b if sigkillWaitTimer fires with no 'close' yet -> settle anyway,
    GMGN_CLI_TIMEOUT (the wrapper's own promise must never hang the
    caller, regardless of whether the OS has finished reaping the process)
```

Worst case added latency beyond `opts.timeoutMs`: ~4 seconds
(`SIGTERM_GRACE_MS + SIGKILL_WAIT_MS`), and only on a call that was
already failing. The happy path (child responds to `SIGTERM`, or exits on
its own before the timeout fires at all) is completely unaffected —
confirmed by the pre-existing "real spawn: a long-running process is
killed on timeout and reported as killed" test still passing unchanged
and unmodified.

## 5. SIGTERM Behavior

Sent exactly once at `T1`, via a new `safeKill()` helper that wraps
`child.kill()` in a `try/catch` — a throw here (the process had already
exited independently, "ESRCH") is treated as a success condition ("there
is nothing left to kill"), never as a fatal/unexpected error. Identical
call site is now also used for the pre-existing max-buffer-exceeded path
(previously called `child.kill('SIGTERM')` directly, unguarded — now
benefits from the same safe-kill treatment).

## 6. SIGKILL Escalation

Sent exactly once, only if the child has **not** already exited by the
end of `SIGTERM_GRACE_MS` (checked via a `processExited` flag set at the
top of the `close` handler — not inferred from timing). `SIGKILL` is
uncatchable on POSIX, so a child that ignores `SIGTERM` cannot ignore
this. On Windows there is no real signal delivery: any `kill()` call
already terminates the process unconditionally (`TerminateProcess`)
regardless of the signal name given — so on Windows the escalation is
either a no-op (the first call already terminated the process) or a
harmless redundant call; it is never required for correctness there, but
costs nothing to keep for a single, platform-branch-free implementation.
Also wrapped in `safeKill()` for the same already-exited-throws-safely
guarantee.

## 7. Exactly-Once Settlement

`finish()` remains the single settlement point (guarded by `settled`,
unchanged). What changed: once `timedOut` is `true`, `finish()` **always**
constructs a fresh canonical timeout error (`timeoutError()`) rather than
passing through whatever error object triggered the call — closing the
gap identified in §3 where a post-timeout `error` event could have leaked
a raw error. Combined with the pre-existing `close`-handler ordering
(`timedOut` checked before the exit-code check), this guarantees:

- A post-timeout `close(0, ...)` (the child happened to finish
  successfully right after) is still reported as `GMGN_CLI_TIMEOUT`, never
  success.
- A post-timeout `close(nonzero, ...)` is still `GMGN_CLI_TIMEOUT`, never
  `GMGN_CLI_NONZERO_EXIT`.
- A post-timeout `error` event is still `GMGN_CLI_TIMEOUT`, never the raw
  error's own message/shape.
- Any stdout received before the timeout is irrelevant once `timedOut` is
  true, because there is no code path from `timedOut === true` to
  `resolve()` — the `close` handler checks `timedOut` and returns before
  ever reaching the success branch. This structurally guarantees
  `gmgnJson()` can never attempt to `JSON.parse` stale/partial stdout from
  a timed-out call and misreport `GMGN_CLI_MALFORMED_OUTPUT`.

All four of these are covered by dedicated tests (§9).

## 8. Cross-Platform Considerations

No `process.platform` branch was added. `cross-spawn` (Phase 4.5.1)
continues to handle the POSIX/Windows spawn difference transparently, and
Node's `ChildProcess#kill()` already abstracts signal delivery per
platform — on Windows, both `SIGTERM` and `SIGKILL` resolve to the same
unconditional `TerminateProcess` call, so a single code path is correct
and sufficient for both platforms; no platform-specific termination
mechanism needed to be implemented. This was verified, not assumed: the
real-OS-process test (§9) runs the actual escalation logic against a real
child process on this development machine (Windows) and confirms it
terminates and is reported as `GMGN_CLI_TIMEOUT` within the expected
bound.

`shell: true` was not introduced anywhere (confirmed by grep — the only
occurrences of the word "shell" in the file are in pre-existing
explanatory comments). The existing argument-allowlist gate
(`assertSafeCliArg`/`UNSAFE_ARG_RE`) is completely unmodified, still
applied at the same call site.

## 9. Tests Added

All in `test/gmgnCli.test.ts` (11 new tests) plus one new fixture file:

- `test/fixtures/ignore-sigterm.mjs` — a tiny, test-only Node script that
  installs a no-op `SIGTERM` handler (deliberately ignoring it) and
  self-terminates after a bounded 15s lifetime regardless of what happens
  to it externally — guaranteeing it can never outlive the test suite
  even if the implementation under test were broken.

| # | Test | What it proves |
|---|---|---|
| 1 | `escalation: process exits promptly after SIGTERM -> SIGKILL is never sent` | A well-behaved child is never escalated; timers are cleaned up (re-checked 2.5s later — no late `SIGKILL`) |
| 2 | `escalation: a child that ignores SIGTERM is escalated to SIGKILL` | The core fix: an unresponsive child gets `['SIGTERM', 'SIGKILL']` |
| 3 | `escalation: a child that ignores both signals does not make the wrapper wait forever` | Bounded settlement (< 8s) even for a child that never dies |
| 4 | `escalation: SIGTERM throwing (process already gone) settles safely` | Case D from the task's list |
| 5 | `escalation: SIGKILL throwing (process already gone) settles safely` | Case F |
| 6 | `escalation: a close(code=0) event racing after timeout is still reported as timeout, never as success` | §7's first guarantee |
| 7 | `escalation: an error event racing after timeout is reported as timeout, never leaked raw` | §7's third guarantee |
| 8 | `escalation: timeout never becomes a malformed-JSON error even if stdout received data first` | §7's fourth guarantee |
| 9 | `escalation: timeout never becomes a non-zero-exit error` | §7's second guarantee |
| 10 | `gmgnJson: a timeout from the real escalation path classifies as GMGN_CLI_TIMEOUT end to end` | The fix integrates correctly with the unchanged caller-side classification |
| 11 | `real OS process: a child that truly ignores SIGTERM is terminated and reported as timeout` | **Real OS process**, real PID captured and confirmed gone afterward via `process.kill(pid, 0)` throwing `ESRCH` |

Tests 1–3 and 5 use a fully-controlled fake child (injected via a new,
test-only `spawnFn` option on `runGmgnProcess`) rather than racing real
OS timers — real POSIX-vs-Windows signal semantics differ enough (Windows
has no genuine "ignore a signal" capability) that the exact escalation
*sequencing* is proven more rigorously and portably this way. Test 11 is
the one real-OS-process test required by the task's §10, with its own
bounded outer timeout (15s) so a broken implementation cannot hang the
suite.

One iteration note, disclosed rather than hidden: the first version of
tests 4 and 5 used fixed-delay `setTimeout` calls to simulate the "close
arrives shortly after the throw" race, with too thin a margin (5ms and
30ms respectively) against the real 2000ms grace timer — this was
flaky under full-suite load (passed in isolation, failed intermittently
when run alongside every other test file's own timers). Root-caused and
fixed by making the fake child's `'close'` emission for the `'throw'`
kill-behavior event-driven (`setImmediate`, fired synchronously from
within the mocked `kill()` call itself) instead of a guessed delay —
removing the race entirely rather than widening the margin. Verified
stable across 3 isolated runs and 2 full-suite runs after the fix.

## 10. Focused Test Result

```
npx tsx --test test/gmgnCli.test.ts
tests 29, pass 29, fail 0
```
(18 pre-existing Phase 4.5.1 tests + 11 new this phase — all passing,
none removed or weakened.)

## 11. Full Test Result

```
npm test
tests 294, pass 294, fail 0
```
(283 pre-existing baseline — Phase 4.5.2 + Phase 4.6/4.6.1 work, all
preserved byte-for-byte — + 11 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

## 12. Typecheck Result

```
npm run typecheck
```
Clean.

## 13. Build Result

```
npm run build
```
Clean.

## 14. Security Regression Check

- `shell: true`: not introduced (grep-confirmed — only pre-existing
  explanatory comments mention the word).
- Argument validation (`assertSafeCliArg`/`UNSAFE_ARG_RE`): byte-for-byte
  unmodified, same call site, same behavior — re-confirmed passing via
  the existing "argument safety" tests (both positive and negative
  cases), unchanged.
- No user-controlled value can alter the child command: the fix touches
  only signal-delivery/timer logic after the child has already been
  spawned with its (already-validated) arguments — no new argument
  construction of any kind was added.
- Executable resolution: unchanged (`cliPath()`, untouched).
- `cross-spawn` usage: unchanged in the default path; the new `spawnFn`
  injection point defaults to the exact same `crossSpawn(file, args, { env })`
  call as before, and is only ever overridden in test code.

**PASS** — no security regression.

## 15. Diff Scope Audit

```
git diff --stat -- src/gmgn/cli.ts test/gmgnCli.test.ts
 src/gmgn/cli.ts      | 113 ++++++++++++++++++---
 test/gmgnCli.test.ts | 276 ++++++++++++++++++++++++++++++++++++++++++++++++++-
 2 files changed, 372 insertions(+), 17 deletions(-)
```

Plus one new file: `test/fixtures/ignore-sigterm.mjs` (the SIGTERM-ignoring
test helper, §9).

**No other file was modified by this phase.** `git status --short` at the
start of this phase showed pre-existing uncommitted Phase 4.5.2 and Phase
4.6/4.6.1 changes (`PHASE4_5_VALIDATION_REPORT.md`, `src/chain/ticks.ts`,
`src/db/index.ts`, `src/index.ts`, `src/pnl/reconcile.ts`,
`src/strategy/multiExecute.ts`, `test/reconcile.test.ts`,
`test/strategy.multiExecute.test.ts`, `test/strategy.multiRange.test.ts`,
`test/strategy.multiRisk.test.ts`, plus several new untracked files
including `src/instanceLock.ts` and its tests) — every one of these was
left completely untouched this phase, confirmed by `git diff --stat -- <file>`
showing zero additional changes beyond what already existed at the start
of this turn. No reset, stash, checkout, or revert was performed at any
point.

## 16. Remaining P2/P3 Findings

Every other Phase 4.6 finding is **intentionally untouched** by this
phase, exactly as scoped:

- `scoreMultiPool` NaN propagation (carried forward from Phase 4.5.2,
  BUG-003) — not touched.
- Health endpoint, recovery latency, TP/SL shutdown, config validation,
  memory growth, retry stacking, global error handlers — none of these
  were inspected or modified this phase; they remain exactly as the
  Phase 4.6 audit left them, for a future, separately-scoped phase.

## 17. Verdict

**PASS**

The P2 finding (no SIGKILL escalation on an unresponsive `gmgn-cli`
child) is fully fixed: bounded SIGTERM→grace→SIGKILL→bounded-wait
escalation, exactly-once settlement preserved and strengthened (the
`error`-event leak gap closed as part of the same fix), no orphan
process left behind (verified against a real OS process), no security
regression, no trading/strategy logic touched, all existing tests
preserved and passing, 11 new regression tests added including one real
end-to-end OS-process test.

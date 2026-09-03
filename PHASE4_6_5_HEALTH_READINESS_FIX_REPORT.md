# PHASE 4.6.5 HEALTH & READINESS FIX REPORT

## 1. Original P2 Finding

"No health/readiness signal exists anywhere. Process-alive is currently
the only external signal." (Phase 4.6 reliability audit.)

## 2. Existing Lifecycle

Traced `src/index.ts` before any edit: a single `async function main()`
that runs sequentially through instance-lock acquisition, DB/wallet
touch, startup tx-recovery, startup ledger-recovery, MULTI config check,
Telegram webhook/commands setup, then starts the TP/SL watcher, the
volume-alert watcher, and `bot.start()` (long-polling, not awaited). No
explicit state variable existed anywhere for "where is startup right
now" — a caller could only infer state indirectly from log lines. Most
steps that can fail are wrapped in `try/catch` and explicitly continue
(non-fatal); the only two ways the process visibly stops are an
instance-lock conflict (`process.exit(1)` immediately) or an uncaught
error propagating out of `main()` (`main().catch(...)`, also
`process.exit(1)`). `SIGINT`/`SIGTERM` call `stopTpslWatcher()` (Phase
4.6.4, now async/bounded), `stopVolumeAlertWatcher()`, `bot.stop()`,
`releaseInstanceLock()` (Phase 4.6.1) — no explicit "now stopping" signal
existed anywhere for an external observer.

No HTTP server of any kind existed in this codebase (confirmed by
grep: zero references to `createServer`/`express`/`fastify`/`node:http`,
and no such dependency in `package.json`).

## 3. Health Model

New file `src/health.ts`, an explicit 5-state lifecycle:

```ts
type AppLifecycleState = 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';
```

Three genuinely distinct signals, deliberately never conflated (the
task's central requirement):

| Signal | Answers | Depends on |
|---|---|---|
| **LIVENESS** (`GET /health`) | "Is the process/event loop alive enough to respond?" | Nothing but this HTTP server itself responding — no RPC, no GMGN, no DB |
| **READINESS** (`GET /ready`) | "Has startup finished and can normal services operate?" | The local `lifecycleState` variable only — set explicitly by `src/index.ts` at each real transition |
| **TRADING_SAFE** | "Is it safe to trade right now?" | **Deliberately reported as the literal string `"NOT_EXPOSED"`** — see §6 |

## 4. Liveness Design

`buildLivenessResponse()` reads only `process.uptime()`, `Date.now()`,
and the local `lifecycleState` variable — no import from `chain/`,
`gmgn/`, or `db/` anywhere in `health.ts` (verified by reading the full
file's import list: only `node:http`). Always resolves to HTTP 200
regardless of lifecycle state (even `'failed'`/`'stopping'`) as long as
the health server itself can respond — an external dependency being down
is a readiness concern, never grounds to report the process dead.
Measured to complete in well under 5ms (test asserts this, effectively
proving "no I/O" structurally: a real RPC/GMGN call could not possibly
complete synchronously that fast).

## 5. Readiness Design

`buildReadinessResponse()` reports `ready: true` (200) if and only if
`lifecycleState === 'ready'`, otherwise 503 with the actual current state
named (`starting`/`failed`/`stopping`/`stopped`) so an operator can tell
*why* it isn't ready, not just that it isn't. `src/index.ts` sets
`'ready'` only after the **entire** startup sequence has completed:
instance lock acquired, startup tx-recovery attempted, startup
ledger-recovery attempted, MULTI config checked, Telegram
webhook/commands registered, TP/SL watcher started, volume-alert watcher
started, and `bot.start()` invoked — matching the task's required order
exactly (§11: "instance lock → startup recovery → required initialization
→ service startup → READY").

An `unresolved-transaction count > 0` after startup tx-recovery, and any
`RECONCILIATION_REQUIRED` ledger findings, are surfaced as `warnings` in
the `/ready` JSON body — **informational only, never gating the HTTP
status**. This was a deliberate design decision: the task's §11 wording
suggests these might block readiness, but this codebase's *existing*,
*unmodified* architecture explicitly does not treat them as fatal to
startup (`chain/clients.ts`'s own comment: "there's no unsafe window even
if this is skipped or partially fails" — because the *real* safety gate
is the per-wallet pre-send check in `journalledSend`, not a global
startup gate). Making readiness block on this would have meant inventing
a new policy this phase's own safety principle explicitly forbids
("Do NOT invent a new safety policy... health/readiness must never bypass
existing safety gates" — the inverse also holds: it must not invent a new
one that doesn't already exist). Surfacing it as a warning satisfies the
actual goal (operator observability) without touching the real gate.

## 6. Trading-Safe Semantics

**`TRADING_SAFE = NOT_EXPOSED`**, always, unconditionally, regardless of
lifecycle state (tested explicitly across all 5 states).

This codebase's actual transaction-safety gates are per-operation and
intentionally scattered — the pre-send tx-lock/journal check in
`chain/clients.ts`, MULTI's own `runRiskGate()`, TP/SL's own lifecycle
state machine (Phase 4.6.4) — each re-validates independently at the
moment of the actual operation. There is no single existing authoritative
"safe to trade right now" boolean anywhere to surface faithfully.
Synthesizing one for this endpoint would mean inventing a new,
cross-cutting policy that doesn't correspond to how safety is actually
enforced today, and could be misread by an operator or automated system
as a green light that this endpoint has no authority to give. Reporting
the literal string `NOT_EXPOSED` is the honest, disciplined answer the
task's §7 explicitly anticipates as correct when this condition holds.

## 7. Startup Integration

```
startHealthServer() [liveness available]
  -> acquireInstanceLock()            [fail -> setLifecycleState('failed'), exit]
  -> getDb() / wallet touch
  -> runStartupTxRecovery()            [failure/unresolved -> readinessNotes, non-fatal]
  -> recoverMissingLedger()            [reconciliation-required -> readinessNotes, non-fatal]
  -> loadMultiConfig() / validate
  -> bot webhook/commands setup
  -> startTpslWatcher() / startVolumeAlertWatcher() / bot.start()
  -> setLifecycleState('ready', readinessNotes)
```

The health server is started **first**, before the instance-lock check,
so liveness is observable for the brief window even if the process is
about to refuse to start due to a lock conflict.

## 8. Shutdown Integration

`SIGINT`/`SIGTERM` handlers now call `setLifecycleState('stopping')` as
their **very first action**, before `await stopTpslWatcher()` (Phase
4.6.4's own bounded wait) or anything else — `GET /ready` reflects
not-ready the instant a shutdown signal arrives, not after cleanup
finishes. `GET /health` continues returning 200 throughout graceful
shutdown (the task's explicit allowance), since the HTTP server itself
keeps responding until `stopHealthServer()` is called at the very end,
after `setLifecycleState('stopped')`.

## 9. HTTP Endpoints

Implemented with Node's built-in `node:http` module only — no new
dependency, no web framework (`package.json` unchanged for
dependencies). `GET /health` (aliases `/healthz`, `/live`, `/livez`) and
`GET /ready` (alias `/readyz`); any other path returns 404. Every
response is single-shot JSON with `Connection: close` (no keep-alive),
which is also why `stopHealthServer()`'s `server.close()` resolves
promptly without needing to track/force-close lingering sockets.

Response body fields: `status` (`ok`/`not_ready`/`not_found`), `state`
(the exact lifecycle state), `timestamp`; liveness adds `uptimeSeconds`;
readiness adds `readySince`, `tradingSafe`, and `warnings` when present.
No chain ID, strategy name, address, or any other project-specific detail
was added — kept to the minimum needed for the stated purpose, per §17's
instruction not to turn this into a broader config-surfacing feature.

Configuration: `HEALTH_PORT` env var (optional), validated by
`resolveHealthPort()` — any missing/non-integer/out-of-range value falls
back to the default (`8080`) with a logged warning, never a crash.

## 10. Failure-State Behavior

| Scenario | Liveness | Readiness |
|---|---|---|
| A. Startup success | 200 | 200 once 'ready' is set |
| B. Startup still running | 200 | 503 (`state: starting`) |
| C. Startup failure (e.g. instance-lock conflict, uncaught error) | 200 (until process actually exits) | 503 (`state: failed`) |
| D. RPC unavailable | 200 — `health.ts` never calls RPC | Unaffected — readiness only reflects `lifecycleState`, not RPC health |
| E. GMGN unavailable | 200 — `health.ts` never calls GMGN | Unaffected, same reason |
| F. Monitoring/volume-alert watcher unavailable | 200 | Unaffected — `startVolumeAlertWatcher` failure was never wired to lifecycle state (out of scope: no existing "monitoring health" signal to surface without inventing one) |
| G. Shutdown requested | 200 (server still responds) | 503 (`state: stopping`) immediately |
| H. Process healthy, external dependency unhealthy | 200 | 200 if startup already completed (with a `warnings` note if the dependency issue was detected at startup, e.g. unresolved tx) — an external dependency being *currently* down after a successful startup is not tracked here at all, since doing so would require polling that dependency on every request, which §10/§22 explicitly forbid |

## 11. Security Review

- No secrets in any response: verified by an explicit test asserting the
  combined JSON of every response never contains `privatekey`,
  `private_key`, `seed`, `mnemonic`, `telegram_bot_token`, `apikey`,
  `api_key`, `secret`, `password`, or any `0x`-prefixed value (address/hash).
- No wallet data, no transaction data, no position data — the response
  bodies contain only lifecycle/uptime/timestamp fields, by construction
  (traced: nothing in `health.ts` imports from `wallet/`, `chain/`, or
  `db/`).
- No command execution surface: the HTTP handler only reads
  `req.url` and does an exact string match against a fixed allowlist of
  four paths — no path is ever passed to `eval`, `child_process`, or any
  dynamic code path. No `shell`/`exec`/`spawn` anywhere in `health.ts`.
- The endpoint is strictly GET-semantics/read-only: no route accepts a
  body, no route mutates any state (`lifecycleState` is only ever
  *written* by `src/index.ts`, never by an incoming HTTP request) — it
  cannot become a transaction-control endpoint because it has no code
  path that could reach one (no import of any execution/strategy module).

## 12. Performance Review

Both handlers are synchronous and touch only local variables — no
blockchain RPC, no GMGN CLI invocation, no database read, no position
scan, no transaction-recovery run on any request. Verified with a timing
assertion (liveness response construction completes in <5ms) and with a
real-HTTP-server test issuing 10 consecutive requests to confirm
sustained responsiveness with no degradation or leak.

## 13. Tests Added

New file `test/health.test.ts` (15 tests):

| # | Test |
|---|---|
| 1 | Starting state: not ready, liveness unaffected |
| 2 | Readiness becomes true only after the explicit `'ready'` transition |
| 3 | Startup failure (`'failed'`) never reports ready; liveness still 200 |
| 4 | Shutdown (`'stopping'`) immediately flips readiness, even from a prior `'ready'`; liveness stays 200 |
| 5 | `'stopped'` also reports not-ready |
| 6 | `tradingSafe` is always the literal `NOT_EXPOSED`, across all 5 states |
| 7 | Readiness warnings are informational only — never change the HTTP status |
| 8/9 | Liveness performs no I/O (timing proof); liveness stays 200 while readiness independently reflects an unhealthy startup (RPC/GMGN-down modeled as `'failed'`, since `health.ts` has no RPC/GMGN dependency to fail in the first place) |
| — | No secrets/addresses in any response |
| — | `resolveHealthPort` safely falls back on missing/non-numeric/out-of-range values |
| **19 (real HTTP)** | **Mandatory real server test** — see §14 |
| — | Starting the server twice is idempotent, returns the identical bound port |
| — | A genuine port-in-use bind failure is reported (`started:false`), never thrown |
| — | Stopping a never-started server is a safe no-op |

One iteration note, disclosed rather than hidden: the first version of
`startHealthServer()` resolved with the *requested* port number, not the
port the OS actually bound — invisible when a fixed port is given, but
silently wrong for `port: 0` ("OS, pick one"), which is exactly how the
real-HTTP-server tests obtain a collision-free ephemeral port for
testing. Caught immediately by three tests failing on first run (`port`
reported as `0`, and a deliberately-provoked port collision not actually
being detected because the "held" port was itself misreported as `0`).
Fixed by reading the real bound port from `server.address()` after
`listen()` resolves — a genuine bug in this phase's own new code, found
and fixed before this report was written, not a pre-existing defect.

## 14. Real HTTP Test

`test/health.test.ts`'s `'real HTTP server: ...'` test starts the actual
server via `startHealthServer(0)` (ephemeral port), then issues real
`fetch()` requests over a real TCP socket to `http://127.0.0.1:<port>`:
confirms `/ready` returns 503 with `not_ready`/`starting` before the
lifecycle flips, confirms `/health` returns 200 with a real
`Content-Type: application/json` header and a numeric `uptimeSeconds`,
flips the lifecycle to `'ready'` and confirms the **same running
server**, on a fresh request, now returns 200 for `/ready`, confirms an
unknown path returns 404 rather than crashing, and issues 10 more
requests to confirm sustained responsiveness. `stopHealthServer()` is
called in a `finally` block to guarantee cleanup regardless of test
outcome.

## 15. Full Test Results

```
npm test
tests 337, pass 337, fail 0
```
(322 pre-existing baseline — Phase 4.5.2 + Phase 4.6/4.6.1/4.6.2/4.6.3/
4.6.4, all preserved byte-for-byte — + 15 new this phase.) Verified
stable across 2 consecutive full-suite runs and 3 consecutive isolated
runs of the new file (checking specifically for port-allocation
flakiness, given the real-HTTP-server tests use ephemeral ports).

## 16. Typecheck

```
npm run typecheck
```
Clean.

## 17. Build

```
npm run build
```
Clean.

## 18. Diff Scope Audit

```
git diff --stat -- src/health.ts src/index.ts test/health.test.ts
 src/index.ts | 96 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++---
 1 file changed, 92 insertions(+), 4 deletions(-)
```
(`src/health.ts` and `test/health.test.ts` are new, untracked files —
`git diff` shows only the one pre-existing tracked file this phase
touched.) The `src/index.ts` diff is entirely additive around the
existing, unmodified Phase 4.6.1 (instance lock) and Phase 4.6.4 (TP/SL
shutdown) code — every pre-existing line from those phases is present
and unchanged; the only additions are `setLifecycleState(...)` calls at
each real transition point and the new `startHealthServer`/
`stopHealthServer` calls at the very start/end of the process lifecycle.

**No other file was modified by this phase.** `git status --short` at
the start of this phase showed the exact same pre-existing uncommitted
Phase 4.5.2 / 4.6 / 4.6.1 / 4.6.2 / 4.6.3 / 4.6.4 changes as at the end —
confirmed by `git diff --stat` on every one of those files showing zero
additional changes beyond what already existed at the start of this
turn. No reset, stash, checkout, or revert was performed at any point.

## 19. Remaining P2/P3 Findings

Every other Phase 4.6 finding is **intentionally untouched**:

- `scoreMultiPool` NaN propagation (Phase 4.5.2, BUG-003).
- `runStartupTxRecovery`'s sequential loop (Phase 4.6.3, noted as
  structurally similar to the fixed pre-send loop but out of scope
  there).
- Config validation, memory growth, retry stacking, global exception
  handling — none inspected or modified this phase.
- Instance lock, GMGN CLI, persistence implementation, TP/SL shutdown —
  confirmed untouched by this phase's diff (§18's `git diff` scoping);
  this phase only *calls* the already-existing, already-hardened
  `stopTpslWatcher()`/`releaseInstanceLock()` at the same points they
  were already called, in the same order.

## 20. Verdict

**PASS**

Liveness exists, is reliable, and is provably independent of RPC/GMGN
(no import of either anywhere in `health.ts`, sub-5ms response
construction). Readiness is a genuinely distinct signal driven by an
explicit lifecycle state set only by `src/index.ts` at real transitions.
No false-ready path exists (startup-incomplete, startup-failed, and
shutdown-in-progress all report 503, tested explicitly). No false-dead
path exists (liveness stays 200 across every non-`ready` state,
including `'failed'` and `'stopping'`). Shutdown flips readiness
immediately, before any bounded cleanup wait. No secrets, wallet data, or
transaction data appear in any response. Health/readiness never
authorizes, bypasses, or replaces any existing safety gate — confirmed by
`TRADING_SAFE` being explicitly `NOT_EXPOSED` rather than fabricated, and
by `health.ts` importing nothing from any execution/strategy/wallet
module. The real HTTP test passes against an actual server over an
actual socket. 337/337 tests pass, typecheck and build are clean.

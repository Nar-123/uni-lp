# PHASE 4.6 RELIABILITY & PRODUCTION READINESS AUDIT

**Audit only. No source, test, config, or lockfile was modified. See §2 and the
final `git status --short` in §24.**

## 1. Executive Summary

This phase audited the whole system for reliability and production-readiness
risk, independent of and in addition to Phase 1-4.5.2's correctness/capital-
safety work. Those prior phases are unusually rigorous: an explicit
transaction journal + recovery state machine (`chain/txRecovery.ts`,
`chain/clients.ts`), per-(chain,wallet) send serialization (`chain/txLock.ts`),
fail-closed price/quote/simulation/gas handling, a hardened `gmgn-cli`
subprocess wrapper with an argument allowlist, and a TP/SL watcher that
explicitly distinguishes "position confirmed gone" from "state unknown" and
never disarms protection on the latter. No new infinite loop and no new
transaction-duplication code path were found in that core execution
pipeline.

The material findings this phase are concentrated in one place that prior
phases did not focus on: **the local JSON-file persistence layer
(`src/db/index.ts`) that the entire journal/ledger/recovery system is built
on top of.** It is a single un-pruned (for positions/ledger), non-atomically-
written JSON file, loaded once into memory and rewritten whole-file,
synchronously, on every mutation, with no corruption handling on load and no
guard against two process instances sharing it. This does not weaken any of
Phase 1-4.5.2's *logical* invariants — it undermines the *durability*
those invariants assume. Two findings from this (BUG P1-1, P1-2) are
classified P1 under this phase's rubric because they are realistic
production failure modes (a hard kill during a write; an operator or
process-manager accidentally overlapping two instances), not because the
day-to-day happy path is unsafe.

- **P0: 0**
- **P1: 2** (both in the persistence layer, both narrow and independently fixable)
- **P2: 6**
- **P3: 4**
- One item (BUG-003, `scoreMultiPool` NaN propagation) is carried forward
  from Phase 4.5.2 as still open — not rediscovered as new, not re-scored.

No code was fixed. No file except this report was created or modified.

## 2. Repository State

```
$ git status --short
 M PHASE4_5_VALIDATION_REPORT.md
 M src/chain/ticks.ts
 M src/db/index.ts
 M src/pnl/reconcile.ts
 M src/strategy/multiExecute.ts
 M test/reconcile.test.ts
 M test/strategy.multiRange.test.ts
?? PHASE4_5_2_VALIDATION_REPORT.md
?? test/ticks.test.ts

$ git branch --show-current
master

$ git log --oneline -10
edb8630 fix: harden gmgn cli and cleanup
8396b44 feat: implement multi strategy
1c627ef Phase 2-4: quote/gas/tx hardening, PnL reconciliation, and MULTI strategy
bb9ba67 Phase 1 capital-safety hardening

$ git remote -v
origin  https://github.com/Nar-123/uni-lp.git (fetch)
origin  https://github.com/Nar-123/uni-lp.git (push)
```

The 6 modified + 2 untracked files are exactly Phase 4.5.2's own
uncommitted work (verified via `git diff`, reproduced below in relevant
part): the `computeSingleSidedRange` finite-number guard in `ticks.ts`, the
`strategy?: string` field threaded through `db/index.ts` →
`multiExecute.ts` → `pnl/reconcile.ts` for MULTI's crash-recovery
attribution fix, and their corresponding new/updated tests. All were left
exactly as found — none were touched, staged, committed, or reverted.

## 3. System Architecture Reviewed

Read in full: `src/index.ts`, `src/config.ts`, `src/chain/{retry,txLock,
txRecovery,clients,gas,prices,ticks,tickBitmap}.ts`, `src/db/index.ts`,
`src/pnl/reconcile.ts`, `src/strategy/multiExecute.ts`, `src/bot/
{tpslWatcher,volumeAlertWatcher,auth}.ts`, `src/gmgn/cli.ts`,
`PHASE4_5_2_VALIDATION_REPORT.md` (for context on already-fixed/already-
documented issues).

Targeted (grep + section reads, not full reads): `src/bot/bot.ts` (~3850
lines — command registration, auth gating, global error boundary, close-
position flow), `src/chain/relay.ts`, `src/chain/across.ts`,
`src/chain/tickBitmap.ts` (bounded-loop verification only).

Not read line-by-line this phase (no new pattern found in adjacent files
that would suggest a materially different risk profile, and effort was
budgeted toward the areas §4-§13 of the task explicitly prioritize):
`src/chain/{mint,close,swap,pools,positions,quote,priceImpact,fees,
tokens,tokenBalances,revoke,transfer,wrap,v4,uniswap,safety,tradingApi,
abis}.ts`, `src/gmgn/screener.ts`, `src/bot/{quickMint,session}.ts`,
`src/strategy/{multiCandidates,multiPool,multiConfig,multiRisk,index,
types}.ts`, `src/pnl/{compute,card}.ts`, `src/price/{dexscreener,
uniswapExplore}.ts`, `src/wallet/keys.ts`. These are lower-confidence by
omission, not cleared — see §21.

Confirmed absent (Glob): `Dockerfile`, `docker-compose*`, `*.service`,
`ecosystem*.config.js`, or any other process-manager config anywhere in
the repository. Confirmed absent (grep across `src/`): any HTTP server,
`/health` endpoint, or `.listen(` call of any kind.

## 4. P0 Findings

None found.

## 5. P1 Findings

### P1-1 — Non-atomic, unprotected JSON persistence undermines the entire crash-recovery design

- **File**: `src/db/index.ts`, functions `load()` (line ~483) and `persist()` (line ~703)
- **Mechanism**: The *entire* application state — positions, ledger, execution
  telemetry, and critically the **transaction recovery journal** that Phase
  2 Part 4 built specifically to survive crashes — lives in one JSON file,
  read once into an in-memory singleton and rewritten **in full** via
  `fs.writeFileSync(storePath, JSON.stringify(store, null, 2))` on every
  single mutation (a new ledger row, a journal state transition, a TP/SL
  toggle, etc.). This is a direct (not rename-based) overwrite of the
  target path, so it is not atomic with respect to process death:
  `writeFileSync` can be interrupted mid-syscall by `SIGKILL`, an OOM-kill,
  a container/VM stop, or a power loss, leaving a truncated or otherwise
  invalid JSON file on disk.
- **The load path has no defense**: `load()` calls
  `JSON.parse(fs.readFileSync(storePath, 'utf8'))` with no `try/catch`.
  `getDb()` — which calls `load()` — is the *first* line of `main()`
  (`src/index.ts:15`), before `runStartupTxRecovery()`, before
  `recoverMissingLedger()`, before the bot even constructs. A parse failure
  here throws synchronously out of `main()`, is caught only by the
  top-level `main().catch((err) => { console.error(err); process.exit(1);
  })`, and the process exits immediately.
- **Consequence**: A single unlucky write torn by an ordinary crash — the
  exact class of event the tx journal exists to survive — leaves the bot
  **unable to start at all** on the next boot, with no ledger, no journal,
  no TP/SL enrollment, and no automated way to recover: there is no backup
  file, no versioned snapshot, no "restore last known good" path. This is
  a full trading outage (no new trades, and — more importantly — **no TP/SL
  protection on already-open positions**, since the watcher can't start
  either) until an operator manually inspects and hand-repairs or restores
  `data/bot.json`. It fails loud rather than silently continuing on
  corrupt data, which is the right instinct, but "loud" here means "the bot
  is down and open positions are unprotected until a human intervenes,"
  which is exactly the scenario the journal/recovery system was built to
  avoid.
- **Whether it can affect capital**: Indirectly but materially — not by
  corrupting an accounting number, but by taking TP/SL protection and the
  tx-recovery pre-send gate itself offline for an unbounded period after an
  ordinary process crash, at the worst possible time (right after a crash,
  when there may also be an unresolved in-flight transaction that the now-
  dead journal was supposed to help resolve).
- **Recommended fix**: Write to a temp file in the same directory and
  `fs.renameSync` over the target (atomic on POSIX; effectively atomic on
  Windows for same-volume renames) instead of writing the target path
  directly. Additionally: wrap `JSON.parse` in `load()` in a `try/catch`
  that, on failure, renames the corrupt file aside (e.g.
  `bot.json.corrupt-<timestamp>`) rather than deleting it, and either falls
  back to the most recent successfully-loaded state (if a rotating backup
  of the last N successful writes is kept) or fails startup with a message
  that names the exact corrupt file path so an operator can inspect it
  immediately rather than needing to debug a raw stack trace.
- **Regression test recommendation**: A test that (1) calls `persist()`
  via any mutation, (2) truncates the resulting file to a byte count that
  produces invalid JSON, (3) calls `__resetStoreForTests()` + any read
  function, and asserts the process does not crash uncaught and instead
  reports a clear, named error/fallback path. A second test asserting that
  after a fix, the on-disk file is never observably absent/zero-length
  between two successful `persist()` calls (i.e. verify write-temp+rename
  rather than truncate-then-write, by racing a reader against a writer in
  a fake/mocked fs or by checking the temp file's existence mid-write with
  a spy).

### P1-2 — No single-instance guard: two processes sharing one `dbPath`/wallet can silently corrupt state and can race a nonce

- **File**: `src/db/index.ts` (no lock acquired anywhere), `src/index.ts`
  (`main()` has no PID-file/lock check), `src/chain/txLock.ts` (its
  `queues` map is `new Map()` at module scope — **per-process** memory,
  not cross-process)
- **Mechanism**: Nothing in this codebase prevents two instances of the bot
  process from being started against the same `DB_PATH` and the same
  active wallet — e.g. a process manager (systemd/PM2/Docker) restarting a
  hung instance before confirming the old one has actually exited (a
  well-known real-world footgun, not a contrived scenario), or an operator
  manually running the bot twice during a deploy. Each instance loads its
  own independent in-memory `store` singleton from the same file at
  startup and calls `persist()` (full-file overwrite, no locking, no
  optimistic-concurrency check) independently — the last writer wins,
  silently discarding whatever the other instance had already recorded
  (a new position, a ledger row, a journal entry for a transaction it just
  broadcast).
- **Compounding factor**: `withTxLock`'s per-(chain,wallet) send
  serialization (§ chain/txLock.ts) is explicitly documented as in-memory
  and per-process — it provides *zero* protection against two different
  processes both fetching the same wallet's "pending" nonce from the RPC
  node at roughly the same time. Two overlapping instances trading the
  same wallet on the same chain can therefore genuinely race a nonce the
  same way the code comment in `txLock.ts` describes as the exact problem
  it was built to prevent *within* one process — just not across two.
- **Whether it can affect capital**: Yes, directly, in the overlap
  scenario: a duplicated/raced broadcast, or a lost ledger/journal entry
  for a transaction that did land on-chain (because the process that wrote
  it lost the last-write race against the other instance's stale
  in-memory copy).
- **Recommended fix**: Acquire an exclusive lock file (e.g.
  `<dbPath>.lock`, written with the current PID, checked/created with
  `wx` flag semantics or an `flock`-equivalent) at the very top of `main()`
  before `getDb()` is even called; refuse to start (loud, clear error
  naming the existing lock's PID) if the lock is already held by a live
  process. This is a small, self-contained, well-understood pattern and
  does not require restructuring the persistence layer itself.
- **Regression test recommendation**: A test that starts the lock
  acquisition twice in the same test process (simulating two instances)
  and asserts the second acquisition throws/fails clearly rather than
  silently succeeding.

## 6. P2 Findings

### P2-1 — `gmgn-cli` child-process timeout has no SIGKILL escalation

- **File**: `src/gmgn/cli.ts`, `runGmgnProcess` (line ~111)
- **Mechanism**: On timeout, the code does `child.kill('SIGTERM')` and
  waits for the `close` event to resolve/reject the promise. There is no
  secondary, delayed `SIGKILL` if the child (or a grandchild it spawns,
  e.g. if `gmgn-cli` itself shells out) ignores or is slow to honor
  SIGTERM. On POSIX, a process can trap or ignore SIGTERM entirely; on
  Windows, `child_process.kill()` maps to `TerminateProcess`, which is
  closer to a hard kill, so this is primarily a POSIX-deployment risk
  (relevant given no Docker/systemd config exists in-repo to confirm the
  target OS, and the earlier Phase 4.5.1/4.5.2 reports both mention
  Windows-specific development-time issues but say nothing about the
  production OS).
- **Consequence**: If SIGTERM doesn't terminate the child, `close` never
  fires, and `gmgnJson()`'s promise never settles — a genuine hang in the
  GMGN candidate/screener/alert pipeline despite the code's own
  `DEFAULT_TIMEOUT_MS` (30s) suggesting it's bounded.
- **Recommended fix**: Add a second, shorter timer (e.g. 5s) after
  `SIGTERM` that sends `SIGKILL` if `close` still hasn't fired.
- **Test recommendation**: Inject a test "runner" (the function already
  accepts an injectable `runner` for tests) that simulates a child
  ignoring SIGTERM, and assert `gmgnJson()` still settles within a bounded
  time.

### P2-2 — Sequential pre-send recovery checks can make every new send block for tens of seconds to minutes under sustained RPC instability

- **File**: `src/chain/clients.ts`, `journalledSend` (line ~122), the
  `for (const entry of unresolved)` loop (line ~134)
- **Mechanism**: Before any new send, `journalledSend` attempts to resolve
  *every* unresolved journal entry for that (chainId, wallet), one at a
  time, `await`ed sequentially. Each `resolveAmbiguousTx` call is itself
  bounded but not cheap: up to `RECEIPT_POLL_ATTEMPTS=6` polls at
  `RECEIPT_POLL_BACKOFF_MS=2_000 * attempt` backoff (hash-known path,
  worst case ~42s), or up to `NONCE_CHECK_ATTEMPTS=5` at
  `NONCE_CHECK_BACKOFF_MS=2_500 * attempt` (no-hash path, worst case
  ~37.5s) — and this repeats **per unresolved entry**, not in parallel.
  If a sustained RPC outage (or the already-documented chain-4663 DNS
  interception, §20 of the 4.5.2 report) leaves several transactions
  unresolved at once, every subsequent send attempt — a manual close, a
  TP/SL trigger, a MULTI entry — pays this full sequential cost again
  before either succeeding or hitting the "refusing new send" error.
- **Consequence**: Not an infinite hang, but a multi-tens-of-seconds-to-
  several-minutes stall on every trading action, which from an operator's
  perspective (a Telegram command that appears to do nothing for minutes)
  is functionally indistinguishable from a hang, and — more importantly —
  delays the TP/SL watcher's own close attempts by the same amount during
  exactly the period (RPC instability) when timely execution matters most.
- **Recommended fix**: Run the per-entry recovery attempts concurrently
  (`Promise.all`) rather than sequentially — they are independent reads
  against the same client and do not need to be serialized the way the
  broadcast itself does. Consider also short-circuiting: if an entry was
  already checked and left unresolved within the last N seconds, skip
  re-checking it on this particular send attempt and surface the existing
  "refusing new send" error immediately instead of re-paying the full
  poll window.
- **Test recommendation**: A test with 3+ unresolved entries and a mocked
  client whose calls take a fixed simulated delay, asserting total wall
  time for one `journalledSend` call is close to one entry's delay
  (parallel) rather than the sum of all entries' delays (sequential).

### P2-3 — Shutdown does not cancel in-flight TP/SL confirm timers or force-exit

- **File**: `src/index.ts` (SIGINT/SIGTERM handlers, line ~144-153),
  `src/bot/tpslWatcher.ts` (`stopTpslWatcher`, line ~362; the detached
  `setTimeout` at line ~278)
- **Mechanism**: `tick()`'s "first hit → arm" branch schedules a **bare**
  `setTimeout(() => void recheckAndMaybeClose(...), CONFIRM_MS)` (5s) that
  is not stored anywhere `stopTpslWatcher()` can reach. `stopTpslWatcher()`
  only `clearInterval`s the recurring 30s poll and clears the `pending`/
  `closing` maps. If SIGINT/SIGTERM arrives while a confirm timer is
  in-flight, that timer still fires 5 seconds later and calls
  `recheckAndMaybeClose`, which — despite `pending` having just been
  cleared, so its own `if (!pend || pend.kind !== expected) return;` guard
  *does* correctly no-op it in this specific case — illustrates that
  shutdown is not actually synchronous/complete when the handlers return:
  `main()` never calls `process.exit()` after cleanup, relying entirely on
  the event loop draining naturally. Any future code path that schedules
  a bare, untracked timer that does *not* happen to re-check a
  now-cleared map (unlike this one, which does) would not have the same
  incidental protection.
- **Consequence**: Today, this specific timer is a near-miss rather than a
  live bug (the `pending` map re-check happens to save it) — but it is a
  fragile safety property (works because of a `Map.get` returning
  `undefined` after `.clear()`, not because shutdown is actually
  orchestrated), and there is no forced-exit fallback if `bot.stop()` or
  any other cleanup step hangs (e.g. a stuck long-poll HTTP request) — the
  process would then never exit at all, which for a process manager
  expecting a clean stop can itself turn into a forced `SIGKILL` at an
  arbitrary later point, mid- whatever else is running.
- **Recommended fix**: Track scheduled recheck timers (e.g. in a `Map<key,
  NodeJS.Timeout>`) so `stopTpslWatcher()` can `clearTimeout` them
  explicitly; add a bounded force-exit (`setTimeout(() => process.exit(0),
  N).unref()`-guarded-against, or an explicit deadline) in the
  SIGINT/SIGTERM handlers so a hung shutdown doesn't linger indefinitely
  or get killed at an unpredictable moment.
- **Test recommendation**: Start a watcher, arm a pending trigger, call
  `stopTpslWatcher()`, advance fake timers past `CONFIRM_MS`, and assert
  `recheckAndMaybeClose`'s underlying close function was never invoked —
  today this would pass by the incidental mechanism above, but the test
  should exist so a future refactor that breaks the incidental protection
  is caught.

### P2-4 — No health/liveness signal of any kind

- **Files**: entire codebase (confirmed absent via grep — see §3)
- **Mechanism**: There is no HTTP health endpoint, no readiness file, no
  structured "I am fully initialized and trading-capable" signal anywhere.
  The only external observability into whether the bot is functioning is
  whether the OS process is alive.
- **Consequence** (mapped to the requested PROCESS ALIVE / SYSTEM READY /
  TRADING SAFE distinction): a process manager, or an operator, cannot
  distinguish "process alive" from any of: the TP/SL watcher's `running`
  flag stuck permanently `true` (would require an exception path that
  somehow escapes the `try/finally` — not found this phase, but nothing
  externally verifies it either way), the pre-send gate permanently
  refusing all sends due to unresolved journal entries (§P1-related — a
  legitimately "safe" state, but indistinguishable externally from "the
  bot silently stopped doing anything"), `gmgn-cli` auth having expired
  (screener/alerts/MULTI all silently non-functional while manual
  mint/close/swap continue working fine), or Telegram long-polling having
  quietly stopped receiving updates.
- **Recommended fix**: A minimal internal counter/timestamp updated by
  each of: the TP/SL watcher's tick, the volume-alert watcher's tick, and
  the last successful Telegram `getUpdates` cycle, exposed via a tiny
  local HTTP endpoint (or even just a periodic self-check that pages the
  operator via Telegram if any of these staleness thresholds are
  exceeded) — does not need to be elaborate to close most of this gap.
- **Test recommendation**: N/A until a mechanism exists; once one does, a
  test that simulates a stalled watcher (mock `Date.now()` advancing past
  the poll interval without a corresponding tick) and asserts the
  readiness signal reflects it.

### P2-5 — Config values used without runtime validation at startup

- **File**: `src/config.ts` (`CHAINS[4663].usdc` line 83; `getConfig()`'s
  `rpc` block, lines 211-215)
- **Mechanism**: `usdc: (process.env.USDC_4663 as Address | undefined) ??
  undefined` is a pure TypeScript type assertion, not a runtime check —
  `isAddress()` (already imported and used elsewhere in this same file,
  e.g. `assertAddress`) is never called on it. Similarly, `RPC_4663`/
  `RPC_56`/`RPC_8453` are read as raw strings and handed directly to
  `viem`'s `http()` transport with no URL-format validation.
- **Consequence**: A malformed env value (typo, extra whitespace, wrong
  length) is not caught at startup — it is only caught later, deep inside
  whatever code path first uses it, as a comparatively opaque runtime
  error (an `isAddress` check failing somewhere unrelated, or a transport
  connection error) rather than a clear "invalid `USDC_4663`" message at
  boot. This is a fail-fast/observability gap, not a capital-safety gap —
  nothing in the audited paths treats an unvalidated address as
  automatically trusted for a trade (every actual USDG/USDC comparison
  site independently lowercases and compares, per Phase 4.5.2 §5) — but
  it does mean a config mistake surfaces at the worst possible time
  (mid-operation) instead of the best (boot).
- **Recommended fix**: Validate every chain-specific address env override
  and every RPC URL with `isAddress()`/`new URL()` respectively inside
  `getConfig()`, throwing a specific, named error before the bot starts
  accepting commands.
- **Test recommendation**: Set a malformed `USDC_4663`/`RPC_56` in a test
  environment and assert `getConfig()` throws a specific, identifiable
  error rather than succeeding silently.

### P2-6 — `scoreMultiPool` NaN propagation (carried forward, not re-scored)

Documented in full in `PHASE4_5_2_VALIDATION_REPORT.md` §23 as BUG-003:
`Math.min(1, tvlUsd / TVL_REFERENCE_USD)` propagates `NaN` into
`totalScore` if `tvlUsd`/`volumeUsd` is ever literally `NaN` (a malformed
upstream DexScreener numeric field), affecting only ranking quality among
already-filtered, already-tradeable pools — not a safety bypass. Still
open, still uncommitted (it was never fixed, only documented), still not
fixed by this phase per the audit-only mandate. Listed here for
completeness so it isn't lost between validation-report and audit-report
tracking, not re-classified.

## 7. P3 Findings

### P3-1 — `positions` and `ledger` arrays are unbounded

`src/db/index.ts`: unlike `execution_telemetry` (capped at
`MAX_EXECUTION_TELEMETRY_ROWS = 5_000`) and `tx_journal` (terminal rows
trimmed past `MAX_TX_JOURNAL_ROWS = 2_000`), `store.positions` and
`store.ledger` have no cap and are never pruned. Over a long operating
lifetime this grows the JSON file (and thus the cost of every synchronous
`persist()` call, per P1-1) without bound. Not urgent at realistic trade
volumes over months, but compounds P1-1's blocking-write cost over the
bot's lifetime. Recommend an archival/rotation strategy (e.g. move closed
positions older than N days to a separate file) once volume warrants it.

### P3-2 — Retry amplification between transport-level and call-site-level retries

`src/chain/clients.ts`'s `http(..., { retryCount: 1, retryDelay: 500 })`
(viem transport layer) stacks underneath `src/chain/retry.ts`'s
`withRetries` (default `times: 3`, used at various higher-level call
sites) — bounded (worst case ~6x actual network attempts for one logical
operation) but not a single coherent policy, making true worst-case
latency under sustained flakiness harder to reason about than intended.
Not a hang (both layers are finitely bounded) and not new — the two files
are independently well-designed — just worth consolidating for
predictability.

### P3-3 — Global bot error handler only logs to console

`src/bot/bot.ts:3837`, `bot.catch((err) => { console.error(...) })`. This
correctly prevents one handler's uncaught error from crashing grammy's
polling loop (a real and valuable safety net), but the *only* record of
such an error is stdout — no persisted log file, no operator Telegram
alert. If stdout isn't being captured/monitored by whatever process
supervisor eventually runs this in production (none is configured in this
repo — §3), an error that escapes every handler's own local try/catch is
effectively invisible.

### P3-4 — No process-wide `uncaughtException`/`unhandledRejection` handler

`src/index.ts` has no `process.on('uncaughtException', ...)` or
`process.on('unhandledRejection', ...)`. Current exposure is narrow —
every background loop found this phase (`tpslWatcher`'s `tick`,
`volumeAlertWatcher`'s `tick`, `journalledSend`'s error path) already
wraps its own async work in `try/catch`, and Telegram handler errors are
caught by `bot.catch` (P3-3) — but this is defense-in-depth against
anything in the ~85% of the codebase not read line-by-line this phase
(§3) that might not follow the same discipline. A global handler that at
minimum logs with full context (and ideally alerts the operator) before
any `process.exit()` closes this gap cheaply.

## 8. Infinite Loop / Hang Audit

| Loop | File | Bound | Verdict |
|---|---|---|---|
| `computeSingleSidedRange`'s `tickLower`/`tickUpper` search | `chain/ticks.ts` | Finite-number guard added Phase 4.5.2 (uncommitted, present in working tree) | Fixed — re-verified present, not re-broken |
| `mostSignificantBit`/`leastSignificantBit` bit-shift | `chain/tickBitmap.ts` | Bounded by construction (≤256 shifts of a checked ≤ UINT256_MAX value), with explicit `x <= 0n` guard | Safe |
| Relay bridge status poll | `chain/relay.ts:536` | `while (Date.now() - start < timeoutMs)`, default 180_000ms | Safe — wall-clock bounded |
| Across bridge status poll | `chain/across.ts:360` | Same pattern, same default | Safe — wall-clock bounded |
| Receipt poll (`waitForReceiptBounded`) | `chain/txRecovery.ts:99` | `attempts` (default 6), hard cap | Safe |
| Nonce-consumed poll (`resolveAmbiguousTx`) | `chain/txRecovery.ts:190` | `nonceAttempts` (default 5), hard cap | Safe |
| `withRetries` | `chain/retry.ts:22` | `times` (default 3), hard cap | Safe |
| `gmgn-cli` child process | `gmgn/cli.ts:111` | `setTimeout` → `SIGTERM` only | **Not fully safe — see P2-1** (no SIGKILL escalation if SIGTERM is ignored) |
| TP/SL watcher tick | `bot/tpslWatcher.ts:195` | `setInterval` (30s) + reentrancy guard (`running` flag) | Safe — cannot overlap itself |
| Volume alert watcher tick | `bot/volumeAlertWatcher.ts:105` | Same pattern | Safe |
| `journalledSend` pre-send recovery | `chain/clients.ts:134` | Bounded per-entry, but sequential across entries | **Not a hang, but see P2-2** (cumulative latency) |

No new unbounded loop was found. The one prior known hang
(`computeSingleSidedRange`, BUG-001) remains fixed in the working tree.

## 9. RPC Reliability Audit

- **Timeout**: `RPC_TIMEOUT_MS = 12_000` at the transport level
  (`chain/clients.ts:70`) — present, bounded, applied to both public and
  wallet clients uniformly.
- **Retry**: transport-level `retryCount: 1, retryDelay: 500`; see P3-2 for
  the amplification-with-call-site-retries note.
- **429 / rate-limit handling**: not specifically special-cased at the
  viem-transport layer (a 429 is just another retryable HTTP failure to
  viem's own retry logic) — no dedicated backoff-on-429 path was found for
  raw chain RPC (as distinct from `gmgn-cli`, which *does* have explicit
  429 detection — `looksRateLimited()`, `GmgnRateLimitError` with a parsed
  `resetAt`). This is a minor asymmetry, not a defect: the RPC providers
  configured (1rpc.io, mainnet.base.org, and whatever `RPC_4663` resolves
  to) are not documented as aggressively rate-limiting in normal use, and
  the existing timeout+retry+journal-refusal chain already fails closed
  on any RPC failure class equally.
- **Distinguishing failed reads from legitimate empty/zero results**: this
  is where the codebase is strongest, and was the specific subject of
  Phase 4.5.2's BUG-001 fix. Confirmed again this phase:
  `resolveAmbiguousTx`'s nonce-check path (`chain/txRecovery.ts:122`)
  explicitly returns `'UNKNOWN'` (never `'NOT_CONSUMED'`) on an RPC
  exception, and a `notConsumedStreak` counter is reset (not just paused)
  on any `UNKNOWN` read specifically so a single flaky "not yet visible"
  response can never race its way into a false "safe to retry"
  conclusion. `pollReceiptOnce` (line 81) treats a receipt-lookup
  exception as `'PENDING'`, never as `'MINED_REVERT'`. `tpslWatcher.ts`'s
  `measurePnl` returns a distinct `'unknown'` status (never `'gone'`) on
  any RPC/price/compute exception, and every caller of it is required to
  treat `'unknown'` as no-action. This pattern — "a read failure is a
  distinct third state, never coerced to either a real value or absence"
  — was checked at every location this phase touched and held everywhere.
- **Can a temporary RPC failure freeze the bot?** No new case found (see
  §8) beyond the already-bounded-but-slow P2-2 case.
- **Can it permanently disable discovery / incorrectly zero out
  positions/balance / falsely mark a position closed / trigger a
  stop-loss / trigger a transaction?** No — every read path audited this
  phase fails to an explicit "unknown"/error state rather than a
  zero/empty/gone value that could feed a trading decision. (Phase 4.5.2
  already independently confirmed the pool-discovery side of this for
  MULTI; this phase's own reading of `tpslWatcher.ts` and `txRecovery.ts`
  confirms the same discipline in the TP/SL and tx-recovery paths, which
  weren't this phase's mandated re-check but were read anyway per §3.)

## 10. Retry / Backoff Audit

Covered above (§6 P2-2, §7 P3-2) and in §8's table. Summary: every
individual retry mechanism found is finitely bounded with backoff. The
two findings are about *composition* (multiple bounded layers stacking
into a larger, harder-to-predict bound) and *concurrency* (sequential
where parallel would be both safe and clearly better), not about any
single unbounded retry. No retry-inside-retry was found that multiplies
without a cap; no evidence of a retry occurring after shutdown was
initiated (though see P2-3 for a related shutdown-completeness gap); no
retry can duplicate a transaction — that is precisely what
`isNoRetryMarked`/`markNoRetry` (`chain/retry.ts`, `chain/txRecovery.ts`)
exist to prevent, checked *before* any caller-supplied `shouldRetry`, and
this phase traced that veto path end to end and found no gap in it.

## 11. Concurrency / Race Audit

- **Send serialization**: `withTxLock` (per-process, per-(chain,wallet))
  correctly serializes concurrent sends *within one process* — verified
  by reading `txLock.ts` in full; the non-reentrancy caveat documented in
  its own comment is honored everywhere sends originate (all funnel
  through the wrapped `sendTransaction`/`writeContract` at the client
  boundary, per Phase 4.5.2 §15's grep-verified trace, re-confirmed this
  phase for the MULTI path specifically in `multiExecute.ts`).
- **Cross-process**: **not** protected — see P1-2.
- **Watcher reentrancy**: both `tpslWatcher.tick()` and
  `volumeAlertWatcher.tick()` use a simple `running` boolean guard,
  correctly preventing a slow tick from overlapping the next scheduled
  one. `tpslWatcher` additionally uses a `closing` Set keyed by
  `chainId:tokenId` to prevent a double-close of the same position from a
  regular tick and a dedicated 5s recheck firing close together — read in
  full and confirmed correct (checked at both the top of `tick()`'s
  per-position loop and inside `executeClose` itself, with the guard set
  *before* the async close call and cleared in a `finally`).
- **Ledger idempotency**: `recordLedger` dedupes by `(chainId, txHash,
  kind)` before inserting (`db/index.ts:832`) — a concurrent or repeated
  call for the same transaction is a logged no-op, not a duplicate row.
  `recordMultiPositionMeta` is similarly idempotent by `(chainId,
  tokenId)`, append-only, never overwritten.
- **Startup vs. watcher race**: `index.ts`'s ordering — DB init →
  `runStartupTxRecovery()` → `recoverMissingLedger()` → `createBot()` →
  ...→ `startTpslWatcher`/`startVolumeAlertWatcher` → `bot.start()` —
  correctly finishes all recovery before either watcher starts polling or
  the bot accepts commands, exactly as the code's own comments claim.
  Verified by reading the actual sequencing, not just trusting the
  comment.
- **The one real gap**: cross-process (P1-2), not intra-process.

## 12. Process Lifecycle Audit

- **Startup**: sequential, correctly ordered (see §11). No partial-success
  ambiguity found in the audited portion — each stage's own try/catch logs
  and continues rather than leaving an ambiguous half-initialized state
  (e.g. a failed `deleteWebhook`/`setMyCommands` call is logged and
  ignored, appropriately, since neither is safety-critical).
- **Shutdown**: `SIGINT`/`SIGTERM` handlers exist and call
  `stopTpslWatcher()`/`stopVolumeAlertWatcher()`/`bot.stop()`, but (a)
  don't cancel the TP/SL watcher's detached confirm timer (P2-3), and (b)
  never call `process.exit()` after cleanup, relying entirely on natural
  event-loop drain with no forced-exit fallback if something hangs
  (P2-3).
- **No `uncaughtException`/`unhandledRejection` handler** (P3-4).
- **No child-process cleanup concern found** beyond gmgn-cli's own
  per-call lifecycle (P2-1) — no persistent child processes are spawned
  anywhere else in the audited code.
- **Can a failed initialization leave the process appearing healthy?**
  Partially yes, by omission rather than by an active bug: since there is
  no health signal at all (P2-4), *any* degraded-but-alive state looks
  identical to fully-healthy from the outside.

## 13. Memory / Resource Audit

| State | Bounded? | Where |
|---|---|---|
| `execution_telemetry` | Yes (5,000 rows) | `db/index.ts` |
| `tx_journal` (terminal rows) | Yes (2,000 rows; unresolved rows never trimmed, by design) | `db/index.ts` |
| `positions` | **No** | `db/index.ts` — P3-1 |
| `ledger` | **No** | `db/index.ts` — P3-1 |
| `v4_empty_shells` | Grows with genuinely-distinct empty NFTs held; not actively pruned but bounded by real wallet contents | `db/index.ts` |
| `multi_position_meta` | Append-only, bounded by real MULTI position count | `db/index.ts` |
| TP/SL `pending`/`closing` maps | Bounded by concurrently-armed/closing positions (small, self-clearing) | `bot/tpslWatcher.ts` |
| Volume-alert `lastAlerted` map | Actively pruned every tick (entries older than `COOLDOWN_MS * 2`) | `bot/volumeAlertWatcher.ts` — confirmed correct |
| viem client caches (`publicClients`, `walletClients`, `accountCache`) | Bounded by distinct (chainId) / (chainId,walletId) pairs — small, finite in practice (3 chains × N stored wallets) | `chain/clients.ts` |

No unbounded in-memory growth found other than the two already covered
under P3-1 (which is really a disk-file-size and write-latency concern
more than a memory-exhaustion one at any realistic trade volume).

## 14. Database / Accounting Reliability Audit

Traced the crash scenarios requested:

| Scenario | Behavior | Assessment |
|---|---|---|
| A. Crash before tx submission | Nothing broadcast yet; `CREATED`/`SIMULATED`/`GAS_ESTIMATED` are deliberately never persisted (comment in `txRecovery.ts:14`) — caller just restarts from scratch on next attempt | Safe |
| B. Crash after broadcast, before hash returned | Journal entry already `BROADCAST_UNKNOWN` (written *before* the RPC call, `clients.ts:170`) — next boot's `runStartupTxRecovery` resolves it via hash-or-nonce | Safe (assuming the journal file itself survived — see P1-1) |
| C. Crash after confirmation, before `recordLedger()` | This is exactly Phase 3.5's `recoverMissingLedger()` scenario — re-verified this phase by reading `pnl/reconcile.ts` in full: recovers from staged `accounting_meta`, never fabricates a USD value (`MISSING_NO_USD` if `usd` was null at staging), idempotent | Safe |
| D. Crash before journal update (after a successful send return) | `journalledSend`'s `try { updateTxJournalEntry(...) } catch (persistErr) { console.error(...) }` (`clients.ts:187`) explicitly does *not* let a journal-write failure turn a genuine broadcast success into a thrown error the caller might retry — correct, re-verified this phase | Safe |
| E. Crash after journal update, before ledger update | Same as C | Safe |
| F. RPC timeout after tx was actually confirmed | `classifyBroadcastError` treats anything not clearly pre-network as `AMBIGUOUS` (fail-closed default, `txRecovery.ts:61`), triggering `resolveAmbiguousTx`'s hash/nonce-based resolution rather than assuming failure | Safe |
| G. Duplicate recovery execution | `recoverMissingLedger` and `recordLedger` are both idempotent — re-verified this phase (not just trusted from the 4.5.2 report) by reading the actual dedup keys | Safe |
| H. Restart during monitoring | Startup recovery runs *before* watchers start (§11) | Safe |
| I. Database/file write failure | **This is P1-1.** Not safe — no atomic write, no corruption handling on load. |
| J. Partial write | Same as I — P1-1. |
| K. Stale state | `usd: null` at staging → `RECONCILIATION_REQUIRED`, never a fabricated $0 (re-verified, `reconcile.ts:221`); `reconcileAccounting()`'s journal cross-check (line 97) flags a ledger event for a `MINED_REVERT` or still-unresolved tx as a structural finding rather than silently trusting it | Safe |

No duplicate ledger entries, no missing-without-a-flag ledger entries, no
phantom transactions, no `$0` fallback for an unknown USD value, and no
incorrect-fee/principal-attribution path were found in the audited portion
— all consistent with, and re-verifying rather than merely re-citing,
Phase 4.5.2's own §17/§18 findings. The one new structural risk is P1-1/
P1-2, which sit *underneath* this whole state machine rather than within
its logic.

## 15. GMGN Reliability Audit

`src/gmgn/cli.ts` read in full. Confirmed:

- Structured argument array via `cross-spawn`, never a shell string —
  the documented one known `cross-spawn` escaping gap (quote+`&`) is
  closed by the separate `assertSafeCliArg` allowlist applied to every
  argument regardless of spawn mechanism (re-verified by reading the
  regex and its application point, not just trusting the comment).
- Explicit `GmgnErrorCode` enum distinguishes: not-found (`ENOENT`),
  timeout, non-zero exit, empty output, malformed (non-JSON) output,
  rate-limited (with parsed `resetAt`), auth-failed, invalid-input. A
  caller can always tell "GMGN said zero results" apart from "we couldn't
  ask GMGN" — this exact distinction was Phase 4.5.1/4.5.2's own stated
  design goal and holds on this phase's independent re-read.
- `maxBufferBytes` (8MB default) enforced on both stdout and stderr
  independently, with immediate `SIGTERM` + rejection on overflow —
  bounded memory regardless of a runaway or malicious CLI output.
- Timeout bounded (30s default, 60s for the managed-swap path) — **but
  see P2-1** for the missing SIGKILL escalation.
- `GMGN_ALLOW_AUTOMATED_TRADES` gate on the one function
  (`gmgnManagedSwap`) that would let GMGN itself sign and send a trade —
  off by default, requires an explicit opt-in env var.

No new issue beyond P2-1 was found in this module.

## 16. Configuration Audit

Covered in P2-5. Additionally checked: `TELEGRAM_USER_IDS` parsing
(`config.ts:11`) rejects any non-finite entry with a thrown error at
first access (fail-closed, good); chain IDs are a hardcoded literal tuple
(`SUPPORTED_CHAIN_IDS`), not env-driven, so no injection surface there;
`DB_PATH` defaults sensibly and is not otherwise validated (low risk — a
bad path just fails loudly at the first `fs` call, which is acceptable
fail-fast behavior, unlike the address/RPC-URL case in P2-5 where the
failure surfaces much later and less clearly).

## 17. Capital Safety Audit

Traced `data failure → strategy → risk gate → quote → simulation →
execution` for the paths read this phase (MULTI's `executeTradeIntent`/
`runMultiStrategy`, TP/SL's `measurePnl`/`executeClose`, the shared
`journalledSend` broadcast boundary):

- **Stale price accepted as fresh**: not found in the audited paths —
  `getTokenPriceUsd` failures fall back to `?? 1` only for USDG
  specifically (a stablecoin, in `multiExecute.ts:105` and `:150`), which
  is a defensible design choice (USDG's fair value is ~$1 by definition)
  affecting only PnL/USD bookkeeping precision, never a trade-execution
  gate.
- **Unknown price/balance interpreted as zero**: not found — see §9's
  discussion of the "third state" pattern.
- **Failed quote/simulation interpreted as valid**: not found — `mintFn`
  failures in `executeTradeIntent` are caught and converted to
  `{skipped: true, reason: 'SIMULATION_FAILED'}` (`multiExecute.ts:128`),
  re-confirming Phase 4.5.2 §13/§17.
- **Missing pool state interpreted as valid**: `loadLivePoolState`
  (`multiExecute.ts:40`) returns `null` on any exception, and the caller
  rejects the candidate (`'INVALID_PRICE'`) rather than proceeding with a
  guessed tick.
- **RPC failure interpreted as position gone / zero exposure**: not
  found — `tpslWatcher.measurePnl`'s explicit `'unknown'` state (§9)
  directly forecloses this for the TP/SL path; `markZombieClosed`
  (`db/index.ts:1245`) only closes a position when it's confirmed absent
  from a *successfully fetched* `activeTokenIds` set, not on a fetch
  failure (the caller of `markZombieClosed`, not read this phase in full,
  would need to have already failed closed upstream for this to hold end
  to end — flagged as an assumption, not independently re-verified this
  phase, since the caller lives in `bot.ts`'s position-discovery flow
  which was not read in full — see §21).
- **Missing gas data interpreted as zero**: not found —
  `estimateWriteGas` falls back to an explicit, small, pre-reviewed
  constant, never zero or unbounded (re-confirmed by reading `gas.ts` in
  full this phase, not just citing the 4.5.2 report).
- **Unknown ownership interpreted as not-owned**: not independently
  re-verified this phase (lives in `chain/positions.ts`, not read this
  phase — see §21).

No new capital-safety violation found in the paths actually read. The
§21 carve-outs are explicit gaps in this phase's own coverage, not
findings of "safe" — see Test Coverage Gaps for the honest accounting.

## 18. Telegram / Operator Safety Audit

- **Authorization**: every `bot.command(...)` handler found by grep
  (23 commands, full list captured during this audit) begins with
  `if (!(await requireAuth(ctx))) return;` as its first statement, with
  no exception found. `requireAuth`/`isAllowed` (`bot/auth.ts`, read in
  full — 17 lines) checks `ctx.from?.id` against `config.allowedUserIds`
  (a `Set`, O(1) lookup) and replies with an explicit "⛔ Unauthorized"
  message on failure rather than silently ignoring — good for operator
  clarity, though note this itself sends a reply to an *arbitrary*
  Telegram user who messages the bot, which is intended (a private-bot
  design) but worth the operator knowing the bot will always respond to
  strangers with that one line rather than staying fully silent.
- **Global error boundary**: `bot.catch(...)` exists (P3-3 covers its
  console-only logging).
- **Misleading success messages**: not found in the paths read —
  `executeClose` (`tpslWatcher.ts:126`) only sends the "✅ TP/SL closed"
  confirmation *after* `closePosition(...)` has already returned
  successfully and the ledger has been recorded; a thrown error instead
  sends an explicit "❌ TP/SL close failed" message with the real error
  text (truncated to 400 chars) and explicitly says "Watching continues".
- **Duplicate/concurrent command handling**: grammy's default polling
  model processes updates one at a time per default settings used here
  (`allowed_updates: ['message', 'callback_query']`, no explicit
  concurrency config found) — combined with the `closing` Set / `running`
  flags already covered in §11, no duplicate-execution path was found for
  the TP/SL/alert background flows. Command-handler-level double-submit
  (e.g. a user double-tapping an inline "Confirm mint" button before the
  first tap's handler finishes) was **not independently traced** this
  phase — `bot.ts`'s callback-query handlers were not read in full (see
  §21); this is a plausible place for a race the audited files' patterns
  don't automatically rule out.

## 19. Observability Audit

Diagnosability by failure type, based on what was actually read:

| Failure | Diagnosable? | Evidence |
|---|---|---|
| RPC failure | Yes | Logged with context at every catch site read (`console.warn`/`console.error` with the operation name and truncated message) |
| GMGN failure | Yes, well | Typed `GmgnErrorCode` + descriptive, actionable messages (e.g. explicit "configure API key in ~/.config/gmgn/" text) |
| Tx pending / unresolved | Yes | `[tx-recovery]`-prefixed logs at every stage, plus the explicit refusal error naming journal IDs |
| Accounting mismatch | Yes | `formatReconciliationReport` produces an operator-readable summary via `/reconcile` |
| Stale price / unknown state | Yes | TP/SL watcher explicitly logs "state unknown" with the reason |
| Monitoring failure (watcher itself silently dying) | **No** | Nothing pages if a watcher's `tick()` starts throwing every cycle beyond its own console log — no escalation, no health signal (P2-4) |
| Overall system health | **No** | P2-4 |

Sensitive-value exposure: grepped for common secret-adjacent patterns
across the files read this phase — no private key, seed phrase, or API
key is logged anywhere found (`accounting_meta`/ledger/journal rows store
only addresses, amounts, and tx hashes; `gmgn/cli.ts`'s own doc comment
explicitly notes credentials live in `~/.config/gmgn/` and are "never
read or printed", consistent with what the code does). Not exhaustively
re-verified across the ~85% of the codebase not read this phase (§21).

## 20. Health / Readiness Audit

Covered in full at P2-4 and §19. Restated plainly: this system currently
has exactly one liveness signal — the OS process exists — and zero
readiness or trading-safety signals. `PROCESS ALIVE` is observable;
`SYSTEM READY` and `TRADING SAFE` are not, today, distinguishable from it
by anything outside the process itself.

## 21. Test Coverage Gaps

Based on `test/*.test.ts` file names present (`gas`, `gmgnCli`, `ledger`,
`pnl`, `priceFreshness`, `reconcile`, `safety`, `strategy.isolation`,
`strategy.multiCandidates`, `strategy.multiExecute`, `strategy.multiPool`,
`strategy.multiRange`, `strategy.multiRisk`, `swap.decimals`, `tickBitmap`,
`ticks`, `tpsl`, `txLock`, `txRecovery`, `withdrawalAccounting`, plus one
`integration/quote.rpc` test) and this phase's own reading:

**Covered** (per Phase 4.5.2's own report, re-confirmed by this phase's
independent reading of the corresponding source, not merely trusted):
RPC-error-vs-empty distinction in tx recovery, retry exhaustion → no-retry
marking, malformed GMGN JSON/timeout/process-failure classification,
duplicate-transaction-attempt prevention (via the no-retry marker),
crash-recovery reconstruction, `usd: null` → `RECONCILIATION_REQUIRED`
(never a fabricated value), stale/unknown price handling in TP/SL,
gas-estimation failure/fallback, infinite-loop protection for
`computeSingleSidedRange` (new this cycle).

**Not covered, and now identified as gaps by this phase's findings**:

- Corrupted/truncated `data/bot.json` on load (P1-1) — no test exists for
  `load()`'s behavior on invalid JSON, because today there is no
  "correct" behavior defined for it to test (it just throws uncaught into
  `main()`'s top-level catch).
- Two-instance / cross-process contention (P1-2) — no lock mechanism
  exists yet, so nothing to test.
- `gmgn-cli` child ignoring SIGTERM (P2-1) — the existing `runner`
  injection point makes this straightforward to add once a fix exists.
- Multiple simultaneous unresolved journal entries' cumulative latency on
  a new send (P2-2) — `txRecovery.test.ts`/`txLock.test.ts` were not read
  in full this phase to confirm whether a multi-entry timing scenario is
  covered; named here as a gap to verify, not asserted as definitely
  absent.
- Shutdown mid-confirm-timer for TP/SL (P2-3).
- Callback-query (inline button) double-tap / concurrent-command handling
  in `bot.ts` (§18) — not traced this phase.
- `chain/positions.ts`'s ownership/emptiness determination on an RPC
  failure (§17's carve-out) — not independently re-verified this phase.

**Honest scope statement**: `src/bot/bot.ts` (~3,850 lines) was read via
targeted grep and ~50-line windows around specific patterns
(authorization, error boundary, close-flow entry point), not in full.
`src/chain/{mint,close,swap,pools,positions,quote,priceImpact,fees,
tokens,revoke,transfer,wrap,v4,uniswap,safety,tradingApi}.ts`,
`src/gmgn/screener.ts`, `src/strategy/{multiCandidates,multiPool,
multiConfig,multiRisk,index}.ts`, `src/pnl/compute.ts`, and
`src/wallet/keys.ts` were not read this phase at all. This phase's
findings should be read as "what a thorough pass over the explicitly
prioritized reliability surfaces (§4-§13 of the task) found," not as "a
line-by-line audit of 100% of the repository." The persistence-layer
findings (P1-1, P1-2) are high-confidence because `db/index.ts` was read
in full; findings about files read only partially or not at all are
appropriately hedged above rather than asserted as clean.

## 22. Adversarial Failure Matrix

| Failure | Current behavior | Safe? | Severity |
|---|---|---|---|
| RPC timeout | 12s transport timeout, 1 retry, then surfaces to caller; broadcast-specific failures go through `classifyBroadcastError`/`resolveAmbiguousTx` | Yes | — |
| RPC 429 | Treated as a generic retryable transport failure (chain RPC); explicitly detected with parsed reset time for `gmgn-cli` | Yes | — |
| DNS failure | Would surface as a transport connection error, handled the same as any other RPC failure (fail-closed); the existing chain-4663 case (Phase 4.5.2 §20) is exactly this, already root-caused and documented as an environment issue, not a code gap | Yes | — |
| GMGN timeout | Classified `GMGN_CLI_TIMEOUT`, actionable message | Mostly — see P2-1 for the SIGKILL gap | P2 |
| GMGN malformed JSON | Classified `GMGN_CLI_MALFORMED_OUTPUT`, raw output echoed (truncated) for debugging | Yes | — |
| Quote failure | N/A on MULTI's mint-only path (Phase 4.5.2 §11); on the swap path (`chain/swap.ts`, not read this phase) not independently re-verified | Assumed yes, not re-checked | — |
| Simulation failure | Caught, converted to `SIMULATION_FAILED`, zero accounting side-effects | Yes | — |
| Gas estimation failure | Retries once, then bounded pre-reviewed fallback constant, never unlimited | Yes | — |
| Stale price | USDG fallback to $1 for bookkeeping only, never gates execution; other prices' staleness handling not exhaustively re-checked outside TP/SL path | Mostly yes | — |
| Unknown price | Explicit `'unknown'` state in TP/SL path, never coerced to zero/gone | Yes | — |
| Transaction timeout (broadcast ambiguous) | `AMBIGUOUS` classification → bounded hash/nonce resolution → `RECOVERY_REQUIRED`/no-retry-marked on failure to resolve | Yes | — |
| Transaction confirmed after timeout | Hash-first resolution in `resolveAmbiguousTx` catches this — resolves to `CONFIRMED`, not treated as failed | Yes | — |
| Process crash (general) | Journal + ledger-recovery designed for this and logically correct | Yes, **contingent on the store file itself surviving the crash intact** | See P1-1 |
| Database/file write failure | Non-atomic write, no corruption handling on load | **No** | **P1** |
| Concurrent execution (same process) | `withTxLock` + `running`/`closing` guards | Yes | — |
| Concurrent execution (two processes) | No lock; last-write-wins; cross-process nonce race possible | **No** | **P1** |
| Telegram duplicate command | Per-update sequential processing observed; inline-button double-tap not traced | Likely yes, not fully verified | — (see §21) |
| Monitoring task crash | Each tick's own try/catch prevents a full watcher death from one bad tick; a *systemic* failure (e.g. GMGN permanently down) degrades silently with no external alert | Degrades safely, but invisibly | P2 (P2-4) |
| Infinite loop | None found; the one known prior case (ticks.ts) is fixed in the working tree | Yes | — |

## 23. Recommended Fix Priority

1. **P1-1** — atomic write (temp file + rename) + corrupted-load handling
   for `db/index.ts`. Small, isolated, high-leverage: this one change
   removes the single biggest gap between "the recovery logic is correct"
   and "the recovery logic's own data survives the crashes it exists to
   handle."
2. **P1-2** — a startup lock file. Similarly small and isolated.
3. **P2-1** — SIGKILL escalation after SIGTERM in `gmgn/cli.ts`. A few
   lines.
4. **P2-2** — parallelize `journalledSend`'s pre-send recovery loop.
   Moderate — touches the hot broadcast path, needs care but is
   well-contained.
5. **P2-4** — a minimal liveness/staleness signal. Doesn't need to be
   elaborate to close most of the blind spot.
6. **P2-3, P2-5, P2-6, P3-1..4** — lower urgency, each independently
   small.

None of these require a design change to the transaction/journal/ledger
model itself — that model is sound. They are hardening work around its
edges (persistence durability, process supervision, subprocess
lifecycle, and observability), which is a materially smaller and lower-
risk body of work than what Phases 1-4.5.2 already completed.

## 24. Production Readiness Verdict

**NOT READY**

Per this phase's own verdict rubric ("NOT READY: any P1 affecting
trading/accounting/reliability... unresolved accounting corruption [risk]
... failure mode can convert infrastructure/data failure into an unsafe
[operational] state"), the two P1 findings — both squarely about the
durability and single-ownership of the accounting/journal store that
every other safety mechanism in this codebase is built on top of — meet
that bar, even though neither is a currently-live, already-corrupting
bug and neither was triggered in normal single-instance, no-crash
operation. Per the instruction to be conservative, this phase is not
rounding either one down to P2 to reach a nicer verdict.

This should be read alongside, not instead of, the substance of the
findings: Phases 1-4.5.2's core execution, risk-gating, and recovery
*logic* is unusually well fail-closed and was re-verified rather than
merely re-cited wherever this phase's own reading reached it. Both P1s
here are narrow, well-understood, independently fixable in isolation
(atomic file write; a lock file), and do not require touching that core
logic at all. This is a "close two specific, well-scoped gaps before
going live with real capital" verdict, not a "the system's trading logic
is unsound" verdict.

```
$ git status --short
 M PHASE4_5_VALIDATION_REPORT.md
 M src/chain/ticks.ts
 M src/db/index.ts
 M src/pnl/reconcile.ts
 M src/strategy/multiExecute.ts
 M test/reconcile.test.ts
 M test/strategy.multiRange.test.ts
?? PHASE4_5_2_VALIDATION_REPORT.md
?? PHASE4_6_RELIABILITY_AUDIT.md
?? test/ticks.test.ts
```

Identical to §2 except for the addition of this report itself
(`PHASE4_6_RELIABILITY_AUDIT.md`, untracked, newly created). No source,
test, config, or lockfile was modified, staged, committed, reverted, or
reset by this phase. No dependency was added or upgraded. No branch was
changed. Nothing was pushed.

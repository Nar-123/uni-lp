# PHASE 4.6.8 MEMORY & DATA GROWTH FIX REPORT

## 1. Original P3 Findings

From the Phase 4.6 Reliability Audit: unbounded positions/ledger arrays,
potentially unbounded historical data, long-running process memory
growth, and persistent JSON data growth.

## 2. Repository Data-Structure Inventory

Every true module-level singleton `Map`/`Set`/growing array in `src/`
(found via `grep -rn "^const .* = new (Map|Set)"` and `^let .*\[\] = \[\]`
at column 0 — i.e. genuinely persistent for the process lifetime, not a
function-local temporary):

| Location | Structure | Keyed by |
|---|---|---|
| `bot/session.ts` | `sessions: Map` | Telegram `userId` |
| `bot/tpslWatcher.ts` | `pending`, `closing`, `confirmTimers: Map`, `inFlightCloses: Set` | position key (`chainId:tokenId`) |
| `bot/volumeAlertWatcher.ts` | `lastAlerted: Map` | `userId:chainId:address` |
| `chain/clients.ts` | `publicClients`, `walletClients`, `accountCache: Map` | chainId / wallet id |
| `chain/pools.ts`, `chain/prices.ts`, `chain/swap.ts` | `CORE_SYMBOLS`/`STABLE_SYMBOLS: Set` | static constants, never mutated |
| `chain/tokens.ts` | `metaCache`, `supplyCache: Map` | `chainId:tokenAddress` |
| `chain/txLock.ts` | `queues: Map` | `chainId:walletId` (same key space as `walletClients`) |
| `price/dexscreener.ts` | `priceCache: Map` | `chainId:token` |
| `strategy/multiRisk.ts` | `cooldownMap: Map` | `chainId:tokenAddress` |
| `health.ts` | `readinessNotes: string[]` | n/a (fully reassigned each update) |

Persistent (on-disk JSON) arrays, from `db/index.ts`'s `Store` type:
`positions`, `ledger`, `tx_journal`, `execution_telemetry`,
`multi_position_meta`.

## 3. Data Classification

| Structure | Class | Reasoning |
|---|---|---|
| `db/index.ts: ledger` | **A. Financial/recovery-critical** | The accounting ledger — PnL, reconciliation, audit trail. Read throughout `pnl/compute.ts`, `pnl/reconcile.ts`. |
| `db/index.ts: tx_journal` (unresolved rows) | **A** | Read by `runStartupTxRecovery`/reconciliation to recover from a crash mid-broadcast. |
| `db/index.ts: positions` | **A** | Open positions drive risk gates/TP-SL/PnL; closed positions are historical accounting records. |
| `db/index.ts: multi_position_meta` | **A** | Feeds `checkPositionLimits`'s exposure-USD accounting; append-only, deduped by (chainId, tokenId). |
| `db/index.ts: tx_journal` (terminal rows) | **B. Operational history** | Already safely bounded (see §6). |
| `db/index.ts: execution_telemetry` | **B** | Slippage/gas/route observability, not the accounting source of truth; already bounded (see §6). |
| `db/index.ts: v4_empty_shells` | **B**, naturally bounded | One entry per real on-chain empty-shell NFT the wallet has ever held — bounded by actual wallet history, not by polling frequency. |
| `bot/tpslWatcher.ts`: `pending`/`closing`/`confirmTimers`/`inFlightCloses` | **D. Temporary/in-flight state** | Verified cleaned on every path (success/failure/timeout/shutdown) — see §9. |
| `strategy/multiRisk.ts: cooldownMap` | **C. Ephemeral cache** — **FIXED** | Explicitly documented in-source as "in-memory only, a process restart resets cooldowns... acceptable." Unbounded key growth (§5). |
| `chain/tokens.ts: metaCache` | **C** — **FIXED** | Token metadata is immutable once fetched; unbounded key growth (§5). |
| `chain/tokens.ts: supplyCache` | **C** — **FIXED** | Has a TTL but no eviction; unbounded key growth (§5). |
| `bot/volumeAlertWatcher.ts: lastAlerted` | **C**, already fixed pre-existing | Already actively pruned every tick (`pruneCooldowns`). No change needed. |
| `price/dexscreener.ts: priceCache` | **C**, flagged not fixed | Same unbounded-key pattern as the two fixed caches — see §7 for why this phase does not touch it. |
| `bot/session.ts: sessions` | **E. Static/naturally bounded** | Every handler gates on `requireAuth` before `getSession` — size is capped at `config.allowedUserIds.size`, a small fixed admin-configured set, verified by inspection (§9). |
| `chain/clients.ts`, `chain/txLock.ts` Maps | **E** | Keyed by `(chainId, walletId)` — a small, fixed, config/user-driven set. |
| Static `Set` constants (`CORE_SYMBOLS` etc.) | **E** | Never mutated after module init. |
| `health.ts: readinessNotes` | **E** | Fully reassigned (`=`), never appended. |

## 4. Root Causes

`cooldownMap`, `metaCache`, and `supplyCache` all follow the same
anti-pattern: a `Map.set(key, ...)` on every cache miss, with **no**
corresponding removal path. `metaCache` had no staleness concept at all
(reasonably — the values are immutable); `supplyCache` had a
staleness/TTL check on *read* (`Date.now() - hit.at < SUPPLY_CACHE_MS`)
but nothing ever purged an entry once it aged out if that key was never
looked up again; `cooldownMap` had neither. Since all three are keyed by
token address, and this bot's core function (MULTI strategy + manual
mint flow) is continuously discovering and pricing **new, distinct**
meme-token addresses, each Map's key count grows monotonically with
lifetime-distinct-tokens-seen rather than with anything currently
relevant — unbounded growth over a multi-week runtime.

## 5. Memory Growth Fixed

1. **`strategy/multiRisk.ts: cooldownMap`** — added `pruneCooldownMap(maxAgeMs)`,
   called at the top of `checkEntryCooldown` (the function that already
   receives `config.entryCooldownMs`). Removes every entry whose cooldown
   window has already elapsed. An elapsed entry can never again affect
   the pass/fail result (`Date.now() - last < config.entryCooldownMs` is
   already false for it), so this is a pure memory bound with zero
   observable behavior change.

2. **`chain/tokens.ts: metaCache`** — added `setMetaCacheBounded()`,
   a size cap (`MAX_META_CACHE_SIZE = 500`) with FIFO eviction via
   `Map`'s insertion-order iteration (`metaCache.keys().next().value`).
   Chosen over a TTL because the cached value (symbol/name/decimals)
   never goes stale — an evicted key just costs one extra on-chain read
   on next lookup and re-caches the identical value.

3. **`chain/tokens.ts: supplyCache`** — added `pruneSupplyCache()`,
   called before every write, removing every entry already past the
   existing `SUPPLY_CACHE_MS` TTL. Mirrors #1 exactly (an expired entry
   is already unusable per the existing read-side staleness check).

All three mirror the prune-on-write idiom already established and
working correctly in `bot/volumeAlertWatcher.ts`'s `pruneCooldowns` —
no new pattern was invented.

## 6. Persistent Growth Findings

`db/index.ts`'s `pruneTxJournal()` (pre-existing, not modified this
phase) already bounds `tx_journal` at `MAX_TX_JOURNAL_ROWS = 2_000` by
trimming the oldest **terminal** rows only — it explicitly never drops
an unresolved row, verified by reading the function body. Likewise
`recordExecutionTelemetry()` already bounds `execution_telemetry` at
`MAX_EXECUTION_TELEMETRY_ROWS = 5_000` via `rows.splice(...)`, safe
because this table is observability data, not the accounting source of
truth. Both were already implemented correctly before this phase and
required no changes.

`ledger`, `positions`, and `multi_position_meta` have **no** row limit
and **none was added this phase** — see §7.

## 7. Data Retention Decisions

- **`db/index.ts: ledger`** — **MUST RETAIN, unbounded by design.**
  Every row is a distinct financial event (deposit/withdrawal/fee-claim)
  read by `pnl/compute.ts` and `pnl/reconcile.ts` for PnL, reconciliation,
  and audit. No archival mechanism was introduced because retention here
  is accounting-critical, and the task explicitly forbids "keep last N"
  truncation without proof that older entries are unneeded — no such
  proof exists (the opposite: `computePositionPnl`/history rendering
  reads across a position's entire ledger history).

- **`db/index.ts: positions`** — **MUST RETAIN, unbounded by design.**
  Closed positions remain in the array (status flips to `'closed'`, the
  row is never removed) — they are historical accounting records, and
  `pnl/compute.ts`'s history view reads closed positions by design.

- **`db/index.ts: multi_position_meta`** — **MUST RETAIN, unbounded by
  design.** Feeds `checkPositionLimits`'s exposure calculation; deduped
  by (chainId, tokenId) so it grows by exactly one row per position ever
  opened via MULTI — a legitimate, bounded-by-real-trading-activity
  historical record, not a leak.

- **`price/dexscreener.ts: priceCache`** — **flagged, not fixed this
  phase.** This module-level cache exhibits the exact same
  unlimited-unique-keys pattern already fixed in `chain/tokens.ts`
  (§5.2/5.3). It was deliberately left untouched because
  `src/price/dexscreener.ts` is explicitly named on this phase's
  ABSOLUTE SCOPE exclusion list ("DexScreener validation boundary") and
  already carries significant uncommitted Phase 4.6.6 changes that must
  be preserved exactly — combining an unrelated memory-growth fix into
  that file this phase risked exactly the kind of scope ambiguity the
  task instructs against ("do NOT combine this phase with another bug
  fix"). Per the task's own guidance ("if safe retention cannot be
  cleanly established within scope, document the finding rather than
  fix it"), this is recorded here for a future, correctly-scoped phase
  rather than fixed now.

## 8. Cache Retention

| Cache | Bound type | Limit | Eviction trigger |
|---|---|---|---|
| `cooldownMap` | TTL | `config.entryCooldownMs` | on every `checkEntryCooldown` call |
| `metaCache` | Max size | 500 entries | on every cache-miss write, FIFO |
| `supplyCache` | TTL | `SUPPLY_CACHE_MS` (60s) | on every cache-miss write |

None of these introduce a network/RPC call to perform cleanup — every
eviction is a pure, local `Map` operation over already-in-memory data,
matching §21's performance constraint.

## 9. Ephemeral-State Cleanup

`bot/tpslWatcher.ts`'s `pending`/`closing`/`confirmTimers`/
`inFlightCloses` were inspected (not modified, per the task's explicit
instruction to leave Phase 4.6.4's work alone absent a demonstrated
regression) and confirmed already correct:
- `executeClose`'s `try { ... } catch { ... } finally { closing.delete(key); pending.delete(key); }`
  runs on both success and failure.
- `confirmTimers.delete(key)` happens when the timer fires; shutdown
  (`stopTpslWatcher`) calls `confirmTimers.clear()`/`pending.clear()`/
  `closing.clear()` (lines 491-492, 508, 556-558 of the file).
- `inFlightCloses.delete(closePromise)` is in a `finally` block (line 427).

No memory-growth regression was found here — no changes were made.

`bot/session.ts`'s `sessions` Map was verified bounded: every handler
that calls `getSession()` is preceded by `if (!(await requireAuth(ctx))) return;`
(spot-checked across the file), and `requireAuth` rejects any `userId`
not in `config.allowedUserIds` — a small, fixed, admin-configured set —
before a session entry can ever be created for it.

## 10. Success/Failure Cleanup

Covered by the tests in §12/§13 (`memoryGrowth.test.ts`): pruning an
expired `cooldownMap`/`supplyCache` entry, and evicting an old
`metaCache` entry, are exercised directly and proven to never change the
observable result for a call that would otherwise have succeeded.
`tpslWatcher.ts`'s existing success/failure/timeout cleanup (§9) was
verified by code inspection rather than re-tested, per the task's
explicit instruction not to touch or re-litigate Phase 4.6.4 without a
demonstrated regression.

## 11. Long-Run Simulation

`test/memoryGrowth.test.ts` — three deterministic simulations, no RSS
measurement (per §11/§20's explicit guidance against relying on process
memory), asserting `Map.size` directly:
- `cooldownMap`: 10,000 distinct expired entries inserted → one
  `checkEntryCooldown` call prunes all 10,000 away (size 0).
- `metaCache`: 10,000 distinct token lookups → size stays at exactly
  `MAX_META_CACHE_SIZE` (500), never grows past it.
- `supplyCache`: 10,000 distinct expired entries plus one fresh entry →
  pruning leaves exactly the 1 fresh entry.

## 12. Duplicate-State Test

`'cooldownMap: duplicate-state — repeatedly entering the SAME token never grows the map beyond one entry for it'`:
`recordEntryCooldown` called 500 times for the identical
`(chainId, tokenAddress)` → map size stays at 1 (overwritten, never
appended) — confirms no "poll cycle" style duplication is possible for
this structure, satisfying task §12 for the one structure in this
phase's fix set where duplicate-call growth was a plausible risk.
(`metaCache`/`supplyCache` are read-check-then-write per distinct key,
not per-poll — the equivalent check is `'metaCache: re-caching an
already-cached key does not consume a slot / trigger eviction'`.)

## 13. Cache Stress Test

Covered by §11's long-run simulations (10,000 unique keys per cache) —
`metaCache`'s FIFO-eviction order was additionally verified precisely:
`'metaCache: FIFO eviction drops the oldest key first, never a
recently-added one'` fills the cache to exactly its bound, adds one
more, and asserts the very first key is gone while the newest and
second-oldest both survive.

## 14. Restart Regression

All three fixed structures are explicitly in-memory-only (verified by
reading the existing source comments — `cooldownMap`'s own pre-existing
docstring already states "a process restart resets cooldowns, which is
acceptable"; `metaCache`/`supplyCache` are pure RPC-result caches with no
persistence). None of them are read from or written to disk, so a
restart already fully resets them regardless of this phase's changes —
there is nothing for a restart-regression test to exercise here that
differs before/after. Restart recovery for the actual persistent stores
(`positions`/`ledger`/`tx_journal`) is unaffected because none of those
files were modified this phase (see §22 diff scope).

## 15. Accounting Regression

Full test suite (§20) includes every pre-existing accounting/recovery
test (`test/reconcile.test.ts`, `test/txRecovery*.test.ts`,
`test/strategy.multiExecute.test.ts`, `test/strategy.multiRisk.test.ts`,
persistence tests) — all pass unmodified. No accounting formula, ledger
row shape, or journal semantic was touched (confirmed by the diff in
§22 touching only `chain/tokens.ts` and `strategy/multiRisk.ts`, neither
of which contains ledger/journal logic).

## 16. Recovery Regression

`chain/txRecovery.ts` and `db/index.ts` (the recovery/journal
implementation) are absent from this phase's diff entirely — zero lines
changed, verified in §22. `test/txRecoveryLatency.test.ts` and the
recovery-related suites in the full run (§20) all still pass.

## 17. Performance Impact

No RPC, GMGN, blockchain, or database/network call was added anywhere.
Every new operation (`pruneCooldownMap`, `setMetaCacheBounded`,
`pruneSupplyCache`) is a synchronous, local `Map` iteration/mutation
bounded by the map's own (now-capped) size — O(map.size), and map.size
is self-limiting by construction, so this never grows into an expensive
scan. None of these run on a fixed timer of their own; they piggyback on
calls that already happen (`checkEntryCooldown` is already called once
per MULTI risk-gate run; `getTokenTotalSupply`'s cache-miss path already
performs one RPC call, to which one more small `Map` iteration was added).

## 18. Trading Logic Audit

Explicitly verified unchanged (all covered by the passing pre-existing
test suites, none of which were modified): candidate discovery/filtering,
Top 10, pool discovery, scoring formula, fee tiers, range calculation,
single-sided behavior, quote logic, slippage/minOut, simulation, gas,
execution, TP/SL, position limits, exposure limits. `checkEntryCooldown`'s
pass/fail *result* is provably identical before and after this phase
(§5.1, §10) — only its side effect (Map size) changed.

## 19. Strategy Parameter Audit

No MULTI strategy parameter file (`strategy/multiConfig.ts`) appears in
this phase's diff. `config.entryCooldownMs` is read, never modified, by
the new `pruneCooldownMap` call. No market-cap/token-age/volume
threshold, Top-N count, fee-tier constant, TVL/volume scoring weight, or
range percentage was touched — confirmed by the diff in §22 touching
only `chain/tokens.ts` and `strategy/multiRisk.ts`.

## 20. Test Results

```
npx tsx --test test/memoryGrowth.test.ts test/strategy.multiRisk.test.ts
tests 34, pass 34, fail 0

npm test
tests 401, pass 401, fail 0
```
(390 pre-existing baseline from Phase 4.5.2 through 4.6.7, all preserved
byte-for-byte, + 11 new this phase.) Confirmed stable across 2
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

`git diff --stat -- src/strategy/multiRisk.ts src/chain/tokens.ts`:
```
 src/chain/tokens.ts       | 69 +++++++++++++++++++++++++++++++++++++++++++++--
 src/strategy/multiRisk.ts | 33 +++++++++++++++++++++++
 2 files changed, 100 insertions(+), 2 deletions(-)
```
`test/memoryGrowth.test.ts` is new/untracked. No other file appears in
this phase's diff. `git status --short` before and after this phase
shows the exact same set of prior-phase (4.5.2 through 4.6.7)
modified/untracked files, with zero additional changes to any of them.
No reset, stash, checkout, or revert was performed.

## 23. Remaining P2/P3 Findings

- **`STRATEGY` env var silent-default-on-unknown-value gap** (Phase
  4.6.6) — still out of scope, lives in `strategy/multiConfig.ts`.
- **`RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry** (Phase 4.6.6) —
  cosmetic, both fail closed.
- **DexScreener unvalidated `as` cast boundary** (flagged in Phase
  4.6.7) — still not fixed; this file's exclusion from this phase's scope
  is discussed above.
- **`price/dexscreener.ts: priceCache` unbounded key growth** (new this
  phase, §7) — same pattern as the two caches fixed here, deliberately
  left for a phase explicitly scoped to touch `dexscreener.ts`.
- **Retry architecture** — not inspected this phase (explicitly out of
  scope).
- **Global exception handling** — not inspected this phase (explicitly
  out of scope).
- **`db/index.ts: ledger`/`positions`/`multi_position_meta` persistent
  file growth** — unbounded by design; archival mechanism not introduced
  because retention is accounting-critical (§7). The underlying JSON
  file (`bot.json`/`DB_PATH`) will grow indefinitely with real trading
  history — this is an accepted, documented trade-off, not an oversight.
- Memory management beyond the caches identified in §2 (event listeners,
  timers, HTTP servers) was inspected (§9, `instanceLock.ts`'s
  `exitHandlerRegistered` guard, `health.ts`'s idempotent `startHealthServer`)
  and found already correct — no new findings there.

## 24. Files Changed

- [src/strategy/multiRisk.ts](src/strategy/multiRisk.ts) — bounded `cooldownMap` (33 insertions)
- [src/chain/tokens.ts](src/chain/tokens.ts) — bounded `metaCache` and `supplyCache` (69 insertions, 2 deletions)
- [test/memoryGrowth.test.ts](test/memoryGrowth.test.ts) — new, 11 focused regression tests
- [PHASE4_6_8_MEMORY_GROWTH_FIX_REPORT.md](PHASE4_6_8_MEMORY_GROWTH_FIX_REPORT.md) — this report

## 25. Verdict

**PASS**

The three genuinely unsafe unbounded-growth structures found in the
inventory (§2) — all explicitly documented, in-memory-only, non-financial
caches — are now bounded (TTL or size, matching each one's existing
semantics) with zero change to any observable result for a still-valid
entry. Every financial/recovery-critical structure (`ledger`,
`positions`, `multi_position_meta`, unresolved `tx_journal` rows) was
left completely untouched, and the codebase's existing terminal-row
bounding for `tx_journal`/`execution_telemetry` was verified correct
without modification. `tpslWatcher.ts`'s ephemeral-state cleanup (Phase
4.6.4) was verified already correct on every success/failure/timeout
path and was not touched. Restart, accounting, and recovery regressions
all pass unchanged. Trading logic and MULTI strategy parameters are
untouched. One related finding (`dexscreener.ts`'s `priceCache`) was
deliberately documented rather than fixed, consistent with the task's
own preference for documenting over risking a scope violation — this is
disclosed plainly rather than silently ignored. 401/401 tests pass,
typecheck and build are clean.

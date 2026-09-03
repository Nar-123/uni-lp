# PHASE 4.6.12 RETRY ARCHITECTURE AUDIT REPORT

## 1. Original Finding

"Retry architecture / retry stacking" — a remaining P3 finding carried
forward since Phase 4.6.8's report: the theoretical risk that
application-level retries, client-level retries, and transport-level
retries could stack multiplicatively, causing RPC overload, timeout
amplification, or unsafe duplicate transaction submission.

## 2. Retry Inventory

An exhaustive repo-wide search (`retry`, `retries`, `attempts`, `backoff`,
`setTimeout`, `setInterval`, `429`, `ECONNRESET`, `ETIMEDOUT`,
`AbortSignal`, `while(true)`, plus manual inspection of every RPC client,
HTTP fetch, and transaction call site) found:

| # | Mechanism | Location | Bound |
|---|---|---|---|
| 1 | `withRetries()` generic wrapper | `src/chain/retry.ts:22` | `times` default 3, linear backoff `backoffMs * i` |
| 2 | viem `http()` transport `retryCount: 1, retryDelay: 500` | `src/chain/clients.ts:255-258, 282-285` | 1 retry per RPC request |
| 3 | `journalledSend` pre-send refusal / no-retry marking | `src/chain/clients.ts` | veto, not itself a retry |
| 4 | Bounded receipt poll | `src/chain/txRecovery.ts` (`RECEIPT_POLL_ATTEMPTS=6`) | 6 × linear 2s backoff (≤30s) |
| 5 | Bounded nonce poll | `src/chain/txRecovery.ts` (`NONCE_CHECK_ATTEMPTS=5`) | 5 × linear 2.5s backoff (≤25s) |
| 6 | Gas-estimate single retry | `src/chain/gas.ts` | exactly 1 retry, 400ms |
| 7 | GMGN managed-order status poll | `src/gmgn/swap.ts` | 3 × 5s (≤15s) |
| 8 | GMGN child-proc SIGTERM→SIGKILL (Phase 4.6.2) | `src/gmgn/cli.ts` | 30s timeout + 2s + 2s |
| 9 | Trading API single re-quote (2 sites) | `src/chain/tradingApi.ts` | 1 extra attempt each, condition-gated |
| 10 | Across bridge fill poll | `src/chain/across.ts` | wall-clock 180s / 3s interval |
| 11 | Relay bridge status poll | `src/chain/relay.ts` | wall-clock 180s / 1.5s interval |
| 12 | TP/SL watcher poll (Phase 4.6.4) | `src/bot/tpslWatcher.ts` | `setInterval` 30s, process-lifetime by design |
| 13 | Volume-alert watcher poll | `src/bot/volumeAlertWatcher.ts` | `setInterval` 60s, process-lifetime by design |
| 14 | Instance-lock reclaim loop | `src/instanceLock.ts` (`MAX_RECLAIM_ATTEMPTS=3`) | 3, synchronous, no sleep |
| 15 | Alchemy transfer pagination | `src/chain/v4.ts` | `page < 10`, `AbortSignal.timeout(12_000)` per page |

**No `while(true)`, no unbounded loop, and no recursive retry function
exists anywhere in `src/`.** DexScreener (`src/price/dexscreener.ts`, Phase
4.6.9/4.6.11) has **zero** retry logic of any kind — confirmed by direct
inspection of its 3 `fetch()` call sites.

## 3. Retry Layer Map

| Layer | Operation | Retry? | Max attempts | Backoff | Idempotent? |
|---|---|---|---|---|---|
| Application (`withRetries`) | close-v3/close-v4/swap execution rounds | Yes | 3 (default) | Linear (`backoffMs * i`) | Yes — each round re-fetches live state before acting |
| Application (`waitForReceiptBounded`) | Journal recovery: receipt lookup | Yes | 6 | Linear (2000ms * i) | Yes — pure read |
| Application (`checkNonceConsumed` loop) | Journal recovery: nonce check | Yes | 5 | Linear (2500ms * i) | Yes — pure read |
| Application (`estimateWriteGas`) | Gas estimation | Yes | 2 | Fixed 400ms | Yes — pure read (`eth_estimateGas`) |
| Application (GMGN order-status poll) | Managed swap confirmation | Yes | 3 | Fixed 5000ms | Yes — pure read |
| Client (viem `http()` transport) | Every JSON-RPC call (reads AND `eth_sendRawTransaction`) | Yes | 1 | Fixed 500ms | N/A — transport-level, transparent to caller |
| RPC/provider | — | Not configured/inspected beyond the above; nothing in this codebase adds a provider-level retry layer on top of viem's transport | — | — | — |
| HTTP (DexScreener) | Price/pool fetch | **No** | 1 (no retry) | N/A | N/A |
| HTTP (GMGN CLI, external process) | Candidate/price data, managed swap | **No** (429 is classified into a typed `GmgnRateLimitError` but never consulted/retried by any caller) | 1 | N/A | N/A |
| HTTP (Relay/Across bridge status) | Bridge fill confirmation | Yes (poll, not a request retry) | Wall-clock bound (180s) | Fixed interval | Yes — pure read |
| Transaction submission (`journalledSend`) | `sendTransaction`/`writeContract` | Explicitly vetoed for ambiguous outcomes (`markNoRetry`); NOT vetoed for the pre-send refusal-gate throw or for a confirmed on-chain revert | 1 broadcast per `journalledSend` invocation | N/A | Journal-gated |

## 4. Retry Multiplication Analysis

**Confirmed retry stacking exists, but it is bounded — not unbounded —
in every case found.** The two most-nested paths:

- **close-v4**: outer `withRetries` (3 rounds) × inner
  `roundAttempts` array (up to 3 strategies per round, `sleep(400)`
  between) × `estimateWriteGas`'s own 2 attempts = up to **3 × 3 × 2 = 18**
  gas-estimation RPC calls, each of which the viem transport may itself
  retry once → up to **36** total RPC requests in the worst case (all
  reads except the final successful broadcast attempt per round).
- **close-v3** and both swap paths: outer `withRetries` (3 rounds) ×
  inner fallback/fee-tier loop (typically 2-3 sub-attempts) → a
  comparable, single-digit-times-single-digit multiplier, never more.
- **No layer stacks with itself unboundedly.** Every multiplier in the
  chain (`times`, inner-loop length, gas-estimate's 2 attempts, transport
  `retryCount: 1`) is a small hardcoded constant; the product of small
  bounded numbers is itself bounded. There is no case where one retry
  layer's failure re-triggers an entire OTHER unbounded layer (e.g.,
  nothing re-runs `runStartupTxRecovery` in a loop, nothing re-invokes
  `withRetries` from inside another `withRetries` round).

**Verdict on this section: retry stacking exists and is real, but it is
bounded, computed, and — critically — does not cause unsafe duplicate
*broadcasts* (see §6).** This matches the task's own framing: the
objective is not to eliminate all stacking, only to fix *unsafe*
stacking. None was found.

## 5. Read-Only Retry Analysis

Every read-only retry loop found (receipt polling, nonce polling, gas
estimation, GMGN order-status polling, bridge status polling) is:
bounded by a fixed attempt count or wall-clock deadline; uses linear
(not exponential, not immediate/tight-loop) backoff; and treats an
RPC-level failure during the read as "inconclusive" (`PENDING`/`UNKNOWN`)
rather than as a definitive negative result — e.g. `pollReceiptOnce`
catches and returns `'PENDING'` rather than propagating the RPC error,
and `checkNonceConsumed`'s `UNKNOWN` result explicitly **resets** the
"not consumed" streak (verified by the existing test `'nonce recovery:
flaky (UNKNOWN) reads reset the not-consumed streak instead of racing to
a false NOT_SUBMITTED'`) rather than letting transient errors
accidentally count toward a `NOT_SUBMITTED` conclusion. `withRetries`'s
default classification (§ new tests, `test/retry.test.ts`) correctly
treats "no balance"/"not found"/"already empty"/"tokenIn === tokenOut"/
"invalid address" as permanent (1 attempt only) and everything else
(timeouts, connection resets, rate limits) as retryable up to the bound
— this default was previously unverified by any dedicated test; it is
now pinned directly.

## 6. Transaction Submission Analysis

This is the section the task designates most important, and where the
audit focused most effort.

**Finding: no path exists where a transaction-submission timeout or
ambiguous error causes an automatic, blind duplicate broadcast.**
Evidence:
1. Every wallet client is constructed exactly once, in
   `getWalletClient()` (`src/chain/clients.ts`) — a single, unconditional
   reassignment of `sendTransaction`/`writeContract` to route through
   `withTxLock(key, () => journalledSend(...))`. No other
   `createWalletClient` call exists anywhere in `src/` (confirmed by
   grep), so no call site can construct a client that bypasses this
   wrapping.
2. `journalledSend` writes a journal entry (`BROADCAST_UNKNOWN`) *before*
   the RPC call, fetches a fresh nonce, and on any thrown error from the
   underlying `raw()` call classifies it via `classifyBroadcastError`:
   only a narrow, explicit set of clearly-local/pre-network errors
   (`insufficient funds`, `invalid address`, `invalid signature`,
   `invalid params`, `unknown account`, `nonce too low`, etc.) is treated
   as `NOT_SUBMITTED` (safe to retry); everything else — including
   timeouts and connection resets, for which no literal `ECONNRESET`/
   `ETIMEDOUT` string match exists in this codebase — defaults to
   `AMBIGUOUS`, fails closed.
3. An `AMBIGUOUS` classification triggers `resolveAmbiguousTx` (bounded
   receipt/nonce polling, §5) and the *final* outcome — unless it comes
   back as `NOT_SUBMITTED` — is wrapped with `markNoRetry(...)` before
   being thrown. `withRetries`'s `isNoRetryMarked` check is a **hard veto
   checked before any caller-supplied or default `shouldRetry`** (source:
   `retry.ts:45-50`) — confirmed both by the existing test
   (`txRecovery.test.ts`'s item 8) and by a new, more adversarial test
   this phase (`test/retry.test.ts`'s `'the __txNoRetry veto cannot be
   bypassed by shouldRetry=true or a high times'`, which sets
   `shouldRetry: () => true` and `times: 10` and still gets exactly 1
   attempt).
4. The four `withRetries`-wrapped execution paths (close-v3, close-v4,
   swap×2) never re-broadcast the *same* pending/ambiguous transaction —
   each new round re-fetches live on-chain state (liquidity, quotes) and
   constructs a fresh transaction via `journalledSend`, which itself
   fetches a fresh nonce and writes a new journal entry. A round is only
   reachable at all if the *previous* round's `journalledSend` call threw
   something other than a no-retry-marked error — i.e. either a
   pre-broadcast `NOT_SUBMITTED` classification (safe: nothing was ever
   sent) or a **confirmed, definitively-known** on-chain revert.

**One nuance surfaced and explicitly evaluated, not silently accepted:**
a transaction that broadcasts successfully but is later confirmed
*reverted on-chain* (a definite, known outcome via
`waitForTransactionReceipt`, not an ambiguous one) produces a plain,
unmarked `Error` in `close.ts`/`v4.ts`/`swap.ts` (e.g. `` `multicall
reverted ${h}` ``), which the outer `withRetries` **does** retry. This is
not a violation of the CRITICAL SAFETY PRINCIPLE: the principle is
"UNKNOWN result must remain UNKNOWN" and "never blindly retry an
ambiguous submission" — a mined-and-reverted receipt is the opposite of
ambiguous (it is a confirmed, on-chain fact), the reverted transaction
consumed its nonce and had zero economic effect (nothing transferred,
because it reverted), and the next round fetches a **fresh nonce** and
re-validates live state before constructing a genuinely new transaction
— not a resend of the same one. This is the intended, safe "try a
different strategy/fee-tier against current state" pattern the codebase
was built around, not blind duplication. **No production change was made
for this case** because it does not meet the bar of "proven defective" —
it is a deliberate, safe design choice, verified by tracing the actual
code (state is re-fetched every round) rather than assumed.

**A second nuance, lower severity, also evaluated:** `journalledSend`'s
pre-send refusal-gate throw (raised when unresolved prior transactions
already exist for the wallet) is not `markNoRetry`-marked, and its
message does not match the default `shouldRetry` exclusion regex — so a
caller wrapped in `withRetries` will retry this refusal up to `times`
(re-checking the same local, non-network journal state each time before
refusing again). This wastes a few seconds of linear backoff (for
`times: 3, backoffMs: 800`: ~800ms + 1600ms ≈ 2.4s) before the eventual,
still-correct refusal — it never causes a broadcast, never touches the
network, and never changes the outcome. This is a minor, non-safety
inefficiency, not a duplication or fabrication risk, and fixing it would
require modifying `journalledSend`'s error classification — explicitly
"journal semantics" / "transaction recovery semantics" per this phase's
ABSOLUTE SCOPE ("DO NOT modify"). Documented here, not fixed, per the
scope boundary.

## 7. UNKNOWN Result Handling

Verified by the full, unmodified `test/txRecovery.test.ts` suite (still
passing, see §25) plus this phase's own reconfirmation: an ambiguous
broadcast is journaled as `BROADCAST_UNKNOWN`/`SUBMITTED`, is never
converted to `FAILED` by a retry wrapper, remains inspectable via
`listUnresolvedTxJournal`, and is exactly what `runStartupTxRecovery`
processes on the next boot. `withRetries` cannot fabricate a result for
an UNKNOWN outcome — its only two exits are "returns the successful
value" or "throws the last error" (`retry.ts:62`); there is no code path
that converts a caught exception into a synthesized success value.

## 8. Confirmation Retry Analysis

`waitForReceiptBounded`/`checkNonceConsumed` (journal recovery path,
§5) are correctly bounded (≤30s / ≤25s respectively) and were not
touched. Separately noted (not a "retry" in the counted-attempts sense,
and explicitly out of this phase's reach): the 40 direct
`client.waitForTransactionReceipt({ hash })` call sites used inside
execution paths (`close.ts`, `v4.ts`, `swap.ts`, `mint.ts`, etc., all
files this phase's ABSOLUTE SCOPE forbids touching — "execution
strategy") pass no `timeout`/`pollingInterval` option, so a stalled RPC
node could in principle make one of those single confirmation-waits run
very long. This is a single un-retried wait (no counter, no backoff, not
a stacking mechanism), not a retry-architecture defect — it is flagged
in §29 as a related-but-out-of-scope finding rather than fixed.
`stopTpslWatcher`'s 15-second shutdown deadline (Phase 4.6.4, not
modified) only bounds how long shutdown *waits* for an in-flight close;
it does not and was never intended to interrupt the close itself — this
is documented, intentional Phase 4.6.4 behavior, reconfirmed unchanged.

## 9. RPC Retry Analysis

Both viem clients (`getPublicClient`/`getWalletClient`,
`src/chain/clients.ts`) explicitly pass `http(url, { timeout: 12_000,
retryCount: 1, retryDelay: 500 })` — an explicit, intentional override,
not an unstated library default. This single transport-level retry
applies transparently beneath every RPC call including
`eth_sendRawTransaction`, and is *invisible* to `journalledSend` (it
either succeeds after at most one transport-level retry, or the whole
call rejects once). No additional application-level RPC-read retry
wrapper exists beyond the specific, purpose-built ones already
inventoried (§2 items 4-7) — there is no generic "retry every RPC call"
layer stacked on top of the transport's own retry.

## 10. HTTP Retry Analysis

**DexScreener** (`src/price/dexscreener.ts`, hardened in Phase 4.6.9/
4.6.11, not touched this phase): confirmed zero retry logic — a failed
fetch or non-2xx status is a single, immediate failure
(`throw`/`return null`, depending on the function). This is *not* a
stacking problem (0 layers cannot multiply), and per this phase's
explicit instruction ("Do NOT add retry logic... if DexScreener has no
retry and that is acceptable: leave it unchanged"), no change was made.

**GMGN CLI** (`src/gmgn/cli.ts`, hardened in Phase 4.6.2, not touched
this phase): a 429/rate-limit response is classified into a typed
`GmgnRateLimitError` carrying a parsed `resetAt`, but grepping all of
`src/` confirms **no caller anywhere inspects `resetAt` or retries after
catching it** — the error simply propagates to the existing "candidate
source failure, fail closed, no candidates" handling already established
in Phase 4/4.5. Again, zero retry layers here cannot stack; this is a
missing-convenience gap, not a stacking defect, and "GMGN CLI behavior"
is explicitly excluded from this phase's scope regardless.

## 11. Rate Limit Handling

No HTTP 429/`Retry-After` handling exists anywhere in `src/` beyond
GMGN's own classification-without-consumption (§10). `withRetries`'s
default classification treats a 429-shaped error message as *retryable*
(it doesn't match the permanent-error exclusion regex) — verified by
this phase's new tests (`'repeated 429-style errors are bounded, never
an infinite retry loop'`, `'429 then success: recovers within the bound'`)
— so any caller that happens to route a 429 through `withRetries` gets
bounded (≤3 by default), linearly-backed-off retries, never an
unbounded loop and never increasing request pressure faster than the
linear backoff already imposes.

## 12. Backoff Analysis

`withRetries`: linear, `backoffMs * attemptNumber` (not exponential, not
immediate) — confirmed both by source inspection and by new timing-based
tests (`'backoff is linear...'`, asserting the second inter-attempt delay
is measurably longer than the first). `waitForReceiptBounded`/
`checkNonceConsumed`: same linear pattern (`backoffMs * i`). No
dangerous pattern (`while(true)`, immediate tight-loop retry, recursive
retry) was found anywhere (§2).

## 13. Timeout Amplification

Worst-case wall-clock duration is now directly pinned by a new test:
for `times=4, backoffMs=15`, the persistent-failure case takes at least
`15+30+45=90ms` and is asserted to stay well under a generous upper
bound — proving the total duration is a computable, bounded function of
`times`/`backoffMs`, not runaway. Applying the same formula to
production defaults (`times=3, backoffMs=800-1200` across the four
`withRetries` call sites) gives worst-case backoff-only totals in the
2.4-3.6 second range per round, `×3` rounds ≈ 7-11 seconds of pure
backoff for a fully-failing operation — bounded and small relative to
the per-attempt RPC timeout (12s) and gas/receipt-wait time layered on
top. No caller-timeout-vs-inner-retry-timeout conflict was found (no
caller wraps a `withRetries` call in its own competing timeout).

## 14. Cancellation / Shutdown

`withRetries` accepts no `AbortSignal` and performs no shutdown check —
this is consistent with, not a violation of, Phase 4.6.4's explicit,
documented design: an in-flight close is never interrupted once started
(`tpslWatcher.ts`'s own comments state this outright), and
`stopTpslWatcher`'s 15s deadline governs only how long shutdown *waits*
for that work, never whether the work itself is cancelled. No
`AbortController` exists anywhere in `src/`; the sole abort primitive in
the codebase is one `AbortSignal.timeout(12_000)` used for an unrelated,
already-bounded Alchemy pagination call (`chain/v4.ts`). Since Phase
4.6.4 explicitly does not require in-flight closes to be
cancellable — the opposite: it requires them to run to completion — there
is no existing cancellation requirement being violated, so no fix was
warranted per this phase's own §15 instruction ("only fix if a real
retry loop ignores existing cancellation requirements").

`volumeAlertWatcher.ts` has no equivalent in-flight-tracking at all
(only a synchronous re-entrancy boolean) — but its tick performs only
read-only GMGN/DexScreener work with no transaction submission, so an
in-flight tick continuing briefly past a stop request carries no
correctness or duplication risk, only (at most) one extra read cycle.

## 15. Fire-and-Forget Analysis

Searched for `void <retry-like-call>` patterns. The two found
(`tpslWatcher.ts`'s `void tick(bot)` in the `setInterval` callback, and
its confirm-timer's `void recheckAndMaybeClose(...)`) are both
pre-existing, Phase-4.6.4-governed scheduled/one-shot invocations with
their own re-entrancy guards (`running` flag, `confirmTimers` map
tracked and cleared on shutdown) — not unbounded fire-and-forget retries.
No fire-and-forget retry loop that could continue indefinitely after a
caller returns, a transaction fails, shutdown occurs, or a position
closes was found.

## 16. Duplicate Request Tests

New tests in `test/retry.test.ts` directly prove bounded-attempt
behavior for a transient read failure: `'a persistently-failing
operation is attempted exactly times times, never more'` and `'default
times (3) is used when omitted — no hidden unbounded default'` — both
assert the exact call count via a real (non-mocked-provider) invocation
of the actual `withRetries` function, not a simulation of provider
behavior.

## 17. Transaction Duplication Test

`test/retry.test.ts`'s `'the __txNoRetry veto cannot be bypassed by
shouldRetry=true or a high times'` is the write-duplication-prevention
test this phase requires: it simulates exactly "first send → ambiguous/
unknown" (via `markNoRetry`, the same marker `journalledSend` applies in
production) and proves a second send never occurs (`calls === 1`) even
under the most permissive possible retry configuration
(`shouldRetry: () => true, times: 10`). This complements the
pre-existing `txRecovery.test.ts` item 8, which proves the same property
with a single, more modest configuration (`times: 5`).

## 18. Recovery Regression

```
npx tsx --test test/txRecovery.test.ts test/txRecoveryLatency.test.ts
tests 41, pass 41, fail 0
```
All pre-existing recovery tests pass unmodified: UNKNOWN/CONFIRMED/
MINED_REVERT classifications, unresolved-entry recoverability, no
duplicate ledger entries, no duplicate transactions (item 10's
"duplicate prevention" test), and the nonce-recovery
UNKNOWN-resets-the-streak test all remain green.

## 19. GMGN Regression

```
npx tsx --test test/gmgnCli.test.ts
```
All Phase 4.6.2 SIGTERM→grace→SIGKILL timeout tests pass unmodified —
confirmed as part of the combined run in §25. `shell` is not used
anywhere in `src/gmgn/cli.ts` (unchanged), and argument validation was
not touched.

## 20. Price/DexScreener Regression

```
npx tsx --test test/priceCache.growth.test.ts test/dexscreener.boundary.test.ts test/priceFreshness.test.ts
```
All pass unmodified, confirmed as part of the combined full-suite run
(§25) — Phase 4.6.9's cache bounding and Phase 4.6.11's JSON boundary
validation are both untouched.

## 21. Performance Impact

**Zero production code was changed, so request volume for every code
path is byte-for-byte identical to before this phase** — there is
nothing to demonstrate a before/after delta for, because there is no
"after." The new tests add no runtime behavior to the application; they
exercise `withRetries` directly with synthetic always-failing/
always-succeeding functions and mocked receipt/nonce clients, issuing
zero real network or RPC calls.

## 22. Changes Made

**Production retry code unchanged because audit found no demonstrated
defect.** Every genuinely concerning pattern identified during the
inventory (§2-§15) was traced to one of: (a) already-safe-by-design
behavior (the mined-revert retry re-validates state and uses a fresh
nonce, §6), (b) bounded-not-unbounded stacking that does not cause
unsafe duplicate broadcasts (§4), or (c) a real but minor/out-of-scope
gap located in files this phase's ABSOLUTE SCOPE explicitly forbids
modifying (execution-strategy files' unbounded `waitForTransactionReceipt`
calls; `journalledSend`'s refusal-gate retry inefficiency; GMGN's
unconsumed `resetAt`). None of these met the bar of "retry behavior
directly proven defective" that this phase's scope requires before a
production change is permitted. One new test file,
`test/retry.test.ts` (15 tests), was added to directly pin the safety
properties this audit's conclusions rely on — this is test-only,
zero-runtime-behavior-change coverage, exactly matching this phase's
explicit allowance ("Create only ... focused tests only if useful").

## 23. Trading Logic Audit

No file under `src/strategy/*`, no pool-scoring/candidate-filtering
logic, no range/quote/slippage/minOut/simulation/gas/execution/TP-SL/
accounting code was modified. Confirmed by the diff (§28): zero lines
changed in any `src/` file.

## 24. Strategy Parameter Audit

No MULTI parameter, threshold, weight, or fee tier was read, referenced,
or modified.

## 25. Test Results

```
npx tsx --test test/retry.test.ts
tests 15, pass 15, fail 0

npx tsx --test test/retry.test.ts test/txRecovery.test.ts test/txRecoveryLatency.test.ts test/gas.test.ts test/gmgnCli.test.ts
tests 88, pass 88, fail 0

npm test
tests 473, pass 473, fail 0
```
(458 pre-existing baseline from Phase 4.5.2 through 4.6.11, all preserved
byte-for-byte, + 15 new this phase.) Confirmed stable across 2
consecutive full-suite runs.

## 26. Typecheck

```
npm run typecheck
```
Clean.

## 27. Build

```
npm run build
```
Clean.

## 28. Diff Scope Audit

```
git diff --stat -- src/
```
Byte-for-byte identical to the pre-phase baseline captured in §1's
preservation check — **zero lines changed in any `src/` file this
phase.** Only `test/retry.test.ts` is new/untracked. `git status
--short` before and after this phase shows the exact same set of
prior-phase (4.5.2 through 4.6.11) modified/untracked files, with zero
additional changes to any of them. No reset, stash, checkout, or revert
was performed.

## 29. Remaining P2/P3 Findings

- **`RPC_4663`-vs-`USDC_4663` error-surfacing asymmetry** (Phase 4.6.6) —
  cosmetic, both fail closed.
- **Global exception handling** — not inspected this phase (explicitly
  out of scope).
- **`db/index.ts: ledger`/`positions`/`multi_position_meta` persistent
  file growth** (Phase 4.6.8) — unbounded by design, accounting-critical,
  not touched.
- **Retry stacking remains present but bounded** (§4): close-v4's
  worst-case 3×3×2=18 gas-estimate calls (up to 36 RPC requests
  including transport retries) is real, computed, and disclosed here —
  it is not "resolved" in the sense of being reduced, because it was not
  found to be unsafe or unbounded, only "more layers than a from-scratch
  design might choose." No fix is warranted per §27 of the task's own
  instructions ("do not invent a code change merely to claim the phase
  changed something").
- **Unbounded `waitForTransactionReceipt` calls (40 sites)** across
  execution-strategy files (`close.ts`, `v4.ts`, `swap.ts`, `mint.ts`,
  etc.) pass no `timeout`/`pollingInterval` — a real gap, but it is a
  single un-retried wait (not a retry-multiplication mechanism) located
  entirely inside files this phase's ABSOLUTE SCOPE forbids modifying
  ("execution strategy"). Flagged for a future, correctly-scoped phase.
- **`journalledSend`'s pre-send refusal-gate throw is not
  `markNoRetry`-marked** (§6) — a minor, non-unsafe inefficiency (wastes
  ~2.4s of local-only retry before the same correct refusal), located in
  "journal semantics"/"transaction recovery semantics", explicitly out
  of this phase's scope to fix.
- **GMGN's `GmgnRateLimitError.resetAt` is classified but never consumed
  by any caller** (§10) — a missing convenience, not a stacking defect
  (zero retry layers exist here to stack); "GMGN CLI behavior" is
  explicitly out of this phase's scope.
- **`runStartupTxRecovery`'s sequential loop has no aggregate deadline**
  across N unresolved entries (§8) — each entry is individually bounded
  (~25-30s), but total startup-recovery time scales linearly with entry
  count with no overall cap. Located in "transaction recovery semantics",
  explicitly out of this phase's scope.
- No new P2/P3-severity findings were discovered beyond what is listed
  above. **The "retry architecture / retry stacking" finding itself is
  now closed as an audited, bounded, non-defective characteristic** —
  it is not carried forward as an open action item, though the specific
  sub-findings above (all individually low-severity and/or out of this
  phase's file scope) remain documented for future phases.

## 30. Files Changed

- [test/retry.test.ts](test/retry.test.ts) — new, 15 focused tests directly exercising `src/chain/retry.ts`'s `withRetries` (previously untested in isolation)
- [PHASE4_6_12_RETRY_AUDIT_REPORT.md](PHASE4_6_12_RETRY_AUDIT_REPORT.md) — this report

No production (`src/`) file was modified.

## 31. Verdict

**PASS**

No unbounded retry loop exists anywhere in `src/` (confirmed by
exhaustive search — zero `while(true)`, zero recursive retries). Retry
multiplication is bounded in every case found — the worst case
(close-v4's ~18-36 RPC requests) is a computed, finite product of small
hardcoded constants, not runaway growth. Read-only retries correctly
distinguish permanent errors (1 attempt) from transient ones (bounded
retry), now directly pinned by new tests. Transaction submission is
never blindly duplicated: every broadcast path is gated by
`journalledSend`'s journal-before-broadcast + fresh-nonce-per-attempt
architecture, and the `__txNoRetry` veto is absolute and unbypassable
(reconfirmed under an adversarial test configuration). UNKNOWN results
remain UNKNOWN and recoverable via the existing, unmodified journal/
`txRecovery` mechanism. Backoff is linear and bounded; total wall-clock
duration for a persistent failure is a computable, small function of
`times`/`backoffMs`. Shutdown behavior matches Phase 4.6.4's documented,
intentional design (in-flight work completes, is not interrupted) with
no runaway retry surviving shutdown in any newly-introduced sense. All
473 tests pass, typecheck and build are clean, and zero production code
was changed — consistent with an audit that found the retry
architecture already safe.

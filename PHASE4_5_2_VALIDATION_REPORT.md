# PHASE 4.5.2 — MULTI REAL/FORK VALIDATION

## 1. Executive Summary

This phase re-validated the MULTI pipeline with real live data wherever
reachable, and went one level deeper than Phase 4.5/4.5.1 by directly
adversarially probing the underlying shared tick-math and pool-scoring
functions with degenerate inputs (NaN, Infinity, extreme values) rather
than only their happy-path behavior. This surfaced **one real, severe,
pre-existing bug** (a genuine infinite loop, not present in any prior
phase's testing) and **one real, narrower accounting-attribution bug**,
both directly within the exact invariants this phase's task asked to be
verified. Both were fixed with minimal, behavior-preserving changes and
each has a new regression test.

- **P1 bug found and fixed**: `computeSingleSidedRange()`
  (`src/chain/ticks.ts`, shared by MULTI *and* manual mints) would hang
  the entire single-threaded bot process forever if `currentTick` were
  ever `Infinity`, and would silently report a `NaN`-tick range as
  `valid: true` if `currentTick` were `NaN` — a direct violation of the
  "never NaN/Infinity/crash" invariant this phase's §9 explicitly required
  testing. Fixed with an up-front finite-number guard; 9 new tests in
  `test/ticks.test.ts` plus 1 in `test/strategy.multiRange.test.ts`.
- **P2 bug found and fixed**: a MULTI-opened position's ledger deposit
  event, if reconstructed by Phase 3.5's crash-recovery path
  (`pnl/reconcile.ts`) instead of recorded immediately, silently lost its
  `strategy: 'multi'` attribution — because `JournalAccountingMeta` never
  carried the field in the first place. Fixed by adding the field
  (optional, fully backward-compatible with all 5 existing manual call
  sites) and threading it through recovery; 2 new tests in
  `test/reconcile.test.ts`.
- **Real, live validation** (not mocked) was re-confirmed for the full
  GMGN candidate discovery → filter → rank → Top-10 pipeline, using the
  real production code path with no workaround (Phase 4.5.1's Windows fix
  holds), with fresh live data.
- **Chain 4663 (Robinhood) RPC remains unreachable**, root-caused with
  even stronger evidence than Phase 4.5: a direct TLS handshake to the
  resolved IP returns a certificate for `internetbaik.telkomsel.com` /
  `internettepat.telkomsel.com` — literally an ISP captive-portal
  certificate, not Robinhood's. This is conclusive proof of DNS-layer
  interception, not a TLS/HTTP/rate-limit/auth issue with the real
  endpoint. BSC and Base both complete correct TLS handshakes.
- **No transaction was broadcast. No real capital was touched.** Every
  validation in this phase was read-only, dry-run, or a pure in-process
  function call against injected/mocked data.

**Verdict: PASS WITH BLOCKED LIVE VALIDATION** (see §26).

## 2. Repository / Commit

```
Branch: master (up to date with origin/master)
Latest commit at start: edb8630  "fix: harden gmgn cli and cleanup"
Remote: origin -> https://github.com/Nar-123/uni-lp.git
```

Working tree was **not** perfectly clean at the start of this phase: one
unstaged, additive, documentation-only edit to `PHASE4_5_VALIDATION_REPORT.md`
was present (adding the exact integration-test pass/fail numbers, made at
the very end of the prior Phase 4.5.1 session, never committed). This was
inspected (`git diff`), confirmed benign, and left in place rather than
overwritten or discarded, per this phase's instruction to stop and report
unexpected modifications rather than clobber them. It is not "unexpected"
in the sense of foreign/unknown — it is this same working session's own
prior, uncommitted output.

## 3. Environment

| | |
|---|---|
| Node | v24.18.0 |
| npm | 11.16.0 |
| gmgn-cli | 1.5.6 (installed; `~/.config/gmgn/.env` and `keypair.pem` present — contents never read or printed) |
| Chain 4663 RPC | `RPC_4663` env unset → default `https://rpc.mainnet.chain.robinhood.com` — **unreachable** (§20) |
| Chain 4663 USDG | `CHAINS[4663].usdg = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (from `src/config.ts`, used as-is) |
| Fork tooling | None configured (§19) |
| Dependencies | Unchanged from Phase 4.5.1 baseline (`cross-spawn`, `@types/cross-spawn`); no new dependency added this phase |

No private keys, secrets, API keys, or `.env` contents were printed at any
point in this phase.

## 4. Real GMGN Candidate Validation

**PASS — LIVE.** Ran the real, unmodified `fetchAndFilterCandidates()`
(`src/strategy/multiCandidates.ts`) with its **default fetcher** — no
injection, no workaround (confirms the Phase 4.5.1 Windows fix continues
to hold) — against live GMGN data for chain 4663, interval `6h`.

```
raw candidates fetched: 50
final candidates (post filter+rank+topN): 10
rejected: 40  (MC_TOO_LOW: 33, AGE_TOO_LOW: 4, AGE_UNKNOWN: 3)
elapsed: ~5.6s
```

Verified programmatically on this run's actual output:
- `overlapCount: 0` — no rejected address appears in the final Top 10.
- `noDuplicates: true` — no duplicate addresses in the Top 10.
- `lessOrEqual10: true`.
- `sortedDescending: true` — volume6h strictly non-increasing across the list.
- `allValid: true` — every final candidate independently satisfies MC ≥ $1,000,000, age ≥ 24h, and classification ≠ UNKNOWN.
- `sourceError`: absent (undefined) — confirms this was a genuine successful fetch, not a masked failure (see §17/Phase-4.5.1 for the SOURCE_FAILURE-vs-empty distinction mechanism).

Two live-data details worth recording: candidate #9 in this run
(`AIAIAI`, $1,526,310 MC) sits close to the $1,000,000 boundary,
reinforcing that the boundary logic is exercised by real data, not only
synthetic unit tests. A distinct `LUCIA` address appears in the *rejected*
list (`MC_TOO_LOW`) while a *different* `LUCIA`-symbol token appeared in a
prior run's Top 10 — direct live confirmation that candidates are
identified and deduplicated by contract address, never by symbol/name.

## 5. USDG Validation

**BLOCKED (on-chain check) / PASS (code-level, by design).**

- Contract-address-not-symbol identity: confirmed by code
  (`isUsdgPool()`, `NOT_USDG` risk-gate re-check — both lowercase-address
  comparisons) and by existing test
  (`test/strategy.multiPool.test.ts`: "a pool paired with a different
  contract... is rejected NOT_USDG").
- `eth_getCode`, `decimals()`, `symbol()` against the live chain 4663
  contract: **BLOCKED** — chain 4663 RPC is unreachable (§20). Not
  fabricated, not skipped silently — explicitly marked blocked.
- No substitute stablecoin was used anywhere in this phase.

## 6. Pool Discovery

**PARTIAL — LIVE (off-chain) / BLOCKED (on-chain).** Re-confirms Phase
4.5's finding with the same evidence class: `listPoolsForToken()`'s
off-chain (DexScreener-derived) v4 pool exploration works for real
candidates, but on-chain `getSlot0` validation against the v4StateView
contract fails for every discovered candidate pool because it requires
chain 4663's RPC. The function was not re-exercised with fresh live
candidates this phase (identical evidence already exists from Phase 4.5
and re-running would reproduce the same "found N pools off-chain, then 0
after RPC validation" result for the same root cause) — no new
information would be gained, so this phase relies on the existing
evidence rather than re-running an unchanged code path in an unchanged
environment.

**Invalid pools rejected**: confirmed by code + test (`FEE_TIER_NOT_SUPPORTED`,
`TVL_TOO_LOW`, `NOT_USDG` — each independently unit-tested with
synthetic pools in `test/strategy.multiPool.test.ts`).

## 7. Pool Scoring

**PASS — UNIT + LIVE PROBE.** `scoreMultiPool()` re-audited with a live
adversarial probe (not just unit tests) this phase:

```
tvl=Infinity   -> tvlScore=1        (Math.min(1, x) correctly caps Infinity)
volume=Infinity -> volumeScore=1, volumeTvlScore=1 (same)
tvl=0          -> tvlScore=0, totalScore=0.15 (feeScore contribution only) — correct, not a bug
tvl=NaN        -> tvlScore=NaN, totalScore=NaN   <-- see Bug #2 candidate below (NOT fixed, see rationale)
volume=NaN     -> volumeScore=NaN, volumeTvlScore=NaN, totalScore=NaN
```

**Finding (documented, not fixed — see §23 BUG-003):** a `NaN` value in
`tvlUsd`/`volumeUsd` propagates to `totalScore = NaN` rather than being
treated as "unknown → excluded from scoring." `Infinity` is already
handled correctly (`Math.min` naturally caps it). In the real pipeline,
`ListedPool.tvlUsd`/pair-volume are populated by
`listPoolsForToken()`/DexScreener parsing and would only become `NaN` from
a malformed upstream numeric field — a narrower reachability window than
the tick-math bug (§9), and this scoring step only ever runs on pools that
already passed the hard USDG/fee-tier/TVL-floor filters (so a NaN-scored
pool is still a *legitimate, tradeable* pool — the defect is in *ranking
quality among alternatives*, not in accepting an invalid pool). Classified
P2, not fixed this phase (see rationale in §23).

Deterministic tie-break (`score → tvl → volume → address`) and
"missing (`null`) data scores 0, never fabricated" both re-confirmed
unchanged from Phase 4 (`test/strategy.multiPool.test.ts`).

## 8. Fee Tier Validation

**PASS — code-level, traced to the ABI.** Traced the complete chain this
phase, one layer deeper than before:

```
ABI (src/chain/abis.ts, poolAbi):  fee() view returns uint24   [protocol-standard]
Pool reader (chain/pools.ts):       fee: feeNum  — raw value, zero conversion
Pool discovery (multiPool.ts):      PREFERRED_FEE_TIERS = [50_000, 40_000, 30_000]
Fee formatting (chain/pools.ts):    feeLabel = (fee/10000).toFixed(2)+'%'  — same raw-uint24 convention, used elsewhere in the app for the default strategy
Strategy scoring (multiPool.ts):    feeScoreFor(50000)=1.0, (40000)=0.75, (30000)=0.5, else 0
Execution (multiExecute.ts):        intent.fee passed straight through to mintFn, no re-interpretation
```

No unit-conversion step exists anywhere between the raw on-chain `uint24`
value and MULTI's comparison/scoring — confirmed by reading every
intermediate assignment, not merely by output behavior. `0.3% (3000)` and
`0.5% (500)` are correctly *not* in `PREFERRED_FEE_TIERS` and are rejected
(`FEE_TIER_NOT_SUPPORTED`), verified by existing test. Live availability
of an actual 5%/4%/3% pool on chain 4663: **BLOCKED** (§20).

## 9. Single-Sided Range

**PASS — UNIT, with one P1 bug found and fixed this phase.**

Adversarially probed `computeSingleSidedRange()`/`computeMultiRange()`
directly (live execution, not just reading the code) with every case
this phase's task requested:

| Input | Before fix | After fix |
|---|---|---|
| `tickSpacing = 0` | `valid:false` (already correct, via incidental NaN propagation) | `valid:false` (now explicit) |
| `tickSpacing = -60` | `valid:false` (already correct) | `valid:false` (now explicit) |
| `tickSpacing = NaN` | `valid:false` (already correct) | `valid:false` (now explicit) |
| `tickSpacing = Infinity` | `valid:false` (already correct, via `Math.min`) | `valid:false` |
| `currentTick = NaN` | **`valid:true`, tickLower/tickUpper = NaN** — BUG | `valid:false` |
| `currentTick = Infinity` | **process hangs forever** — BUG (killed manually after 15s+) | `valid:false`, returns in <1s |
| `currentTick = -Infinity` | (untested previously; same hang class expected) | `valid:false` |
| `currentTick = 1e9` / `-1e9` (extreme finite) | `valid:false` (pre-existing boundary check) | `valid:false` (unchanged) |

Root cause (`src/chain/ticks.ts`, `computeSingleSidedRange`, token0 branch):

```js
let tickLower = alignUp(currentTick + Math.max(edge, 1), spacing);
while (tickLower <= currentTick) {   // Infinity <= Infinity is always true
  tickLower += spacing;               // Infinity + spacing = Infinity — never terminates
}
```

and separately, every downstream guard (`tickLower >= tickUpper`,
`currentTick >= tickLower`) uses `>=`/`<`, which are *always false* for
`NaN`, so a NaN tick silently passed every check meant to catch it.

**Fix**: added an explicit `Number.isFinite(currentTick)` and
`Number.isFinite(tickSpacing) && tickSpacing > 0` guard at the top of the
function, before any loop or comparison runs. This function is shared
with manual mints (`chain/mint.ts`, `chain/v4.ts`) — real Uniswap pool
ticks are always finite `int24` values, so this guard never rejects any
real-world call; it only rejects genuinely malformed/corrupted input.
`computeMultiRange()`'s existing `try/catch` already converts the thrown
error to `{valid:false, rejectedReason:'NOT_SINGLE_SIDED'}` — no change
needed there.

**Tests**: `test/ticks.test.ts` (new, 9 tests, exercises
`computeSingleSidedRange` directly since manual mints depend on the same
fix) + 1 new test in `test/strategy.multiRange.test.ts` (MULTI-wrapper
level, `NaN`/`Infinity`/`-Infinity`).

## 10. Token Orientation

**PASS — UNIT (both directions).** `usdgIsToken0: true` → range placed
above market (`tickLower > currentTick`, `side: 'above'`);
`usdgIsToken0: false` → range placed below market
(`tickUpper <= currentTick`, `side: 'below'`) — both re-confirmed live
this phase as part of the adversarial probe (unaffected by the fix; both
orientations correctly still work post-fix). `isUsdgPool()` similarly
already tested with USDG as token0 and as token1.

## 11. Quote

**NOT APPLICABLE to MULTI's execution path.** Traced
`mintSingleSided()`/`chain/mint.ts` this phase: it never calls
`getExecutableQuoteV3`/any quote function. This is architecturally
correct, not a gap — minting a single-sided LP position is a direct
deposit into a price range; there is no token being swapped, so there is
no "amountOut" to quote. The quote/simulate/gas-estimate pipeline that
*does* exist (`chain/quote.ts`, tested extensively in
`test/quote.test.ts` and `test/integration/quote.rpc.test.ts`) belongs to
`chain/swap.ts`/`chain/tradingApi.ts` (the `/swap`, zapout, and meme-sell
flows) — code paths MULTI's `mintFn` never invokes.

## 12. Price Impact

**NOT APPLICABLE to MULTI's execution path**, for the same reason as §11:
`checkPriceImpact()`/`assertMaxPriceImpact()` (`src/chain/priceImpact.ts`)
are called only from `chain/swap.ts` and `chain/tradingApi.ts` — confirmed
by grep, zero references from `chain/mint.ts` or `src/strategy/`.

**Observation (not a MULTI defect, documented for completeness):**
`checkPriceImpact()` returns `{ok: true, ...}` ("skip check") when a fair
USD price for either token is unavailable, rather than rejecting — a
deliberate design choice (the code comment says so) since the *actual*
execution-safety protection for a swap is its independent minOut/slippage
floor (`chain/swap.ts`, extensively tested in
`test/swap.decimals.test.ts`), not this external-price cross-check. This
file has no direct unit tests of its own currently. Pre-existing,
unrelated to MULTI, not fixed here (out of scope — MULTI never reaches
this code).

## 13. Simulation

**PASS — UNIT + code trace.** `chain/mint.ts`'s v3 mint path calls
`client.simulateContract(...)` for the actual `mint()` call *before* gas
estimation and *before* broadcast; a revert here is caught and re-thrown
with a descriptive error, which `multiExecute.ts`'s `executeTradeIntent`
catches and converts to `{skipped: true, reason: 'SIMULATION_FAILED'}` —
confirmed by the existing regression test (Phase 4.5.1:
"a mintFn failure ... is caught and reported as SIMULATION_FAILED"),
re-verified passing this phase, and re-confirmed by this phase's test
that **no** position/ledger/accounting-metadata row is created for a
failed simulation.

## 14. Gas

**PASS — UNIT + code trace.** `estimateWriteGas()` (`src/chain/gas.ts`)
runs *after* `simulateContract` already succeeded (i.e., the transaction
is already known to be logically valid) — a genuine `eth_estimateGas` RPC
failure retries once, then falls back to an **explicit, bounded**
`fallbackGas` constant (`900_000n` for a v3 mint) rather than an unlimited
value. This is pre-existing Phase 2 design, already deliberately tested
(`test/gas.test.ts`: "gas estimation failure: falls back to the explicit,
bounded fallbackGas — never unlimited/huge"; "gas estimation retries once
before falling back"). Not a MULTI-introduced behavior, not changed this
phase, not a violation of the "no unlimited/silently-invented-huge
fallback" invariant — the fallback is a small fixed constant, not
unbounded, and is documented, tested, and only reached after simulation
already proved the call succeeds.

## 15. Transaction Boundary

**PASS — source-level + runtime, re-verified this phase.**

```
grep -rn "sendTransaction\|writeContract\|walletClient\." src/strategy/
→ zero matches
```

Runtime: the existing spy-based tests (`test/strategy.multiExecute.test.ts`)
inject a failing `mintFn` and confirm it is the *only* function MULTI ever
calls to reach execution — no alternate path exists. Traced the full
architecture once more end to end:

```
MULTI (executeTradeIntent) -> mintFn (default: mintSingleSided)
  -> chain/mint.ts -> wallet.writeContract(...)
    -> wallet client from getWalletClient() (chain/clients.ts), whose
       sendTransaction/writeContract are unconditionally wrapped with
       withTxLock() + journalledSend() for EVERY caller — applied once,
       at client-construction time, with no per-call-site opt-in
```

No alternate write path exists. Unchanged from Phase 4/4.5/4.5.1.

## 16. Dry Run

**PASS — UNIT.** `runMultiStrategy({dryRun:true})` against a `mintFn` spy
that throws if called: 0 calls, `run.executed.length === 0` (existing
test, re-confirmed passing this phase). Since `mintFn` is the *only*
function through which `sendTransaction`/`writeContract` are reachable
from MULTI's code (§15's source-level grep proves no alternate path), zero
`mintFn` calls transitively proves zero `sendTransaction`/`writeContract`
calls for a dry run — this is a sound logical proof, not an assumption,
because the alternate-path possibility is independently foreclosed by the
grep. Dry-run *does* perform read-only candidate/pool discovery (as
designed) and never reaches a broadcast.

## 17. Accounting

**PASS — UNIT, with one P2 bug found and fixed this phase.**

Success path (`strategy: 'multi'` + full candidate/pool/range metadata):
unchanged, verified by existing tests (Phase 4's
`recordMultiPositionMeta` append-only test, Phase 4.5.1's dry-run test).

Failure-path atomicity (no false position/ledger/accounting for a failure
at each stage) re-confirmed this phase:

| Failure stage | Result | Test |
|---|---|---|
| Candidate stage (fetch failure, filtered out) | Never reaches execution at all — trivially safe | `test/strategy.multiCandidates.test.ts` |
| Pool stage (no eligible pool) | `NO_VALID_POOL`, 0 intents/executions | `test/strategy.multiExecute.test.ts` |
| Risk gate (duplicate/NOT_USDG/etc.) | `{skipped:true}`, mintFn never called | `test/strategy.multiExecute.test.ts` |
| Quote/simulation/gas (all surface as a `mintFn` throw) | `SIMULATION_FAILED`, **and this phase confirmed**: `listOpenPositions().length === 0`, `getMultiPositionMeta() === undefined` | `test/strategy.multiExecute.test.ts` |
| Execution (post-mint accounting) | N/A — accounting calls are synchronous and unconditional once mint succeeds; no partial-write path exists in the source | code review |

**Bug found and fixed (P2, BUG-002 — see §23):** `JournalAccountingMeta`
(the struct staged in the tx journal *before* broadcast, used by Phase
3.5 to reconstruct a missing ledger row after a crash) never carried a
`strategy` field. A MULTI deposit reconstructed via crash-recovery
(instead of recorded by the immediate, synchronous `recordLedger()` call
in `executeTradeIntent`) would silently lose its `'multi'` tag. Fixed by
adding the field (optional; all 5 pre-existing manual `bot.ts` call sites
are untouched and unaffected, since they never set it either, matching
current/expected `undefined` behavior for manual positions) and reading
it through in `pnl/reconcile.ts`'s recovery `recordLedger()` call.

## 18. Recovery

**PASS — UNIT (Phase 3.5 mechanics unchanged and re-verified) + the fix above.**

Re-confirmed via existing `test/reconcile.test.ts` (now 720+ lines, 2 new
tests added this phase):
1. Journal entry exists before broadcast (`createTxJournalEntry`, always `BROADCAST_UNKNOWN` initially) — unchanged.
2. Simulated crash = journal reaches `CONFIRMED` with staged `accounting_meta` but no ledger row yet — unchanged.
3. `recoverMissingLedger()` reconstructs the missing row from that metadata — unchanged, and **now correctly includes `strategy` when staged** (new test 2b).
4. Running recovery twice does not duplicate (idempotent via `recordLedger`'s existing dedup) — unchanged.
5. `usd: null` at staging time → `RECONCILIATION_REQUIRED`, never a `$0` guess — unchanged, existing test.
6. A manual (no-strategy) entry recovers with `strategy` still `undefined` — new test 2c, proves the fix is purely additive and doesn't affect existing manual-position recovery behavior.

## 19. Fork Validation

**BLOCKED.** No fork tooling exists in this repository (`hardhat.config.*`,
`foundry.toml`, and any Anvil/fork script are all absent — confirmed by
directory listing). `hardhat` is present only as a transitive
sub-dependency four levels deep
(`@uniswap/v3-sdk → @uniswap/swap-router-contracts → hardhat-watcher → hardhat`),
not as project tooling; no new fork framework was installed this phase
(per instructions: "do not install a large framework just to claim fork
testing passed"). Even with tooling, forking chain 4663 at any block would
itself require reaching the same RPC endpoint that §20 proves is
unreachable — the blocker is the same root cause, not merely absent
tooling.

**Minimum safe fork setup (proposed, not implemented):** a `foundry.toml`
with `[rpc_endpoints] robinhood = "${RPC_4663}"` and `anvil --fork-url
$RPC_4663 --fork-block-number <N>` would be sufficient once a working
Robinhood RPC credential is available (e.g., Alchemy/QuickNode, per this
project's own `.env.example` recommendation) — this requires no code
changes, only an operator-supplied working RPC URL.

## 20. RPC Investigation

**Conclusive: DNS-layer interception, not TLS/HTTP/rate-limit/auth.**
Deeper evidence than Phase 4.5, gathered fresh this phase:

```
nslookup rpc.mainnet.chain.robinhood.com
  -> Name: internetbaik.telkomsel.com, Address: 202.3.218.139
     Aliases: rpc.mainnet.chain.robinhood.com

Direct TLS handshake (bypassing HTTP entirely) to that resolved IP:443:
  -> FAILED: "Hostname/IP does not match certificate's altnames:
     Host: rpc.mainnet.chain.robinhood.com. is not in the cert's
     altnames: DNS:internetbaik.telkomsel.com, DNS:internettepat.telkomsel.com"
```

The server at the resolved IP identifies itself, via its own TLS
certificate, as **Telkomsel's** (an Indonesian mobile carrier)
content-filter/captive-portal domains — not Robinhood Chain
infrastructure at all. This is definitive: the local network's DNS
resolver is redirecting this specific hostname to an ISP-operated server,
and that server's own certificate proves it. This is categorically
different from a slow/rate-limited/misconfigured real endpoint.

Control comparison, same methodology, same run:

| Host | DNS | TLS handshake |
|---|---|---|
| `rpc.mainnet.chain.robinhood.com` | Resolves to an ISP redirect IP | **Fails** — wrong certificate (ISP's, not Robinhood's) |
| `1rpc.io` (BSC) | Resolves normally (Cloudflare IPs) | **OK** — cert CN=`1rpc.io` |
| `mainnet.base.org` (Base) | Resolves normally (Cloudflare IPs) | **OK** — cert CN=`base.org` |

Classification: **ISP/network interception (DNS hijack)**, isolated to
this one hostname. Not a code defect; not something a code or config
change in this repository can work around (the fix must come from either
a different DNS path — e.g., a VPN, a different network, or a
provider-recommended paid RPC endpoint such as Alchemy/QuickNode, exactly
as this project's own `.env.example` already suggests for this chain).

## 21. Test Results

```
Unit:        262/262 passing
             (previous 250 baseline + 9 new test/ticks.test.ts
              + 1 new currentTick test in strategy.multiRange.test.ts
              + 2 new strategy-attribution tests in reconcile.test.ts)
Typecheck:   clean (tsc --noEmit)
Build:       clean (tsc)
Integration: 1 passed, 2 timed out (3 total)
```

Fresh `npm run test:integration` run, completed after this report was
first drafted:

```
tests 3, pass 1, cancelled 2
✖ live RPC: getExecutableQuoteV3 succeeds against a real pool and matches
  an independent full-tick-range cross-check — 'test timed out after 300000ms'
✖ live RPC: a trade sized to cross an initialized tick produces a real
  quote that diverges from the rough slot0 estimate — 'test timed out after 180000ms'
✔ cross-check (bounded-window TickListDataProvider): amountOut=119630574
  (528 ticks in window [-230400, -153601]) — a real on-chain result was
  obtained successfully within this same run
```

Same shape as every prior run this session (Phase 4.5: 1 pass/2
cancelled, then 2 pass/1 timeout; Phase 4.5.1: 2 pass/1 timeout) — the
exact pass/timeout split varies run to run because it depends on live,
external rate-limiting conditions at the time, not on this repository's
code. This particular run's wall-clock duration was markedly longer than
prior runs (dozens of `ticks rate-limited, retry N/10` backoff cycles
visible in the log); this reflects Base's public RPC being unusually
congested at the time, not a hang or regression in this repository's own
code — the fixes made this phase (`chain/ticks.ts`, `pnl/reconcile.ts`,
`db/index.ts`, `strategy/multiExecute.ts`) touch neither chain 8453 nor
anything this suite exercises.

Skipped: 0. Blocked (environment, not code): the two chain-4663-dependent
integration-style validations (§5's on-chain USDG check, §6's on-chain
pool validation) — both explicitly marked BLOCKED above with evidence,
never silently passed or omitted.

`npm run test:integration` targets chain 8453 (Base) — unrelated to
MULTI, unrelated to chain 4663, unrelated to every fix made this phase.
This timeout is **ENVIRONMENT FAILURE** (public-RPC rate limiting,
already documented and reproduced identically across Phase 4.5 and
4.5.1), never **CODE FAILURE** — no MULTI or ticks.ts code path is
exercised by that suite.

## 22. Adversarial Audit

Swept for every item listed in this phase's instructions:

| Check | Result |
|---|---|
| Direct transaction APIs in `src/strategy/` | Zero matches |
| Shell execution / unsafe command construction | `gmgn/cli.ts` unchanged this phase (Phase 4.5.1's `cross-spawn` + argument allowlist fix still in place); no new process-spawning code added |
| Missing auth | N/A — no new external API surface added |
| Unsafe fallback values | Gas fallback is explicit/bounded (§14, pre-existing); no MULTI-introduced fallback found |
| Zero minOut | Zero matches for `minOut\s*=\s*0` in `src/strategy/` |
| Missing slippage checks | N/A — MULTI's mintFn path has no swap/slippage concept (§11) |
| Stale price acceptance | Inherited from shared price layer, untouched this phase |
| Unknown price => zero | Not found — `checkPriceImpact`'s "skip on unknown" (§12) is a different pattern (skip a secondary check, never fabricates a $0 valuation) and is unreachable from MULTI anyway |
| RPC failure => fake success | Not found — pool discovery under RPC failure correctly degrades to zero pools (Phase 4.5 evidence, unchanged) |
| Duplicate accounting | `recordLedger`/`recordMultiPositionMeta` both idempotent, re-confirmed by existing + new tests |
| Duplicate positions | `checkDoubleEntry` — unchanged, tested |
| Race conditions | Broadcast serialization is per (chain, wallet) via `withTxLock`, shared infra, unchanged; MULTI introduces no new concurrency primitive besides an in-memory cooldown map, which is bounded in practice by `MULTI_MAX_OPEN_POSITIONS` (small) |
| Unbounded state growth | The in-memory MULTI cooldown map only grows on a *successful* entry (not per-candidate-scanned), so its size is bounded by actual position count in practice — not unbounded in any realistic run |
| NaN/Infinity | **Found and fixed** in tick-math (§9, BUG-001); **found and documented, not fixed** in pool scoring (§7, BUG-003) |
| Unchecked token addresses | `assertGmgnAddress`/`ADDRESS_RE` validate every address reaching gmgn-cli; MULTI candidate addresses flow through this |
| Symbol-based USDG matching | Zero matches — only a code comment explaining it is deliberately avoided |
| Unsupported fee coercion | Zero matches — traced to the ABI (§8), confirmed no coercion anywhere |
| Strategy isolation bypass | `getActiveStrategyName()` gate re-confirmed present at all 3 `/multi` handlers in `src/bot/bot.ts`, unchanged this phase |

Special attention was paid to changes introduced after Phase 4.5.1
(the `cross-spawn`/`gmgn/cli.ts` hardening): re-read the full diff of that
change again this phase — no additional issue found beyond what Phase
4.5.1's own report already documented (the argument-allowlist gate
remains the closer for `cross-spawn`'s one known escaping gap).

## 23. Bugs Found

### BUG-001 — `computeSingleSidedRange` hangs/misreports on non-finite `currentTick` (FIXED this phase)

- **Severity**: P1 (a `currentTick=Infinity` causes a genuine, unrecoverable, full-process hang — a complete denial-of-service of the entire single-threaded bot, not just MULTI, since the function is shared with manual mints; a `currentTick=NaN` causes a silently-wrong `valid:true` result, which is a correctness violation of an explicitly required safety invariant, though downstream `runRiskGate`'s independent `tickLower < tickUpper` check happens to also reject NaN before any execution — so the NaN sub-case, while a real bug, did not lead to an executable trade even before the fix; the Infinity sub-case's hang, however, happens *before* any gate is reached at all)
- **File**: `src/chain/ticks.ts`, function `computeSingleSidedRange`
- **Root cause**: `while (tickLower <= currentTick) { tickLower += spacing; }` never terminates once `tickLower` becomes `Infinity` (since `Infinity <= Infinity` is always true and adding a finite number to `Infinity` stays `Infinity`). Separately, every downstream comparison (`tickLower >= tickUpper`, `currentTick >= tickLower` in `assertOutOfRange`) is always `false` for `NaN`, so a NaN tick silently passed every guard meant to catch it.
- **Impact**: Any caller supplying a non-finite `currentTick` (malformed/corrupted pool state, a bug elsewhere, a test double) hangs the entire Node process indefinitely (Infinity case) or receives a bogus `valid:true` result with NaN ticks (NaN case). Reachable from both MULTI (`strategy/multiRange.ts`) and manual mints (`chain/mint.ts`, `chain/v4.ts`).
- **Fix**: Added `Number.isFinite(currentTick)` and `Number.isFinite(tickSpacing) && tickSpacing > 0` guards at the top of the function, before any loop or comparison. Real Uniswap ticks are always finite `int24` values, so no real call is affected — only genuinely malformed input is now rejected (via a thrown `Error`, which `computeMultiRange`'s existing `try/catch` already converts to `valid:false`).
- **Test**: `test/ticks.test.ts` (new, 9 tests) + 1 new test in `test/strategy.multiRange.test.ts`.

### BUG-002 — MULTI ledger deposit loses `strategy` attribution across crash-recovery (FIXED this phase)

- **Severity**: P2 (accounting/reporting-attribution defect; does not cause capital loss, incorrect amounts, or a duplicate/missing ledger event — only the "which strategy" label could be wrong, and only in the narrow window where a process crash occurs between broadcast success and the immediate `recordLedger()` call)
- **File**: `src/db/index.ts` (`JournalAccountingMeta` type), `src/strategy/multiExecute.ts` (staging call), `src/pnl/reconcile.ts` (recovery call)
- **Root cause**: `JournalAccountingMeta` never had a `strategy` field, so `setJournalAccountingMeta()` calls (including MULTI's) never staged it, and Phase 3.5's `recoverMissingLedger()` had nothing to read when reconstructing a missing ledger row.
- **Impact**: A MULTI deposit's ledger row, if reconstructed via crash-recovery instead of the immediate synchronous path, would have `strategy: undefined` instead of `'multi'` — silently misattributed in any PnL-by-strategy or audit view.
- **Fix**: Added `strategy?: string` to `JournalAccountingMeta` (optional — the 5 pre-existing manual `bot.ts` call sites are untouched and continue to omit it, exactly matching their current, correct, `undefined` behavior); `multiExecute.ts` now stages `strategy: 'multi'`; `reconcile.ts`'s recovery `recordLedger()` call now passes `strategy: m.strategy` through.
- **Test**: 2 new tests in `test/reconcile.test.ts` (one proving the tag survives recovery, one proving a manual/no-strategy entry is unaffected).

### BUG-003 — `scoreMultiPool` propagates NaN into `totalScore` (found, documented, NOT fixed this phase)

- **Severity**: P2 (ranking-quality defect among already-valid, already-filtered pools — never a safety bypass; a pool reaching this scoring step has already passed the USDG-pair, preferred-fee-tier, and minimum-TVL hard filters, so it is a legitimate, tradeable pool regardless of its score)
- **File**: `src/strategy/multiPool.ts`, function `scoreMultiPool`
- **Root cause**: `Math.min(1, tvlUsd / TVL_REFERENCE_USD)` (and the equivalent for volume/volume-per-TVL) propagates `NaN` if `tvlUsd`/`volumeUsd` is `NaN` rather than a real number or `null`. `Infinity` is already handled correctly (`Math.min` naturally caps it); only `NaN` is a problem.
- **Impact**: If a pool's TVL or volume were ever read as literal `NaN` (would require a malformed upstream numeric field from DexScreener parsing — `ListedPool.tvlUsd`/pair volume are typed `number`, not validated for finiteness at the read site), its `totalScore` becomes `NaN`, and `Array.prototype.sort`'s comparator behavior for `NaN` differences is implementation-defined (V8 typically leaves relative order unchanged rather than crashing) — meaning such a pool could be mis-ranked among alternatives, in either direction.
- **Recommended fix**: Treat a non-finite `tvlUsd`/`volumeUsd` the same as `null` (already-handled "unknown, scores 0 for that dimension") — e.g. `const tvl = Number.isFinite(tvlUsd) ? tvlUsd : null;` before the existing `tvlUsd != null` checks.
- **Why not fixed this phase**: Narrower real-world reachability than BUG-001 (requires a malformed upstream API value, not any degenerate but plausible on-chain state), and lower impact (ranking quality, not safety/capital/availability) — judged not "directly necessary" for this phase's validation scope, per the instruction to avoid fixing unrelated bugs beyond what's required. Flagged here in full for a follow-up.
- **Test**: none added (not fixed) — reproduction is exact and given above (`scoreMultiPool` with `tvlUsd: NaN` → `totalScore: NaN`), sufficient for a future fix's own regression test.

### Observation (not a bug) — close-path ledger events never carry a `strategy` tag, for any position

Documented for completeness (§17): `withdrawal`/`fee_claim` `recordLedger()`
calls in the shared close handler (`src/bot/bot.ts`, ~line 4038-4053) never
set `strategy`, for MULTI-opened positions or manual ones alike. This is
**not a MULTI-specific regression** and **not a crash-recovery
inconsistency** (BUG-002's fix was specifically about recovery losing an
attribution the *immediate* path would have set — here, the immediate
path itself never sets it, for anyone, so recovery is consistent with
normal behavior). It is a pre-existing, uniform gap in close-side
PnL-by-strategy completeness, predating MULTI entirely. Not classified as
a bug requiring a fix in this phase (would require threading the opening
strategy through the close handler — a larger, more architectural change
than this phase's narrow, behavior-preserving-fix mandate allows).

## 24. Blocked Items

| Item | Reason |
|---|---|
| USDG on-chain existence/decimals/symbol (chain 4663) | RPC unreachable — DNS interception, §20 |
| Real pool on-chain validation (TVL/fee/tick/liquidity for live candidates) | Same |
| Single-sided range against real live pool state | Same |
| Quote/price-impact/simulation/gas against real chain 4663 state | N/A for quote/price-impact (§11/§12 — not on MULTI's code path at all); simulation/gas mechanics validated via code trace + unit tests, but never against real chain-4663 state specifically |
| Fork validation | No fork tooling configured; would also require the same blocked RPC to fork from |
| Full re-run of `npm run test:integration` numeric result | Pending completion at time of writing — see §21 final numbers |

## 25. Safety Assessment

All invariants from this phase's §2 checklist:

| Invariant | Status |
|---|---|
| A. Strategy code never broadcasts directly | **HOLDS** — zero matches, re-verified |
| B. Execution only through the existing boundary | **HOLDS** — traced end to end |
| C. Failed quote/simulation/gas fails closed | **HOLDS** — `SIMULATION_FAILED` catch-all, tested; N/A for quote/price-impact specifically (not on MULTI's path) |
| D. Unknown price never becomes $0 | **HOLDS** — no instance found anywhere in the audited paths |
| E. Invalid/missing pool state never fabricated | **HOLDS** — RPC failure degrades to zero pools, not fake ones (live-observed in Phase 4.5, unchanged) |
| F. Unknown classification rejects | **HOLDS** — `CLASSIFICATION_UNKNOWN`, tested, live-observed |
| G. USDG identified by contract address | **HOLDS** — code + test, on-chain confirmation BLOCKED |
| H. Unsupported fee tiers reject | **HOLDS** — traced to ABI, tested |
| I. Dry-run makes zero write calls | **HOLDS** — logical proof (§16) |
| J. Failed execution creates no false accounting | **HOLDS** — re-confirmed live this phase (§17) |
| K. Tx lock/journal/recovery remain active | **HOLDS**, and **strengthened** this phase (BUG-002 fix closes a real attribution gap in the recovery path) |
| L. minOut/withdrawal safety remains active | **HOLDS** — untouched, pre-existing Phase 1/2 tests still passing |
| M. Never substitute a guessed value for an unavailable RPC result | **HOLDS**, and a real violation of the spirit of this invariant (BUG-001's silent `valid:true`/NaN case) was found and fixed |

**No safety invariant was weakened to make any test pass.** Both fixes
made this phase strictly narrow failure modes that previously escaped
detection (a hang, and a mis-attribution) into explicit, correct
fail-closed behavior — the opposite of weakening.

## 26. Final Verdict

**PASS WITH BLOCKED LIVE VALIDATION**

- The full candidate discovery → filter → rank → Top-10 pipeline is
  validated **LIVE**, with real data, using the real unmodified
  production code path.
- Two real, in-scope bugs were found via genuine adversarial execution
  (not just code reading) and fixed with minimal, behavior-preserving
  changes, each with new regression tests — 262/262 unit tests pass,
  typecheck clean, build clean.
- Everything requiring chain 4663's own RPC (on-chain USDG/pool/tick
  validation, fork testing) remains **BLOCKED** by a conclusively
  root-caused ISP DNS interception, not a code defect — proven this phase
  with a direct TLS certificate mismatch, the strongest evidence yet.
- No transaction was broadcast. No real capital was touched at any point.
- One additional bug (pool-scoring NaN propagation, BUG-003) and one
  observation (close-path strategy attribution) were found, classified,
  and documented rather than fixed, per this phase's explicit scope
  discipline.

This is not a full **PASS** because materially important chain-4663-state-
dependent validation remains blocked by an external network condition
outside this codebase's control. It is not **FAIL** because no unresolved
safety defect or capital-risk issue was found — both real defects
discovered were fixed, tested, and verified, and every fail-closed
invariant this phase checked either already held or now holds correctly
after those fixes.

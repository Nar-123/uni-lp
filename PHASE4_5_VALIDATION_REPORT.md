# Phase 4.5 — MULTI Real Network / Fork Validation

## 1. Executive Summary

This phase validated the existing MULTI implementation (unchanged from
Phase 4) against **real, live data** wherever the sandbox's network
environment allowed, and rigorously documents *exactly* what could not be
reached and why, rather than weakening any test or fabricating results.

Headline results:

- **Real candidate discovery, filtering, ranking, and Top-10 selection was
  validated end-to-end against real live GMGN market data** for the actual
  MULTI target chain (Robinhood, 4663) using the real, unmodified
  production function (`fetchAndFilterCandidates`). 50 real trending
  tokens in → 10 correctly selected, 40 correctly rejected with accurate
  reason codes, zero overlap, strictly volume-sorted. This is the strongest
  possible validation short of live capital.
- **All on-chain (RPC-dependent) validation for chain 4663 is BLOCKED** —
  not by a code defect, but because this sandbox's network cannot reach
  `rpc.mainnet.chain.robinhood.com` at all. Root-caused precisely: local
  ISP DNS interception (see §20). Two other configured chains (BSC, Base)
  resolve and respond normally, proving the sandbox's general network path
  works and isolating the block to this one hostname.
- **One real, reproducible bug was found and documented** (not fixed, per
  this phase's "validation only" mandate): on Windows, `gmgn-cli`
  installs as a `.cmd` shim, and the production `gmgnJson()` function uses
  `execFile()` without `shell:true` (a deliberate, correct security choice
  on POSIX to avoid shell injection) — this fails with ENOENT on Windows
  for *every* gmgn-cli-dependent feature (screener, zapout, and now MULTI
  candidate discovery), not just MULTI. Pre-existing, shared infrastructure,
  not part of Phase 4's own code. See §22, BUG-001.
- **No fork tooling exists in this repo** (no Hardhat/Foundry/Anvil
  project config — Hardhat appears only as a transitive sub-dependency of
  `@uniswap/swap-router-contracts`, unconfigured). Fork testing is BLOCKED
  for the same root cause as live RPC testing: forking chain 4663 would
  itself need to reach the same unreachable RPC to source state from.
- **Closed three real coverage gaps** found during the adversarial pass
  (quote/simulation/gas-failure path, exposure-limit check, no-valid-pool
  path) — all now permanent regression tests, all passing.
- **No P0 bugs. No safety bypass. No capital risk identified.** Every
  RPC-dependent code path that *was* reachable (partial pool discovery)
  degraded correctly to a safe, empty, fail-closed result rather than
  crashing or fabricating data, exactly as required.

**Verdict: PASS WITH BLOCKED LIVE VALIDATION** — see §28.

## 2. Environment

| | |
|---|---|
| Target chain | 4663 (Robinhood) — the only chain with `usdg` configured; MULTI is disabled by config validation on BSC/Base |
| RPC (Robinhood) | `https://rpc.mainnet.chain.robinhood.com` (default) — **unreachable from this sandbox** (see §20) |
| RPC (BSC) | `https://1rpc.io/bnb` — reachable, ~0.5s |
| RPC (Base) | `https://mainnet.base.org` — reachable, ~0.4s |
| Fork or real network | Neither available: no fork tooling configured; real network reachable for BSC/Base only, not for the MULTI target chain |
| Block number | N/A — no fork was created |
| Dry-run status | All validation in this phase was read-only / dry-run. Zero transactions were broadcast. Zero wallet clients were constructed for a write. |
| GMGN CLI | Installed (v1.5.6), with real credentials configured (`~/.config/gmgn/`). Confirmed reachable and returns real live data via direct invocation. The *production code path* to it is broken on this Windows host (BUG-001). |

## 3. Candidate Validation

Ran the real, unmodified `fetchAndFilterCandidates()` (from
`src/strategy/multiCandidates.ts`, imported directly, zero modification)
against real live GMGN data for chain 4663, interval `6h`. Because the
production fetch transport is blocked on Windows (BUG-001), the network
transport only was substituted with a direct `gmgn-cli` invocation
(read-only `market`/`token` subcommands only) feeding the exact same data
shape into the same function via its existing, already-unit-tested
`fetcher`/`infoFetcher` injection parameters — **the filtering, ranking,
scoring, and Top-N logic under test is 100% real and unmodified.**

- Source: `gmgn_trending_6h`, chain `robinhood` (4663), interval `6h`, limit 50.
- Raw candidates fetched: 50.
- Final candidates (post filter+rank+topN): **10**.
- Rejected: **40**.
- Elapsed: ~5.3s (dominated by 50 sequential `token info` lookups for age).

## 4. USDG Validation

| Check | Result |
|---|---|
| Configured address | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (from `CHAINS[4663].usdg` in `src/config.ts`, used as-is — nothing invented) |
| Contract exists / code non-empty | **BLOCKED** — requires chain 4663 RPC (`eth_getCode`), which is unreachable (§20) |
| `decimals()` / `symbol()` | **BLOCKED** — same reason |
| Address-based (not symbol-based) identity check | **Verified in code and by test**: `isUsdgPool()` and the risk gate's `NOT_USDG` re-check both compare the lowercased contract address, never a symbol/label. Test: "a pool paired with a different contract (even if it were labelled USDG) is rejected NOT_USDG" in `test/strategy.multiPool.test.ts`. |

No substitute stablecoin was used. No address was fabricated. The
on-chain existence/decimals/symbol check for this specific contract
remains **BLOCKED** pending real RPC access.

## 5. Fee Tier Validation

| Item | Result |
|---|---|
| Protocol fee representation | Verified: Uniswap V3's `fee()` return value is defined by the protocol itself as hundredths of a bip (`fee / 1_000_000` = fraction; `fee / 10_000` = percent) — this is a protocol-level constant, identical across every standard V3 deployment, not chain-specific. Confirmed internally consistent with this codebase's own existing `feeLabel = (fee/10000).toFixed(2)+'%'` used elsewhere (`chain/pools.ts`), which has been in production use for the default strategy already. |
| 50,000 = 5% / 40,000 = 4% / 30,000 = 3% | Correct by the above protocol definition. This is the fix applied in Phase 4 (previously `[500, 400, 300]`, off by 100×). |
| Actual availability on a real Robinhood-chain pool | **BLOCKED** — verifying a live pool's actual on-chain `fee()` value requires chain 4663 RPC, which is unreachable. Cannot confirm a 5%/4%/3%-fee USDG pool is actually deployed for any specific candidate on this chain right now. |
| Never forced/substituted when unavailable | Verified in code and by test: `FEE_TIER_NOT_SUPPORTED` for any fee not in `[50_000, 40_000, 30_000]` — e.g. the standard 0.3% (3000) tier is correctly rejected, not coerced. |

## 6. Pool Discovery

Ran `listPoolsForToken(4663, address, 0)` (real, unmodified production
function) against two real Top-10 candidates from §3:

| Candidate | Result |
|---|---|
| PONS (`0x39dbed3a...`) | v4 off-chain pool exploration (DexScreener-derived, no RPC needed) found **23 candidate pools**. Every one then required an on-chain `getSlot0` read (v4StateView contract) to resolve/validate — **every single RPC call failed** (Robinhood RPC unreachable, §20). Final result: `pools: []` — correctly degraded to empty rather than crashing or fabricating pool state. |
| LUCIA (`0xae12303b...`) | 1 candidate pool found off-chain; same RPC-read failure; `pools: []`. |

This is the single most important finding of this phase: **the code's
fail-closed behavior was verified live, under a real RPC outage, and it
held.** No pool was fabricated. No `UNKNOWN → 0` occurred. The function
returned a clean, empty, safe result.

Pool validation, scoring, fee-tier-against-real-state, single-sided
range with real current tick, both token-orientation tests against real
pool state, executable quote, price impact, simulation, gas estimation,
and transaction-journal preparation with real inputs are all **BLOCKED**
by this same root cause (§7–§15, §17–§21).

## 7. Pool Scoring

**BLOCKED** for real pool data (§6). The scoring function itself
(`scoreMultiPool`) is unchanged from Phase 4 and remains covered by 5
unit tests (TVL/volume/volume-per-TVL/fee weighting, deterministic
tie-break, missing-data-scores-zero) — logic-level validation only in
this phase.

## 8. Single-Sided Validation

**BLOCKED** for real pool state (no reachable current tick/price for any
real chain-4663 pool). Logic-level validation performed instead:
`computeMultiRange` was exercised directly (not just read) with both
`usdgIsToken0: true` and `usdgIsToken0: false`, confirming the resulting
range never straddles the given current tick in either orientation
(existing + reinforced test coverage, `test/strategy.multiRange.test.ts`).

## 9. Range Validation

**BLOCKED** for real protocol tick math against live state. Logic-level
validation: confirmed lower-bound price ≈ 0.50× current price (tolerance
0.45–0.55 for tick-spacing rounding), tick-spacing alignment, and — new
this phase — **live-executed** (not just read) degenerate-input checks:
`tickSpacing` of `0`, `-60`, and `NaN` were fed directly into the real
`computeMultiRange()` function and all three failed closed
(`valid:false`) rather than producing a `NaN`/`Infinity` tick or crashing.
Added as a permanent regression test.

## 10. Token Direction Tests

Both orientations tested at the logic level (real chain state is BLOCKED,
§6):

- `usdgIsToken0: true` → range placed **above** market, confirmed `tickLower > currentTick`.
- `usdgIsToken0: false` → range placed **below** market, confirmed `tickUpper <= currentTick`.
- USDG-pool matching (`isUsdgPool`) tested with USDG as token0 and as token1, both case-insensitive.

## 11. Executable Quote

**BLOCKED** — requires a real, validated pool on chain 4663 (§6), which
requires the unreachable RPC. MULTI does not implement its own quote
logic (confirmed by source grep — zero `quote`-related code in
`src/strategy/`); it would call the same `getExecutableQuoteV3` /
`chain/quote.ts` machinery already covered by the pre-existing Phase 2
test suite (`test/quote.test.ts`, `test/integration/quote.rpc.test.ts`)
via `mintSingleSided`.

## 12. Price Impact

**BLOCKED**, same reason as §11. No MULTI-specific price-impact logic
exists to validate separately — it is entirely inherited from the shared,
already-hardened quote pipeline.

## 13. Simulation

**BLOCKED** for a real simulation against chain 4663. What *was* validated
live: `executeTradeIntent`'s handling of a simulation failure. A
`mintFn` that throws (the exact shape a real quote/simulation/gas failure
inside `mintSingleSided` would take) is caught and reported as
`{skipped: true, reason: 'SIMULATION_FAILED'}` — verified by a new test
that also confirms **no** open position, ledger entry, or accounting
metadata is ever created for a mint that never completed.

## 14. Gas Estimation

**BLOCKED** for a real gas estimate on chain 4663. MULTI implements no
gas logic of its own (confirmed by source grep); any gas-estimation
failure inside `mintSingleSided` surfaces through the same
`SIMULATION_FAILED` catch-all validated in §13 — MULTI never sees or
handles gas values directly, so there is no MULTI-specific "unlimited gas
fallback" risk to check.

## 15. Transaction Journal

**BLOCKED** for a real journal entry backed by a real (even simulated)
broadcast attempt, since that requires reaching `mintSingleSided`'s
internals against real chain state. What *is* re-confirmed this phase:
the journal/lock wrapping happens at the shared wallet-client level
(`chain/clients.ts`, `getWalletClient()`), applied unconditionally to
every `sendTransaction`/`writeContract` call from any caller — this was
traced and documented in the Phase 4 audit and is unchanged.

## 16. Execution Boundary

Re-verified this phase, unchanged from Phase 4:

```
grep -rn "sendTransaction|writeContract|walletClient\." src/strategy/
→ zero matches
```

Enforced as an automated test (`test/strategy.multiExecute.test.ts`).
MULTI cannot broadcast a transaction from its own code under any
circumstance reachable in this sandbox or otherwise — every execution
path terminates at the injectable `mintFn` (defaulting to the same
`mintSingleSided` manual mints use).

## 17. Accounting

Verified live (not just by test) via §13's new test: a failed mint
(`mintFn` throws) produces **zero** `recordOpenPosition`,
`recordMultiPositionMeta`, or ledger rows. The full-success accounting
path (`strategy:'multi'` tag + all metadata fields) remains verified as
in Phase 4 by reading `executeTradeIntent`'s code, since exercising it
end-to-end requires the BLOCKED real mint path (§13).

## 18. Dry Run

Confirmed again this phase: `runMultiStrategy({dryRun:true})` against a
spy `mintFn` that throws if called → 0 calls, `run.executed.length === 0`.
The live real-candidate run in §3 was itself effectively an extended
dry-run (candidate discovery + filtering only, no pool/mint attempted) —
broadcast count: **0**. Ledger finalized events created by this phase's
testing: **0**. On-chain positions created by this phase's testing: **0**.

## 19. Fork Test

**BLOCKED.** No fork tooling is configured in this repository — no
`hardhat.config.*`, no `foundry.toml`, no Anvil setup. `hardhat` appears
only as a transitive sub-dependency three levels deep
(`@uniswap/v3-sdk` → `@uniswap/swap-router-contracts` → `hardhat-watcher`
→ `hardhat`), not as project tooling. Introducing fork infrastructure was
out of scope for this "validation only, do not rewrite architecture"
phase. Even if it had been set up, forking chain 4663 at any block would
itself require reaching the same RPC endpoint that is blocked (§20) — so
the blocker is not merely "missing tooling," it is the same underlying
network constraint.

## 20. Real RPC Smoke Test

**Root-caused precisely, not just observed:**

```
$ nslookup rpc.mainnet.chain.robinhood.com
Non-authoritative answer:
Name:    internetbaik.telkomsel.com
Address: 202.3.218.139
Aliases: rpc.mainnet.chain.robinhood.com

$ ping rpc.mainnet.chain.robinhood.com
Pinging [202.3.218.139]: Request timed out (100% loss)
```

This sandbox's local network resolves this specific hostname to an ISP
captive-portal/content-filter domain (`internetbaik.telkomsel.com` — a
Telkomsel [Indonesian mobile carrier] DNS-redirect service), not the real
IP. Both `curl` (schannel TLS error) and Node/viem (`fetch failed`)
confirm no connection can be established, consistent with a DNS-layer
interception rather than a slow/rate-limited endpoint.

This is **not** a code defect and **not** specific to MULTI. As a control,
the same smoke-test method against the two *other* configured chains
succeeded immediately:

| Chain | `chainId` read | Factory `getCode` |
|---|---|---|
| 4663 Robinhood | ❌ fetch failed (202ms) | ❌ fetch failed |
| 56 BSC | ✅ 56 (468ms) | ✅ has code (1052ms) |
| 8453 Base | ✅ 8453 (390ms) | ✅ has code (414ms) |

`REAL_NETWORK_SMOKE_TEST (chain 4663) = BLOCKED` (environment/DNS, not code).
`REAL_NETWORK_SMOKE_TEST (chains 56, 8453) = PASS` (confirms method + general connectivity are sound; these chains don't have USDG configured, so they cannot validate MULTI itself).

## 21. Adversarial Tests

All 25 required cases, with disposition:

| # | Case | Disposition |
|---|---|---|
| 1 | Fake USDG symbol | Covered — contract-address comparison test |
| 2 | Unavailable preferred fee | Covered — `FEE_TIER_NOT_SUPPORTED` test |
| 3 | Wrong token ordering | Covered — USDG-as-token0/token1 both tested |
| 4 | Wrong decimals | Inherited from shared `chain/tokens.ts`/`chain/swap.ts` (already tested in `test/swap.decimals.test.ts`); MULTI reimplements no decimal math |
| 5 | Stale price | Inherited from shared price layer (`test/priceFreshness.test.ts`); MULTI reads price only for USD position sizing, via the same function |
| 6 | Stale quote | Inherited (`test/quote.test.ts`); MULTI never quotes directly |
| 7 | Quote failure | **Gap closed this phase** — new test: `mintFn` throw → `SIMULATION_FAILED`, no partial state |
| 8 | Simulation failure | Same as #7 (uniform catch-all in `executeTradeIntent`) |
| 9 | Gas failure | Same as #7 |
| 10 | Pending transaction | Covered — `checkPendingTransaction` test |
| 11 | Unresolved transaction | Same mechanism as #10 |
| 12 | Duplicate position | Covered — `checkDoubleEntry` test |
| 13 | Position limit | Covered — `MULTI_MAX_OPEN_POSITIONS`/`_PER_TOKEN` tests |
| 14 | Exposure limit | **Gap closed this phase** — new test for `MULTI_MAX_EXPOSURE_USD` |
| 15 | Candidate unknown MC | Covered — `MC_UNKNOWN`, and confirmed with real data (§3: 0 unknown-MC in this run, logic unit-tested) |
| 16 | Candidate unknown age | Covered — `AGE_UNKNOWN`, **and observed live**: 3 real tokens hit this exact path in §3 |
| 17 | Candidate unknown volume | Covered — `VOLUME_UNKNOWN` |
| 18 | Candidate below MC | Covered, **and observed live**: 33 real rejections in §3 |
| 19 | Candidate below age | Covered, **and observed live**: 4 real rejections in §3 |
| 20 | Candidate outside Top 10 | Covered — topN-cap test |
| 21 | Malformed pool | Covered — null-fee, null-TVL handled without throwing |
| 22 | Missing pool | **Gap closed this phase** — new test: empty `poolFetcher` result → `NO_VALID_POOL`, **and observed live** in §6 (real RPC failure degraded to the same empty-pool state) |
| 23 | Both-sided range | Covered — single-sidedness assertion test |
| 24 | Invalid ticks | Covered — `INVALID_RANGE` test |
| 25 | Invalid tick spacing | Covered, **and observed live this phase**: `tickSpacing` of 0/-60/NaN all fail closed |

Expected behavior (REJECT/ABORT/BLOCKED, never EXECUTE) held in every case
that could be exercised.

## 22. Bugs Found

### BUG-001 — `gmgn-cli` unreachable via `execFile` on Windows

- **Severity**: P1 (complete feature unavailability on the affected
  platform; explicitly *not* P0 — it fails closed safely with no crash,
  no fabricated data, and no capital/safety exposure)
- **File**: `src/gmgn/cli.ts`
- **Function**: `gmgnJson()` (used by `gmgnMarketTrending`, `gmgnTokenInfo`,
  and every other gmgn-cli-backed function — screener, zapout, meme sell,
  and now MULTI candidate discovery)
- **Root cause**: `pExecFile(cliPath(), args, {...})` calls Node's
  `child_process.execFile()` without `shell: true`. On Windows, a global
  npm install of `gmgn-cli` produces a `.cmd` shim (confirmed:
  `gmgn-cli`, `gmgn-cli.cmd`, `gmgn-cli.ps1` all present in the npm global
  bin dir). Windows' `CreateProcess` cannot directly execute a `.cmd`
  file — only a shell (`cmd.exe`) can. `execFile` without `shell:true`
  therefore fails with `ENOENT`, which the code correctly classifies and
  reports as "gmgn-cli not found," even though it *is* installed and
  fully functional (confirmed working when invoked with a shell).
- **Impact**: On Windows hosts, `fetchAndFilterCandidates()`'s default
  fetcher always fails immediately, and (correctly, per the existing
  fail-closed design) returns zero candidates rather than crashing —
  `runMultiStrategy` would silently find nothing on every run. Same for
  the pre-existing `/screener` and zapout features. Not a Phase 4
  regression — this predates MULTI and affects the whole bot equally on
  Windows.
- **Fix**: Not applied in this phase (out of scope — "validation only, do
  not rewrite architecture," and this file is shared infrastructure, not
  MULTI-owned code). Recommended remediation for a follow-up: on
  `process.platform === 'win32'`, invoke via `execFile('cmd.exe', ['/d', '/s', '/c', cliPath(), ...args], {windowsVerbatimArguments: false, ...})`
  or resolve the `.cmd` path explicitly and pass it as the file directly
  (Node can execute a `.cmd` path directly without a shell if given the
  full path with extension) — either approach avoids `shell:true`'s
  string-concatenation injection risk while fixing Windows.
- **Test**: Not added as a repo test (platform-specific process-spawning
  behavior isn't practically unit-testable without mocking
  `child_process`, which risks masking the real bug); documented here
  with a reproduction command instead: on Windows, run
  `node -e "require('child_process').execFile('gmgn-cli',['--version'],(e)=>console.log(e))"`
  and observe `ENOENT`, vs. the same call with `{shell:true}` succeeding.

No other bugs (P0–P3) were found in MULTI-specific code this phase. Every
piece of MULTI logic that could be exercised — with synthetic boundary
data (Phase 4) or real live data (this phase) — behaved correctly.

### Housekeeping note (not a bug)

A stray file named `tatus` (87 lines, raw `git diff` output with ANSI
color codes) is present at the repo root, apparently committed
accidentally in commit `8396b44` (likely a truncated `git diff > status`
typo). Not related to MULTI or this validation; flagged here for cleanup
since it doesn't belong in version control. Left untouched pending your
confirmation, per this phase's "do not commit/push, minimize unrelated
changes" instruction.

## 23. Test Results

```
Unit:        230/230 passing (168 pre-Phase-4 baseline + 58 Phase 4 + 4 new Phase 4.5 gap-closing tests)
Integration: Not re-run this phase (unrelated to MULTI — targets chain 8453,
             not 4663; last run this session: 2/3 passing, 1 timeout on a
             rate-limited public RPC — see §24). No MULTI integration test
             exists in that suite.
Typecheck:   clean (tsc --noEmit)
Build:       clean (tsc)
```

New tests added this phase (all in existing Phase 4 test files, no new
files):

- `executeTradeIntent`: mintFn failure → `SIMULATION_FAILED`, zero partial state (`test/strategy.multiExecute.test.ts`)
- `checkPositionLimits`: `MULTI_MAX_EXPOSURE_USD` enforcement (`test/strategy.multiExecute.test.ts`)
- `runMultiStrategy`: no eligible pool → `NO_VALID_POOL`, zero intents/executions (`test/strategy.multiExecute.test.ts`)
- `computeMultiRange`: degenerate `tickSpacing` (0/-60/NaN) fails closed (`test/strategy.multiRange.test.ts`)

## 24. Blocked Tests

| Test | Reason |
|---|---|
| USDG contract existence/decimals/symbol on-chain (§4) | Chain 4663 RPC unreachable (DNS interception, §20) |
| Real pool validation/scoring/fee-tier-live-check (§6, §7, §12) | Same |
| Single-sided/range validation against real pool state (§8, §9, §10) | Same |
| Executable quote, price impact, simulation, gas estimation with real state (§11–§14) | Same |
| Transaction journal preparation with a real (even simulated) mint attempt (§15) | Same |
| Fork test / fork mint simulation (§19) | No fork tooling configured; would also require the same blocked RPC to fork from |
| `npm run test:integration` full re-run | Not repeated this phase — targets chain 8453 (unrelated to MULTI), known rate-limiting already documented this session; re-running would not change the MULTI verdict |

None of these were converted to PASS. None were skipped silently — each
is listed here with its specific, verified reason.

## 25. Remaining Risks

1. **Chain-4663-specific behavior is still unverified against real state.**
   Everything in §6–§15 is BLOCKED, not merely untested-by-choice. Before
   any live capital, this MUST be re-attempted from a network that can
   actually reach `rpc.mainnet.chain.robinhood.com` (e.g., a paid
   Alchemy/QuickNode endpoint, as the project's own `.env.example`
   recommends) or with a real fork sourced from a working RPC.
2. **BUG-001 (Windows gmgn-cli) will silently zero out MULTI candidate
   discovery in production if the bot is ever run on Windows** without a
   fix — it fails closed (no crash, no bad trade) but also means "MULTI
   never finds anything," which could be mistaken for "no good candidates
   today" rather than "the integration is broken." Recommend fixing
   before relying on MULTI on a Windows deployment.
3. Pool/candidate scoring weights remain uncalibrated heuristics (carried
   over from Phase 4 — unchanged, not addressed here as instructed).

## 26. Known Limitations

Unchanged from the Phase 4 audit: no trailing take-profit, no
Degen/Bigcap/AI-scoring variants, cosmetic `bps` display label on
`intent.fee`. Additionally now known: no fork-testing capability exists
in this repository as currently configured.

## 27. Parameter Calibration

Not in scope for this phase (explicitly excluded — §31 of the task
instructions). Unchanged from Phase 4: `MULTI_MIN_MARKET_CAP_USD`,
`MULTI_MIN_TOKEN_AGE_HOURS`, `MULTI_TOP_N`, `MULTI_RANGE_PERCENT`, pool
score weights, `MULTI_TP_PERCENT`/`MULTI_SL_PERCENT`, and
`MULTI_MAX_EXPOSURE_USD` all remain their Phase 4 defaults, unmodified,
unoptimized.

## 28. Final Verdict

**PASS WITH BLOCKED LIVE VALIDATION**

Rationale, mapped against the task's own pass criteria:

| Criterion | Status |
|---|---|
| MULTI candidate pipeline works | **PASS — validated live**, real data |
| Filter order correct | **PASS — validated live** |
| Top 10 correct | **PASS — validated live** |
| USDG address verified | Address-vs-symbol logic **PASS** (code+test); on-chain existence check **BLOCKED** |
| Fee unit convention verified against real state | Protocol-definition-level **PASS** (verified against Uniswap V3's own fee-unit spec + this codebase's existing consistent usage); live-pool-instance check **BLOCKED** |
| Preferred fee tiers correctly handled, never forced | **PASS** (code+test) |
| Pool discovery works | **PARTIAL** — off-chain discovery **PASS** (live), on-chain validation **BLOCKED**, and correctly fails closed when blocked (**verified live**) |
| Pool scoring works | **PASS** (code+test only — real data BLOCKED) |
| Single-sided range verified | **PASS** (code+test; real-state BLOCKED) |
| Both token orientations work | **PASS** (code+test) |
| Executable quote / price impact / simulation / gas | **BLOCKED** (chain 4663 RPC unreachable) |
| Execution boundary preserved | **PASS — re-verified** |
| Transaction journal integration | **PASS** at the shared-infrastructure level (traced, unchanged); real-attempt BLOCKED |
| Accounting metadata works | **PASS** (verified live for the failure path; success path by code+test) |
| Dry-run produces zero broadcasts | **PASS — verified live** |
| No real capital used | **PASS — confirmed**: zero transactions, zero wallet writes, zero broadcasts across all of this phase's work |
| No critical test remains unexplained | **PASS** — every BLOCKED item has a specific, evidenced reason (§20, §22); nothing was hidden or silently downgraded |

This is not a full PASS because a materially important slice — everything
that requires reading real chain-4663 state — could not be exercised due
to a verified environment/network limitation outside this codebase's
control, not a defect within it. Wherever the RPC block was partially
crossed (pool discovery), the code's fail-closed behavior was directly
observed and held correctly. One real (pre-existing, non-MULTI,
Windows-only) bug was found, documented, and left unfixed as instructed.

**PASS does not mean profitable. PASS does not mean production-ready.**
Before live capital: (1) fix or work around BUG-001 if deploying on
Windows, (2) re-run the BLOCKED sections of this report from a network
with real access to chain 4663 (or a fork sourced from one), and (3)
complete the parameter calibration already flagged in the Phase 4 audit.

---

# PHASE 4.5.1 — Cleanup and Fixes

This follow-up phase fixed BUG-001 (the Windows `gmgn-cli` issue from §22
above), removed the stray `tatus` artifact, added regression coverage, and
re-ran the full validation suite. No MULTI parameters, no new strategies,
and no safety architecture were touched.

## Windows Issue — Root Cause (Recap and Precise Diagnosis)

The original code called Node's `execFile(cliPath(), args)` with no
`shell` option. On Windows, a global npm install of `gmgn-cli` produces a
`.cmd` shim (confirmed: `gmgn-cli`, `gmgn-cli.cmd`, `gmgn-cli.ps1` all
present in the npm global bin directory). Empirically verified, in order:

1. `execFile('gmgn-cli', args)` (bare name, no shell) → **`ENOENT`**. Windows'
   `CreateProcess` performs no `PATHEXT`-style extension resolution the way
   a shell does, so the bare name is never found.
2. `execFile('gmgn-cli.cmd', args)` (explicit `.cmd` extension, still no
   shell) → **`EINVAL`**. This is not a resolution problem — Windows'
   `CreateProcess` fundamentally cannot execute a `.bat`/`.cmd` file as a
   primary process image; only `cmd.exe` can. Node deliberately rejects
   this rather than silently misbehaving.
3. `execFile('gmgn-cli', args, { shell: true })` → succeeds, **but is
   exploitable**. Empirical adversarial testing (six shell-metacharacter
   payloads embedded in an argument value) showed Node's `shell: true`
   does **not** safely escape array arguments for `cmd.exe` — it warns
   explicitly ("arguments are not escaped, only concatenated") and two of
   the six payloads (`&`, `|`) successfully broke out and created files on
   disk. **This confirms the original code's security-rule comment was
   correct to avoid a shell string — the mistake would have been adding
   naive `shell: true`, not the missing Windows support.**

## Fix

Replaced the hand-rolled `execFile`+`shell:true` idea with **`cross-spawn`**
(a small, widely-used, actively maintained package — 100M+ weekly
downloads, used internally by npm itself — built specifically to solve
"launch a `.bat`/`.cmd` file on Windows without a shell-injection hole").
`cross-spawn` is used identically on every platform: it is a no-op passthrough
to a normal `spawn()` on POSIX (no shell involved, matching the original
POSIX-safe behavior exactly), and on Windows it transparently launches
through `cmd.exe` with its own argument-escaping logic.

**This was not blindly trusted.** The same six-payload adversarial battery
was re-run against `cross-spawn` directly: 5 of 6 were neutralized, but
**one gap remained** — a literal double-quote (`"`) combined with `&` still
broke out (`safe" & echo INJ4 > cs_inj4.txt & "`). Rather than accept a
partial fix or attempt to patch `cross-spawn`'s internal escaping (out of
scope — it's an external, independently-maintained dependency), a second,
independent layer was added:

**`assertSafeCliArg()`** — a defense-in-depth allowlist gate inside
`gmgnJson()` itself (`src/gmgn/cli.ts`), applied to every argument
immediately before it reaches the process boundary, regardless of which
spawn mechanism is used underneath. It rejects any argument containing
`" ` `` ` `` `$ & | ; < > ^ % ! \r \n` outright, throwing a
`GmgnError('...', undefined, 'GMGN_CLI_INVALID_INPUT')` **before the
process is ever spawned**. No legitimate gmgn-cli argument in this
codebase (chain name, `0x`-address, numeric value, order id, `orderBy`
field) ever needs any of these characters — confirmed by auditing every
existing call site, all of which already independently validate their
inputs (address regex, numeric coercion, order-id regex, hardcoded chain
enums) before reaching `gmgnJson()`. This closes the residual gap
completely and permanently, independent of whatever `cross-spawn` (or any
future spawn mechanism) does internally.

Net result: **two independent layers** — (1) `cross-spawn` for correct,
mostly-safe cross-platform launching, and (2) a strict argument allowlist
that makes the one remaining gap in (1) unreachable in practice. Verified
by re-running the full adversarial battery against the actual shipped
code path — zero injected files, on every payload.

## Platform-Aware Invocation

No `process.platform` branching was added to this codebase's own code.
`cross-spawn` handles the Windows/POSIX difference internally and
transparently; `runGmgnProcess()` (the new wrapper around it) is identical
on every platform. This matches the task's "platform-aware executable
invocation" requirement without introducing a maintenance burden of two
code paths to keep in sync — the platform-specific complexity is
delegated to a purpose-built, independently-tested library instead of
hand-rolled.

## Security Implications

- No shell command string is ever constructed by concatenating/interpolating
  values — arguments remain a structured array end-to-end (security rule 1,
  preserved).
- `GMGN_CLI_PATH` (operator/deployment config, not attacker-controlled)
  is unaffected by the argument allowlist — only the `args` array (which
  can carry GMGN-API-derived or future caller-supplied values) is checked.
- The allowlist is a hard rejection (throws), not a sanitize-and-continue —
  a value that would need escaping is refused outright rather than
  "cleaned up" and passed through, which is the safer failure mode.
- No new attack surface was introduced: `cross-spawn` has zero reported
  vulnerabilities in `npm audit` (confirmed — the 31 pre-existing
  vulnerabilities in this project's dependency tree, all inherited
  transitively through the old `hardhat` toolchain pulled in by
  `@uniswap/v3-sdk` → `@uniswap/swap-router-contracts`, are unrelated and
  pre-date this change).

## Error Handling — Explicit, Distinguishable Failure States

`GmgnError` now carries a machine-checkable `code: GmgnErrorCode` field
(optional third constructor parameter, fully backward compatible — every
pre-existing call site across `src/gmgn/swap.ts` and `src/gmgn/cli.ts`
that constructs a bare `GmgnError(message)` continues to work unchanged,
defaulting to a generic `'GMGN_ERROR'` code):

| Code | When |
|---|---|
| `GMGN_CLI_NOT_FOUND` | `ENOENT` — binary not found |
| `GMGN_CLI_TIMEOUT` | Process killed after exceeding its timeout |
| `GMGN_CLI_NONZERO_EXIT` | Process exited with a non-zero code (either from the OS-level exit code, or from the `{code, data}` JSON envelope's own error code) |
| `GMGN_CLI_EXEC_FAILED` | Any other process-launch failure not otherwise classified |
| `GMGN_CLI_EMPTY_OUTPUT` | Process exited 0 but produced no stdout |
| `GMGN_CLI_MALFORMED_OUTPUT` | stdout was not valid JSON |
| `GMGN_CLI_RATE_LIMITED` | 429 / rate-limit text detected (existing `GmgnRateLimitError`, now also tagged with this code) |
| `GMGN_CLI_AUTH_FAILED` | Auth/API-key failure text detected |
| `GMGN_CLI_INVALID_INPUT` | The new argument-allowlist gate rejected a value |

**Candidate-absence vs. candidate-source-failure, made distinguishable end
to end:** `fetchAndFilterCandidates()` (`src/strategy/multiCandidates.ts`)
now returns an optional `sourceError: { code, message }` field, populated
only when the fetch itself threw — a genuinely successful fetch that
simply returned zero trending tokens still returns
`{candidates: [], sourceError: undefined}`, but a broken integration
returns `{candidates: [], sourceError: {code: 'GMGN_CLI_NOT_FOUND', ...}}`.
This propagates through `MultiStrategyRun.sourceError`
(`src/strategy/types.ts`) into the Telegram `/multi` report
(`src/bot/bot.ts`'s `formatMultiReport`), which now renders a distinct
`⚠️ CANDIDATE SOURCE FAILED (<code>)` message instead of silently showing
"0 eligible candidates" when the source itself is broken — closing the
exact "unacceptable" behavior called out in the task (§4).

This is strictly additive: the previous, always-fails-closed contract
(`{candidates: [], rejected: []}`, never throws to the caller) is
unchanged — `sourceError` is new, optional information layered on top, not
a behavior change to any existing caller that doesn't check it.

## Cross-Platform Tests

New file `test/gmgnCli.test.ts` (18 tests), two kinds of coverage:

1. **Real, unmocked spawn tests** via the exported `runGmgnProcess()`,
   using `process.execPath` (the Node binary itself) as a stand-in "CLI" —
   this exercises the actual, real cross-platform spawn mechanism (the
   exact class of bug that caused BUG-001 in the first place) without
   requiring gmgn-cli to be installed in CI: successful execution +
   captured stdout, non-zero exit with the real exit code, `ENOENT` for a
   nonexistent binary, timeout-kills-the-real-process, and
   maxBuffer-exceeded. These ran for real on this Windows sandbox as part
   of this validation (all 5 passed) and will run for real on Linux/macOS
   CI too, since `node` exists everywhere and the wrapper has no
   platform-conditional code of its own.
2. **Deterministic, mocked-runner tests** of `gmgnJson()`'s classification
   logic via its new `runner` injection option: CLI success (bare JSON and
   `{code,data}`-enveloped), not-found, timeout, non-zero exit,
   malformed output, empty output, rate-limited, auth-failed, an
   unclassified generic failure, an enveloped non-zero application error,
   and both the positive and negative cases of the new argument-allowlist
   gate (a metacharacter payload is rejected *and the mocked runner is
   never invoked*; ordinary address/chain/numeric values pass through
   unaffected).

Plus two new tests in `test/strategy.multiCandidates.test.ts` proving the
strategy-layer half of the distinguishability guarantee: a source failure
sets `sourceError`, a genuinely empty-but-successful fetch does not, and a
`GmgnError`'s specific code propagates through unchanged.

**No test performs any GMGN trading action.** Every test either mocks the
runner/fetcher or spawns a harmless, argument-free Node one-liner — no
`swap`/`order`/`multi-swap` subcommand is ever constructed anywhere in this
test suite or in the fix itself.

## Stray `tatus` Artifact

Confirmed tracked (`git ls-files | grep tatus` → `tatus`), committed in
`8396b44` — raw `git diff` output with ANSI escape codes, consistent with
an accidental `git diff > tatus` (a truncated `... > status`typo). Not
related to MULTI or any of this session's work. Removed via
`git rm tatus` (a normal, reversible working-tree/index change — no
history rewrite, no `reset --hard`, no force-push; the removal is staged,
not yet committed, per instructions).

## Other Accidental Files — Search Result

Swept the full tracked file list (`git ls-files`) at the repo root and in
`data/`, `scripts/`, `tasks/`. Findings:

- `tatus` — the one confirmed accidental artifact (removed, above).
- `scripts/debug-*.ts`, `scripts/README.md`, `tasks/todo.md` — pre-existing,
  legitimate project developer tooling/notes, not artifacts of any recent
  session. Left untouched.
- No `.env`, no private keys, no `.pem` files, no credentials, no logs are
  tracked. `src/wallet/keys.ts` matched a "key" search only because of its
  filename — it is wallet-key-management *source code*, not a key file.
- `data/` contains only `.gitkeep` (tracked) — no wallet files were left
  behind by this session (a stray auto-generated hot wallet created by an
  earlier ad-hoc validation script in Phase 4.5 was already identified and
  deleted in that same session, before this phase began).

Nothing was deleted without first confirming it against the above
criteria; nothing legitimate was touched.

## Test Results (Phase 4.5.1)

```
Unit:        250/250 passing (230 from Phase 4/4.5 baseline + 18 new
             gmgnCli.test.ts + 2 new candidate-source-distinguishability tests)
Typecheck:   clean (tsc --noEmit)
Build:       clean (tsc)
Integration: re-run this phase; see below for classification
```

`npm run test:integration` was re-run in full: **2 passed, 1 timed out**
(`live RPC: getExecutableQuoteV3 succeeds against a real pool and matches
an independent full-tick-range cross-check` — `'test timed out after
300000ms'`, total suite duration ~1,158s). As in Phase 4.5, this suite
targets chain 8453 (Base) via `test/integration/quote.rpc.test.ts` — a
pre-existing Phase 2 test, unrelated to MULTI or to this phase's fix — and
is independently rate-limited against Base's public RPC (dozens of
`ticks rate-limited, retry N/10` lines precede the timeout; a `tickBitmap`
cross-check in the same run did succeed with a real on-chain result:
`amountOut=120444082` over 528 ticks). Classification:
**RPC ISSUE / ENVIRONMENT ISSUE**, not a code regression — this is the same
pre-existing flakiness documented in Phase 4.5, reproduced again
independently, with the same 2-pass/1-timeout shape as prior runs this
session. No failure in this suite touches `gmgn-cli`, chain 4663, or
any MULTI code path.

## MULTI Regression Verification

Re-confirmed unchanged by direct inspection (not merely "no diff shown" —
each value was read from the current source):

| Parameter | Current value | File |
|---|---|---|
| MC >= $1M | `minMarketCapUsd: envNum('MULTI_MIN_MARKET_CAP_USD', 1_000_000)` | `src/strategy/multiConfig.ts` |
| Age >= 24h | `minTokenAgeHours: envNum('MULTI_MIN_TOKEN_AGE_HOURS', 24)` | same |
| GMGN 6h | `interval: '6h'` (hardcoded) | same |
| Top 10 after filtering | `topN: envNum('MULTI_TOP_N', 10)`, applied after `ranked.slice(0, topN)` | `src/strategy/multiCandidates.ts` |
| volume6h sorting | `compareCandidates()` — unchanged | same |
| USDG address validation | `isUsdgPool()` / risk-gate `NOT_USDG` — contract-address comparison, unchanged | `src/strategy/multiPool.ts`, `multiRisk.ts` |
| Preferred fee tiers `[50_000, 40_000, 30_000]` | Unchanged (verified: this was the Phase 4 fix; not touched again this phase) | `src/strategy/multiPool.ts` |
| Pool scoring | `scoreMultiPool()` — unchanged | same |
| Single-sided range | `computeMultiRange()` — unchanged | `src/strategy/multiRange.ts` |
| -50% target | `rangePercent: envNum('MULTI_RANGE_PERCENT', 50)` — unchanged | `src/strategy/multiConfig.ts` |
| Risk gates | `runRiskGate()` — unchanged | `src/strategy/multiRisk.ts` |
| Execution boundary | Re-verified: `grep -rn "sendTransaction\|writeContract\|walletClient\." src/strategy/` → zero matches (unchanged from Phase 4) | — |
| Journal | Unchanged — still the shared `chain/clients.ts` wrapping, untouched this phase | — |
| Accounting | Unchanged — `executeTradeIntent`'s `recordLedger`/`recordMultiPositionMeta` calls untouched this phase (only the unrelated `sourceError` passthrough was added to `runMultiStrategy`'s return value, which has no accounting side effects) | `src/strategy/multiExecute.ts` |

**Only files touched this phase**: `src/gmgn/cli.ts` (the fix),
`src/strategy/multiCandidates.ts` (sourceError plumbing only — filter
logic itself untouched), `src/strategy/types.ts` (added an optional field),
`src/strategy/multiExecute.ts` (one-line passthrough of the new field),
`src/bot/bot.ts` (report display for `sourceError`), `package.json` /
`package-lock.json` (the new `cross-spawn` dependency), plus new/updated
test files. No MULTI filter, scoring, range, risk-gate, or execution logic
was modified.

## Safety Regression Sweep

```
grep -rn "minOut\s*=\s*0\|amount0Min\s*=\s*0\|amount1Min\s*=\s*0" src/
```
Three matches, all pre-existing and unrelated to this phase:

- `src/chain/mint.ts:381-382` — `amount0Min = 0n; amount1Min = 0n;` for a
  **new single-sided mint** (not a swap or withdrawal). This is correct,
  pre-existing Phase 1/2 design: minting a brand-new position has no prior
  "expected received amount" to slippage-protect the way a swap does;
  protection instead comes from `assertOutOfRange()` (checked twice —
  before building the mint params and again immediately before submit) to
  guarantee the position is genuinely single-sided, and from
  `amount0Desired`/`amount1Desired` being independently derived (one is
  genuinely, intentionally zero). Already covered by
  `test/safety.test.ts`'s "a genuinely single-sided position keeps a SAFE
  zero on the empty side." Untouched this phase.
- Two comments in `close.ts`/`v4.ts` explicitly documenting that the code
  *never* falls back to this pattern for withdrawals — i.e., these are the
  safety guarantees, not violations of them.

No other regressions found:
- `UNKNOWN → 0`: no matches anywhere in `src/`.
- `sendTransaction`/`writeContract`/`walletClient.`: zero matches in
  `src/strategy/` (execution boundary intact).
- Simulation/quote/gas failure → broadcast: `executeTradeIntent`'s
  `mintFn` call is still wrapped in the same try/catch returning
  `{skipped: true, reason: 'SIMULATION_FAILED'}` on any failure — untouched
  this phase, and re-confirmed passing by the existing regression test
  ("a mintFn failure ... is caught and reported as SIMULATION_FAILED").
- Unresolved/unknown transaction → retry/broadcast: `checkPendingTransaction`
  and the tx-journal/recovery logic in `chain/clients.ts` are untouched
  this phase.

**No safety regression found.**

## Remaining RPC Block (Unchanged)

Chain 4663 (Robinhood)'s RPC remains unreachable from this sandbox for the
same reason documented in §20 of Phase 4.5 (local ISP DNS interception,
root-caused via `nslookup`/`ping`, isolated to this one hostname). This
phase did not attempt to re-test that — it is an unrelated, already
thoroughly-documented environment limitation, not something the
Windows-gmgn-cli fix could or should affect (GMGN's data API is a separate
service from this project's own blockchain RPC).

## Final Verdict (Phase 4.5.1)

**PASS WITH BLOCKED LIVE VALIDATION**

- Windows GMGN CLI now works correctly — verified with a real,
  non-mocked, end-to-end run of the actual production code path
  (`fetchAndFilterCandidates()` with its default fetcher, no injection),
  fetching real live GMGN data for chain 4663 and reproducing the same
  10-selected/40-rejected result as Phase 4.5's workaround-based run.
- Unix behavior is unaffected — `cross-spawn` is a no-op passthrough to a
  normal, shell-less `spawn()` on POSIX, identical to the original
  `execFile()` behavior there.
- CLI failures are now explicit and distinguishable
  (`GmgnErrorCode` + `MultiStrategyRun.sourceError`), verified by 20 new
  tests (18 in `gmgnCli.test.ts`, 2 in `strategy.multiCandidates.test.ts`).
- No shell-injection vulnerability: two independent layers verified
  against a six-payload adversarial battery, with the one gap found in
  layer one (`cross-spawn`) fully closed by layer two (the argument
  allowlist) — re-verified against the actual shipped code.
- Stray `tatus` artifact removed (staged, not yet committed).
- No other accidental files found.
- Unit tests: 250/250 passing. Typecheck: clean. Build: clean.
- No safety regression: execution boundary, single-sided-mint zero-min
  pattern (pre-existing and correct), and unresolved-transaction handling
  all re-verified unchanged.
- Chain 4663's RPC remains inaccessible from this sandbox (unrelated,
  already-documented environment limitation) — full live-network
  validation of pool/quote/simulation/gas/journal against real chain state
  remains BLOCKED, exactly as in Phase 4.5.

Nothing was committed or pushed. `git status` / `git diff --stat` / full
`git diff` for this phase's changes are available in the terminal output
of this session for review before any commit.

# PHASE 2 (Part 2) — Real Executable Quote Hardening

Scope: local V3 swap quoting only, per explicit instruction. No MULTI. No
changes to GMGN screening, candidate strategy, MC filters, token age, range
strategy, TP/SL thresholds, position sizing, strategy parameters, or the
Phase 2 Part 1 slippage constants (`DEFAULT_SWAP_SLIPPAGE_BPS`,
`CLOSE_SLIPPAGE_BPS` — both untouched).

## 1. Current Quote Architecture (before this pass — audit findings)

Audited before writing any code, per the brief's explicit "do not code
immediately" instruction:

- **No Quoter / QuoterV2 contract address exists anywhere in this repo's
  config** (`src/config.ts`'s `CHAINS` map has `factory`, `npm`,
  `swapRouter02`, `v4PoolManager`, `v4PositionManager`, `v4StateView` per
  chain — no `quoter` field, for Robinhood Chain (4663), BSC (56), or Base
  (8453)). Grepped the whole `src/` tree for `Quoter`/`quoter` — zero hits
  before this pass.
- The local V3 swap path (`swap.ts`) computed its expected output via
  `estimateAmountOut()` — a slot0-only formula
  (`outHuman = amountInHuman * (sqrtPriceX96/2^96)^2`) that assumes
  constant liquidity and price across the entire trade. Its own doc
  comment already flagged this: *"Rough amountOut from slot0 (no
  tick-crossing). Good enough for minOut floor."* — which Phase 1 had
  already flagged as no longer good enough once tick-crossing matters.
- This estimate fed directly into `computeSwapMinOut()` (Phase 1's
  fail-closed minOut floor) and into `priceImpact.ts`'s impact check —
  i.e. a systematically-inaccurate number was the basis for both the
  minimum-output floor and the price-impact sanity gate.
- The Trading API (`tradingApi.ts`), GMGN (`gmgn/swap.ts`), Relay
  (`relay.ts`) and Across (`across.ts`) paths were unaffected — they
  already get a real quote from their own backend and were out of scope
  for this pass (confirmed by re-reading each; no rough-estimate quoting
  exists there).
- `@uniswap/v3-sdk` (already a dependency, already used for position math
  in `positions.ts`/`close.ts`/`v4.ts`) exports `Pool`, `TickListDataProvider`,
  `TickDataProvider`, `TickMath` — the actual protocol swap math, but
  no built-in RPC-fetching layer (SDK is chain-agnostic).

## 2. Determining the Actual Protocol / Execution Path

- Local swap execution (`swap.ts`: `previewSwapToNative`,
  `swapTokenToNative`, `swapExactInLocal`, `swapExactIn`, `swapFlexible`)
  is **exclusively Uniswap V3** (and PancakeSwap V3, same ABI/math family)
  — `factoryAbi`/`poolAbi`/`SwapRouter02`/PCS router. No V4 execution
  exists in this local path.
- `v4.ts` has no local swap execution at all — it's mint/close/collect
  for V4 LP positions only. V4 swaps (when they happen) go through the
  Trading API, which is out of this pass's scope (real quote already,
  per item 1).
- **Conclusion, matching the brief's own fallback instruction**: local
  swap path is V3-only → this pass focused exclusively on V3. No V4 quote
  work was needed or done.

## 3. New Executable Quote Mechanism

Per the brief's explicit prohibition on inventing a contract address or
ABI from assumption, and given no Quoter contract is configured for any
of the three chains, this pass implements a **protocol-native simulation**
(the alternative the brief's own PASS criteria explicitly allow: *"uses a
real executable quote **or a clearly justified protocol-native
simulation**"*) rather than a live Quoter contract call:

- **`src/chain/quote.ts`** — `getExecutableQuoteV3()`: fetches live pool
  state (`slot0`, `liquidity`, `tickSpacing`, `token0`/`token1`/`fee` — all
  from the pool contract already resolved by the existing route-finding
  code, no new address), then runs the actual swap math via
  `@uniswap/v3-sdk`'s `Pool.getOutputAmount()` — the same math the on-chain
  pool contract runs, fed with a **live, on-demand `TickDataProvider`**.
- **`src/chain/tickBitmap.ts`** — a pure port of Uniswap V3 core's
  `TickBitmap.position()`/`nextInitializedTickWithinOneWord()` — the exact,
  immutable, standard library every V3 fork implements (this is math, not
  a contract address; reproducing it isn't "inventing" anything, it's the
  published protocol spec). This is what lets the tick-crossing walk fetch
  only the bitmap words/ticks a given trade actually needs, rather than
  requiring a whole-pool upfront tick scan (which v3-sdk's own
  `TickListDataProvider` would require — see "why not TickListDataProvider"
  below).
- **`RpcTickDataProvider`** (in `quote.ts`) implements v3-sdk's
  `TickDataProvider` interface by calling the pool's own `tickBitmap(int16)`
  and `ticks(int24)` views live, on demand, exactly as the on-chain pool
  itself would when crossing a tick during a real swap — with each
  bitmap word cached within one quote call and a hard cap
  (`MAX_WORD_FETCHES = 20`) so a pathological trade fails closed instead of
  scanning indefinitely.

### Why not `TickListDataProvider` (v3-sdk's built-in array-based provider)?

Investigated first, rejected: `TickListDataProvider`/`TickList.validateList`
enforces an invariant that the supplied ticks' `liquidityNet` values sum to
exactly zero. That's only true over a pool's **entire** tick range — a
bounded window of "nearby" ticks (which is all that's affordable to fetch
per quote without hammering RPC) generically does *not* sum to zero, so
`TickListDataProvider` would throw on construction for any partial window.
The on-demand `TickDataProvider` interface has no such constraint (it's a
lazy interface, not a pre-validated array), which is exactly what makes it
the right fit for RPC-bounded, per-trade fetching. `TickListDataProvider`
*is* used, deliberately, in the test suite (see item 11) with a small
hand-crafted, ZERO_NET-satisfying tick set — that's the right tool for a
synthetic, fully-known test scenario, just not for a live, unbounded pool.

## 4. Contract / Address / ABI Used

No new contract address anywhere. Only the pool contract already resolved
by existing route-finding code (`findBestPool`/`findRouteToWrapped`/
`findRouteTokenToToken`, unchanged). One new ABI entry added to the
existing `poolAbi` in `src/chain/abis.ts`:

```
tickBitmap(int16 wordPosition) view returns (uint256)
```

This is part of the standard, immutable `IUniswapV3PoolState` interface —
the same interface these pools already expose for `slot0`/`liquidity`/
`ticks` (all already used elsewhere in this repo before this pass). Not
speculative; it's the real ABI of the real, already-addressed pool
contracts.

## 5. Quote Validation

`getExecutableQuoteV3` returns a discriminated `QuoteResult`:

```ts
type QuoteResult =
  | { ok: true; amountOut: bigint; quotedAt: number; source: 'v3-pool-simulation';
      poolAddress; tokenIn; tokenOut; fee; amountIn;
      sqrtPriceX96Before; sqrtPriceX96After; tickBefore; tickAfter }
  | { ok: false; code: QuoteErrorCode; reason: string };

type QuoteErrorCode =
  | 'TRANSIENT_RPC_ERROR' | 'QUOTE_UNAVAILABLE' | 'INVALID_QUOTE'
  | 'POOL_STATE_ERROR' | 'CONTRACT_REVERT' | 'SAFETY_ERROR';
```

Validated before a quote can be `ok: true` (Section 17's explicit list):

- `amountIn > 0`, `tokenIn !== tokenOut` (`INVALID_QUOTE` otherwise)
- Pool state readable (`slot0`, `liquidity`, `tickSpacing`, `token0`/`token1`/`fee`) — RPC failure → `POOL_STATE_ERROR`
- `sqrtPriceX96 > 0` (uninitialized pool guard) — `POOL_STATE_ERROR`
- **Route/pool/direction/fee consistency**: the pool's actual `token0`/`token1`/`fee` must match the requested `tokenIn`/`tokenOut`/`fee` — mismatch → `INVALID_QUOTE` (this is Section 12's "quote vs execution consistency" gate)
- Simulation itself succeeds (tick-walk within `MAX_WORD_FETCHES`, no math error) — failure → `QUOTE_UNAVAILABLE`
- `amountOut > 0` and finite — `INVALID_QUOTE` otherwise
- **Malformed-quote sanity ceiling**: simulated execution price must be within 6 orders of magnitude of the pool's own mid price (`isImplausibleExecutionPrice`, pure, tested) — catches a gross unit/direction/decimal bug; deliberately *not* a slippage judgement (that stays priceImpact.ts's job, unchanged threshold)

**No fallback**: every failure branch returns `ok: false`; both call sites
(`previewSwapToNative`, `swapExactInLocal`) throw `SafetyError` immediately
on `!q.ok` — there is no code path that catches a quote failure and
substitutes `estimateAmountOut()`'s rough number for capital execution.

## 6. Price Impact

Unchanged mechanism and unchanged threshold (`priceImpact.ts`,
`MAX_PRICE_IMPACT_BPS = 1000`, 10%) — only the **source** of the `amountOut`
fed into it changed, from the rough slot0 formula to the real executable
quote (`checkPriceImpact({ ..., amountOut: estimatedOut })` where
`estimatedOut` is now `q.amountOut` from `getExecutableQuoteV3`). The gate
itself was not touched, not weakened.

## 7. Retry Behavior

Unchanged from Phase 1's already-fixed architecture, now feeding it a real
quote: each `withRetries` round independently calls `getExecutableQuoteV3`
fresh (both legs, for multi-hop), reruns the price-impact check, and
recomputes `minOut` via `computeSwapMinOut` — never reuses a stale quote
across rounds, and there is still no degrading-minOut list anywhere (single
value per round, as Phase 1 established).

## 8. Slippage Interaction

`DEFAULT_SWAP_SLIPPAGE_BPS`/`CLOSE_SLIPPAGE_BPS` values: **unchanged**.
`computeSwapMinOut()`/`computeWithdrawalMins()` (Phase 1's `safety.ts`)
remain the only path from an estimate to a minimum — this pass only
changed what feeds their `estimatedOut` input (real quote instead of rough
estimate); `safety.ts` itself was not modified except to add the new
`computeRealizedSlippageBps`-adjacent telemetry field wiring from Phase 2
Part 1 (unrelated to this pass's slippage-value question).

## 9. Fallback Policy

**No execution fallback**, as instructed. On `QuoteResult.ok === false` for
any reason (RPC failure, pool-mismatch, simulation error, implausible
result, exceeded word-fetch cap), both `previewSwapToNative` and
`swapExactInLocal` throw and abort — they do not call `estimateAmountOut()`
or otherwise substitute a rough number to keep the trade alive.
`estimateAmountOut()` itself is untouched and still exported, but its three
remaining call sites are confirmed display/sizing-only (see item 17 audit
below) — never in the path that constructs a `minOut` for an actual send.

## 10. Telemetry

Extended (not replaced) Phase 2 Part 1's `execution_telemetry` schema —
`estimatedRaw`/`minRaw`/`actualRaw` per leg are unchanged and still
populated exactly as before; added:

- `quoteSource` (row-level, e.g. `'v3-pool-simulation'` for the two
  hardened swap paths, `'v3-sdk-position-liquidity-math'` /
  `'v4-sdk-position-liquidity-math'` for close, labeling Phase 1's
  already-real withdrawal math for consistency)
- `quotedAt` (row-level, ms epoch)
- `route` (row-level, human-readable route label)
- `realizedSlippageBps` **per leg**, computed at record time via Phase 2
  Part 1's `computeRealizedSlippageBps(estimatedRaw, actualRaw)` — was
  previously only available as a standalone function; now actually stored
  on every recorded leg (null when `actualRaw` is null).

## 11. Tests

`npm test` — 70 tests, all passing (37 new since Phase 2 Part 1's 41):

- **`test/tickBitmap.test.ts`** (16 tests) — hand-verified vectors for
  `compressTick`/`bitmapPosition`/`mostSignificantBit`/`leastSignificantBit`/
  `computeNextInitializedTickWithinOneWord`: positive/negative ticks, word
  boundaries, all-bits-set/all-clear words, cross-word-boundary negative
  ticks. Every expected value was worked out by hand against the Solidity
  `TickBitmap` reference before being asserted (not derived from the
  implementation's own output).
- **`test/quote.test.ts`** (14 tests):
  - **Section 15's tick-crossing test**: constructs a real `Pool` (v3-sdk)
    with a thin current-tick liquidity range and a much deeper liquidity
    step a few tick-spacings away (using v3-sdk's own `TickListDataProvider`
    with a small, hand-crafted, ZERO_NET-valid tick set — independent of
    my `RpcTickDataProvider`/bitmap code, so this test doesn't just
    validate my own implementation against itself). Executes a trade large
    enough to cross into the deeper range, asserts the pool's tick actually
    moved past the boundary, and asserts the real quote diverges from the
    rough slot0-only formula (same formula as `estimateAmountOut`) by more
    than 1% — a real, measurable, non-trivial difference.
  - `sqrtPriceRatio`/`executionRatio`/`isImplausibleExecutionPrice`/
    `isQuoteStale` — pure unit tests covering the "malformed quote"/"stale
    quote" abort conditions (Section 16 items 4-5).
  - A cross-check test: my bitmap-based `computeNextInitializedTickWithinOneWord`
    agrees with a synthetic bitmap built independently from the same
    initialized-tick list, for the same search — an internal consistency
    check on the bitmap math itself.
- Phase 1 (32) and Phase 2 Part 1 (9, incl. `txLock`) tests: still 100%
  passing, unmodified — confirms `safety.ts`'s invariants and `txLock`'s
  serialization remain fully active (Section 16 items 11-12).

**Not covered by a runtime test** (documented per Section 15's own
allowance, "if a full chain test harness isn't available, document the
integration test needed" — this repo has none, consistent with Phase 1/2
Part 1's documented limitation):
- `getExecutableQuoteV3` and `RpcTickDataProvider` themselves are
  RPC-coupled (call `getPublicClient(chainId).readContract`) and are not
  independently unit tested end-to-end — there's no RPC mock/fork harness
  in this repo. **Integration test needed for a future phase**: run
  against an Anvil/Hardhat fork of Base or BSC with a known, real,
  concentrated-liquidity pool; assert `getExecutableQuoteV3`'s output
  matches (a) a direct on-chain `pool.swap()` static-call/trace result for
  the same input, and (b) diverges from `estimateAmountOut()` by a
  measurable amount for a trade sized to cross at least one tick boundary
  in that real pool.
- "quote = 0" / "quote unavailable" / "TRANSIENT_RPC_ERROR" as literal
  `getExecutableQuoteV3` return values aren't separately unit tested (would
  need RPC mocking); the *logic* that would produce them (`amountOut<=0n`
  guard, `POOL_STATE_ERROR`/`QUOTE_UNAVAILABLE` classification branches) is
  present and reviewed by inspection, structurally identical in shape to
  the already-tested `requireKnownAmount`/`SafetyError` pattern from
  Phase 1.

## 12. Test Results

```
tests 70
pass  70
fail  0
```
`npm run typecheck`: clean. `npm run build`: clean.

## 13. Remaining Risks

- The RPC-coupled `getExecutableQuoteV3`/`RpcTickDataProvider` path has no
  integration test against a real or forked chain (see item 11) — the
  bitmap/simulation *math* is well-tested in isolation, but the live
  wiring (correct ABI encoding of `int16`/`int24` args, correct handling
  of a real pool's actual bitmap layout) has only been exercised via
  `npm run typecheck`/`npm run build` type-checking, not a live call.
  Recommend a manual smoke test (one real swap on testnet or a small real
  trade) before relying on this in production, and the fork-based
  integration test from item 11 for a future phase.
- `MAX_WORD_FETCHES = 20` is a reasonable-but-unvalidated performance/safety
  bound — a legitimately large trade on a very thin pool could hit this cap
  and abort (fail closed, which is correct/safe) even though the trade
  might have been fine with a couple more word fetches. Not dangerous, but
  could cause avoidable aborts; worth revisiting with real telemetry.
- `LOCAL_QUOTE_MAX_AGE_MS = 20_000` is, per the brief's own instruction, an
  explicitly non-OOS-calibrated conservative starting point — same caveat
  as Phase 2 Part 1's slippage telemetry: needs real fill-timing data to
  validate.

## 14. Known Limitations

- Scope was V3-only by design (no local V4 swap path exists to harden —
  confirmed by audit, not assumed).
- The Trading API / GMGN / Relay / Across paths were not touched — they
  already quote from their own backend (established in Phase 1/2 Part 1)
  and were explicitly out of this pass's scope.
- No integration/fork test harness exists in this repo (Phase 1's
  documented limitation, still true) — see item 11 for what a future phase
  should add.
- `estimateAmountOut()` remains in the codebase, exported, used only by
  confirmed display/sizing call sites (`previewFlexibleSwap`'s local
  fallback display estimate, `ensureStableFromEth`'s WETH-price sizing
  fallback) — not deleted, since the brief explicitly permits keeping it
  for display/sizing/telemetry.

## 15. Final Verdict

**PASS**

- Local V3 capital execution (`previewSwapToNative`, `swapExactInLocal`,
  and transitively `swapTokenToNative`/`swapExactIn`/`swapFlexible`) now
  uses a real, protocol-native executable-quote simulation
  (`getExecutableQuoteV3`, `@uniswap/v3-sdk`'s actual swap math fed with
  live on-demand tick data) instead of the rough slot0-only formula — with
  no Quoter contract address invented, matching the "clearly justified
  protocol-native simulation" PASS criterion.
- Quote failure fails closed: every `QuoteResult.ok === false` case aborts
  via `SafetyError`, with no code path substituting the rough estimate for
  capital execution.
- No zero fallback: `amountOut <= 0` is rejected before it can reach
  `computeSwapMinOut`.
- Retry refreshes the quote every round (both legs, multi-hop included);
  no degrading-minOut path exists anywhere in the changed code.
- Quote and execution route are consistent: the simulated pool's actual
  `token0`/`token1`/`fee` are validated against the requested
  `tokenIn`/`tokenOut`/`fee` before a quote can succeed.
- `safety.ts`'s invariants (`computeSwapMinOut`, `computeWithdrawalMins`,
  `requirePositiveMinOut`, etc.) were not bypassed — all Phase 1 tests
  covering them still pass unmodified.
- `txLock` (Phase 2 Part 1) remains wired and active — untouched this pass,
  its tests still pass.
- Tests pass (70/70), typecheck passes, build passes.

This verdict covers the scope actually audited and changed — real
executable quote for the local V3 swap path. It does not extend to the
items explicitly deferred in Phase 2 Part 1 (gas estimation, tx
recovery journal, Trading API/GMGN/Relay/Across actual-output completion,
price-freshness typing beyond this pass's `quotedAt`/`isQuoteStale`), nor
to the live-RPC integration test noted as needed in item 11.

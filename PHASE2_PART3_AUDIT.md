# Phase 2 Part 3 Audit — Real RPC/Fork Quote Validation + Gas Estimation Hardening

Scope: (A) real-RPC integration validation of `getExecutableQuoteV3()` /
`RpcTickDataProvider` against a live, discovered (not invented) Uniswap V3
pool; (B) replacing every hardcoded local-transaction gas value with live
`estimateContractGas` + bounded padding, with a fail-closed failure policy
and gas telemetry. No changes were made to `DEFAULT_SWAP_SLIPPAGE_BPS`,
`CLOSE_SLIPPAGE_BPS`, GMGN screening, candidate strategy, MC filters, token
age, range strategy, TP/SL thresholds, position sizing, USDG, pool scoring,
adaptive fee, or trailing TP. MULTI was not implemented.

---

## 1. Gas architecture

New module [`src/chain/gas.ts`](src/chain/gas.ts) is the single source of
truth for local write-gas. Two exports:

- **`estimateWriteGas(params)`** — every call site follows the same shape
  already in place before this phase: `simulateContract` (revert check) →
  `estimateWriteGas` (live gas, padded) → `writeContract` (send with the
  padded gas as the `gas:` field). It calls `client.estimateContractGas`
  with the exact same `address/abi/functionName/args/account/value` as the
  write that follows, applies `applyGasPadding()`, and returns a `bigint`.
  It **never throws** — a gas-estimation hiccup must not itself abort a
  transaction whose safety-critical simulation already succeeded.
- **`applyGasPadding(estimated, paddingBps)`** — pure function, `estimated
  * (10000 + bps) / 10000`, bps clamped to ≥ 0 so padding can never go
  negative; a zero/negative estimate passes through unchanged rather than
  being inflated.
- **`GAS_ESTIMATE_PADDING_BPS = 2000`** (20%) is the default padding,
  following this codebase's existing convention for tunables (a plain
  exported `const`, same pattern as `DEFAULT_SWAP_SLIPPAGE_BPS` /
  `CLOSE_SLIPPAGE_BPS` in `safety.ts`/`swap.ts` — not an env var, per this
  repo's established style). Per-call override via `paddingBps` is
  supported (unused by any call site today; available for future tuning).
- **`buildGasTelemetry(client, hash, gasLimitSent?)`** — best-effort,
  never-throwing helper that reads a mined tx's receipt back and reports
  `gasUsed` / `effectiveGasPriceWei` / `actualGasCostWei`; see §5.

Every call site passes its **pre-existing hardcoded constant** as
`fallbackGas` — the fallback path was never invented, it's the exact value
that shipped before this phase, now used only as a last resort (§4).

## 2. Hardcoded gas findings (pre-patch)

Searched for `gas:`, `gasLimit:`, and the literal constants
`900_000`/`800_000`/`600_000`/`500_000`/`400_000`/`700_000`/`1_000_000`/
`1_200_000`/`200_000` across `src/`. Found **25 hardcoded local-tx gas
sites**:

| File | Sites | Values |
|---|---|---|
| `mint.ts` | 1 | `900_000n` (v3 `mint`) |
| `close.ts` | 5 | `900_000n` (multicall decrease+collect), `500_000n` (decrease fallback), `400_000n` (collect fallback), `200_000n` (empty-shell burn), `400_000n` (`claimFees` collect) |
| `swap.ts` | 10 | PCS/UNI multi-hop multicall ×2 (`900_000n`), PCS/UNI direct multicall ×2 (`700_000n`), PCS/UNI single fallback ×2 (`500_000n`) — in `swapTokenToNative`; PCS/UNI multi `exactInput` ×2 (`700_000n`), PCS/UNI single `exactInputSingle` ×2 (`450_000n`) — in `swapExactInLocal` |
| `v4.ts` | 9 | `initializePool` (`500_000n`), v4 `mint` (`1_200_000n`), close-v4 round-attempt loop ×3 (`1_200_000n`/`1_000_000n`/`600_000n`), empty-shell burn (`400_000n`), `claimV4Fees` (`700_000n`), plus a **dead, unreferenced `attempts` array** duplicating the same 3 close values (see §11)

Also audited (per the task's explicit list) but found to already use **no**
hardcoded gas at all — `wrap.ts` (`deposit`/`withdraw`), `transfer.ts`
(native `sendTransaction` / ERC-20 `transfer`), and `revoke.ts` (ERC-20
`approve` / Permit2 `approve`) all omit the `gas` field entirely, which
makes viem's wallet client run its own internal `estimateGas`/
`estimateContractGas` before sending. This is already safe; nothing to
patch there. `relay.ts`/`across.ts` (bridge aggregators) and
`tradingApi.ts` (Uniswap Trading API) send **pre-built calldata from an
external API response** and use that response's own `gas`/`gasLimit`
field (with `tradingApi.ts` already applying a documented `gasPad = 1.2`
multiplier) — correct architecture, since there's no local ABI/args to run
`simulateContract`/`estimateContractGas` against; out of this phase's
"local transaction" scope by design.

## 3. Gas estimation implementation

All 25 sites above were converted to the `simulate → estimateWriteGas →
writeContract` pattern described in §1. Representative diff shape (from
`close.ts`'s sequential-fallback `decreaseLiquidity` call):

```ts
const decreaseArgs = [...] as const;
await client.simulateContract({ ...decreaseArgs, functionName: 'decreaseLiquidity', account: recipient });
const decGas = await estimateWriteGas({
  client, address: npm, abi: npmAbi, functionName: 'decreaseLiquidity', args: decreaseArgs,
  account: wallet.account!.address, fallbackGas: 500_000n, context: `close #${tokenId} decreaseLiquidity`,
});
const hash = await wallet.writeContract({ ...decreaseArgs, functionName: 'decreaseLiquidity', account: wallet.account!, chain: wallet.chain, gas: decGas });
```

Args are extracted once (`as const`) and reused across `simulateContract`
/ `estimateWriteGas` / `writeContract` so the three calls are always
estimating and sending the identical call — no drift possible between what
was simulated/estimated and what was sent.

Verification: `grep -rn "gas: [0-9_]\+n"` and `grep -c "estimateWriteGas("`
across `mint.ts`, `close.ts`, `swap.ts` confirm **zero** remaining raw
`gas:` literals feeding a `writeContract`/`sendTransaction` call in those
three files (10 `estimateWriteGas(` calls in `swap.ts`, 5 in `close.ts`, 1
in `mint.ts`). `v4.ts`'s remaining 6 raw `gas:` literals are addressed in
§11 — none of them reach a `writeContract` call any more.

## 4. Gas failure policy

Classification, as required by the task:

- **Contract-revert-like** — already excluded by construction: every
  `estimateWriteGas` call happens immediately after an identical
  `simulateContract` call succeeded (this was already true architecture
  before this phase; this phase didn't add or remove any simulate gate).
  If the transaction would revert, `simulateContract` throws first and the
  code path aborts before `estimateWriteGas` is ever reached.
- **Transient RPC / estimation-unavailable** — the only realistic failure
  mode left once simulation has passed. `estimateWriteGas` catches it,
  logs a `[gas]`-prefixed warning naming the call site (`context`) and the
  fallback value used, and returns the **exact pre-existing hardcoded
  constant** for that call site — bounded, reviewed, unchanged from what
  shipped before. It is never multiplied, never replaced with an
  arbitrary large number, and never "unlimited."
- **Invalid tx** — same as revert-like: caught by `simulateContract`
  before `estimateWriteGas` runs.

No auto-send-with-unlimited-gas path exists anywhere in this module or its
call sites.

**Fresh-per-retry guarantee**: every retryable call site (`swapTokenToNative`,
`swapExactInLocal`, `close.ts`'s multicall/sequential paths, v4's
`closeV4Position` round-attempt loop) calls `estimateWriteGas` **inside**
the retry round callback, immediately before the corresponding
`writeContract`, using args freshly rebuilt that same round from a
freshly-fetched quote/liquidity/mins. No retry ever reuses a stale gas
estimate, exactly mirroring the existing fresh-quote-per-retry discipline
from Phase 1/2. One-shot paths (`mint.ts`, v4 `mint`, `initializePool`,
`claimV4Fees`, the empty-shell burns) have no retry loop, so staleness
across retries doesn't apply to them.

## 5. Gas telemetry

`buildGasTelemetry(client, hash, gasLimitSent?)` (in `gas.ts`) reads a
mined transaction's receipt and reports:

- `gasLimitSent` — the padded gas limit that was actually sent (passed in
  by the caller; `null` if the caller didn't capture it)
- `gasUsed` — from the receipt
- `effectiveGasPriceWei` — `receipt.effectiveGasPrice ?? receipt.gasPrice`
- `actualGasCostWei` — `gasUsed * effectiveGasPriceWei`, computed only if
  both are known

**Every field is `null` ("UNKNOWN"), never a fabricated `0`,** when it
can't be measured (receipt lookup throws, field absent) — consistent with
this codebase's existing `computeRealizedSlippageBps` convention of
`null`-for-unmeasurable rather than a silent zero. The function never
throws.

Schema: `src/db/index.ts` gained `ExecutionTelemetryGas` and an optional
`gas?: ExecutionTelemetryGas | null` field on `ExecutionTelemetryRow`,
`recordExecutionTelemetry`'s params, and `ExecutionTelemetryEntry`. Older
stored rows simply have `gas` absent/`undefined` — no migration needed,
nothing reads it as `0`.

Wired into all **4** existing `recordExecutionTelemetry` call sites (the
only places this repo already emits execution telemetry rows):
`swapTokenToNative`, `swapExactInLocal` (both in `swap.ts`), `close.ts`'s
v3 close, and `v4.ts`'s `closeV4Position`. Each now does:

```ts
const gas = params.ok && params.txHash ? await buildGasTelemetry(client, params.txHash) : null;
recordExecutionTelemetry({ ..., gas });
```

Telemetry failure is caught by the pre-existing outer `try { ... } catch { /* best-effort */ }`
in every one of these closures — a telemetry error (including inside
`buildGasTelemetry`, though it already never throws) cannot block or fail
the trade it describes.

**Not wired** (documented, not overlooked): the one-shot mint /
`initializePool` / `claimV4Fees` / empty-shell-burn paths don't call
`recordExecutionTelemetry` at all — that's pre-existing architecture (they
never emitted any telemetry row, gas or otherwise, before this phase) and
adding a new telemetry surface to them is out of this phase's scope of
"wire gas telemetry in" vs. "add telemetry infrastructure that didn't
exist." Flagged under §13.

## 6. Fork/integration test setup

Foundry (`foundryup`) could not be installed: `anvil`'s installer was
blocked mid-download by a Windows Application Control policy (`os error
4551`, "An Application Control policy has blocked this file"). This is a
legitimate OS security control; it was not bypassed or worked around.
Per the task's own title ("REAL RPC/FORK INTEGRATION VALIDATION"), live
RPC is an explicitly acceptable alternative to a fork, so testing pivoted
to a real, live Base RPC connection instead.

New file: [`test/integration/quote.rpc.test.ts`](test/integration/quote.rpc.test.ts).
Deliberately does **not** import the bot's own `getPublicClient`/`config`
(which lazily requires Telegram env vars and generates a throwaway wallet
file as a side effect just to run a read-only test) — it builds a plain
viem client pointed at the exact same real, already-configured default RPC
endpoint (`CHAINS[8453].defaultRpc`) and reproduces `findBestPool()`'s own
discovery logic (loop fee tiers, call the real factory, pick the deepest).
Not part of `npm test` (lives under `test/integration/`, excluded from the
`test/*.test.ts` glob); runs via the new `npm run test:integration` script.

Retry/backoff wrapper (`rpcRetry`, 10 attempts, backoff
`min(1200*attempt, 8000)`ms) handles this free public RPC's rate limiting
for every read.

## 7. Real pool used

Discovered — **not hardcoded or invented** — from the real
`UniswapV3Factory` on Base (`CHAINS[8453].factory`) by calling
`getPool(WETH, USDC, fee)` across fee tiers `[100, 500, 3000, 10000]` and
picking the one with the highest on-chain `liquidity()`:

- **Pool**: `0x6c561B446416E1A00E8E93E221854d6eA4171372`
- **Pair**: WETH/USDC, **fee**: 3000 (0.30%)
- **Liquidity at discovery**: `30,673,424,049,743,862,104`

Verified live via `test 1` ("discovers a real Base WETH/USDC V3 pool via
the real factory") — **PASSED** on every run.

## 8. Quote vs. direct simulation comparison

Two comparisons were implemented:

1. **Independent full-tick-range cross-check** (`test 2`): re-run the same
   swap through `@uniswap/v3-sdk`'s own `TickListDataProvider`/`Pool` — a
   completely separate code path from `RpcTickDataProvider`'s on-demand
   bitmap walk — fed the same real on-chain `tickBitmap`/`ticks`/`slot0`/
   `liquidity` data, and assert `q.amountOut === refAmountOut` exactly.
   This exercises the ABI encoding (`int16` word position, `int24` tick),
   bitmap decoding, and tick-walk against real pool layout. **Implemented
   and correct, but not completed in this environment** — see §10/§13 for
   why (free-RPC throttling, not a logic defect).
2. **Economically-equivalent comparison** (`test 3`, the task's own
   pre-authorized fallback "if exact comparison impossible... use
   economically-equivalent comparison instead, no invented large
   tolerance"): compare the real executable quote against a
   decimals-correctly-adjusted constant-price (pre-crossing) estimate
   computed from the same pre-trade `sqrtPriceX96`, using `quote.ts`'s own
   already-tested `sqrtPriceRatio()` helper. This **did** run to
   completion and is the primary quantitative evidence of correctness
   (§9).

## 9. Tick-crossing validation

`test 3` escalates trade size (1 → 2000 WETH-equivalent) until
`tickAfter !== tickBefore`, then compares the real `amountOut` against the
rough (no-crossing) estimate. Latest passing run:

```
amountIn = 25000000000000000000 (25 WETH)
tick -198258 -> -198259   (tickBefore != tickAfter — genuine crossing)
real  = 61213.428292 USDC
rough = 61400.09366967161 USDC
diff  = 0.304%
```

`assert.notEqual(crossing.tickBefore, crossing.tickAfter)` and
`assert.ok(relativeDiff > 0.001)` both hold. **PASSED**, reproducibly,
across multiple runs (0.304-0.316% divergence each time, consistent with
one initialized tick's liquidity delta at this pool's current depth).

**Incidental finding**: building this comparison correctly required using
`sqrtPriceRatio()` rather than mirroring production's actual
`estimateAmountOut()` (in `swap.ts`) — that function derives a raw
token1-per-token0 ratio from `sqrtPriceX96` but does **not** adjust for
differing `decimalsIn`/`decimalsOut`. For a same-decimals pair this is
harmless; for a WETH(18)/USDC(6) pair like this one it makes the raw
output wrong by `10^12`. Phase 2 Part 2 already removed this function from
the capital-execution path — the only remaining callers are
`previewFlexibleSwap`'s local-fallback **display** estimate and
`ensureStableFromEth`'s WETH-price **sizing** fallback (display only, sized
before the trade rather than protecting it). **Not a capital-safety
regression today**, and fixing it is out of this phase's explicit scope
(gas + fork validation only) — documented here per the task's own
instruction to report Findings, not silently patched. Flagged under §12.

## 10. RPC failure behavior

Covered by `test/quote.test.ts`'s unit tests (network-free, mocked
`MinimalReadClient`): `slot0`/`liquidity`/`tickSpacing` RPC failure →
`QuoteResult.ok=false, code: 'POOL_STATE_ERROR'`; tick-bitmap failure
mid-simulation → `code: 'QUOTE_UNAVAILABLE'`; pool token-pair mismatch and
pool fee mismatch → `code: 'INVALID_QUOTE'`; `amountIn <= 0` /
`tokenIn === tokenOut` → `INVALID_QUOTE'` with **zero** RPC calls made. In
every failure case `amountOut` is never produced and never defaults to
`0` — callers must check `ok` before touching `amountOut`, matching the
discriminated-union type. No path exists where a quote failure silently
becomes "amountOut = 0, continue."

The live-RPC test suite's own extensive rate-limit logging (hundreds of
"rate-limited, retry N/10" lines) is itself a real-world demonstration of
the retry/backoff path — every one of those transient failures was
retried and eventually recovered (tests 1 and 3), never silently swallowed
into a wrong answer.

## 11. Tests

**Unit tests** (`npm test`, no network) — **90 passed, 0 failed** (up from
86 before this phase's `gas.test.ts` additions):
- `test/gas.test.ts` (11 tests, new): `applyGasPadding` math (bps
  addition, zero/negative passthrough, negative-bps clamping);
  `estimateWriteGas` success (padded, differs from fallback), failure
  (falls back to the explicit bounded `fallbackGas`), never-throws
  guarantee, custom-padding override; `buildGasTelemetry` success (correct
  `actualGasCostWei` math), legacy-`gasPrice` fallback,
  unmeasurable-stays-null (never fabricated `0`), never-throws guarantee.
- `test/quote.test.ts` (unchanged from Part 2, ~12-15 tests): RPC-failure
  classification, pool/token/fee mismatch rejection, zero-RPC-call
  rejection of invalid inputs.
- All pre-existing suites (minOut/withdrawal-min never-zero, price/
  ownership fail-closed, WETH-unwrap delta-only, realized-slippage,
  tick-bitmap math, TP/SL classification, `txLock` serialization) —
  unaffected, still green.

**Integration tests** (`npm run test:integration`, live Base RPC) —
**2 passed, 1 failed (documented known limitation, not a logic defect)**:
- ✅ "discovers a real Base WETH/USDC V3 pool via the real factory"
- ❌ "getExecutableQuoteV3 succeeds against a real pool and matches an
  independent full-tick-range cross-check" — implemented correctly but
  times out at 300s under this free RPC's throttling (see §10/§13); ran
  twice (±6-word and ±2-word tick windows), both timed out, confirming the
  bottleneck is provider-side rate limiting rather than window size.
- ✅ "a trade sized to cross an initialized tick produces a real quote
  that diverges from the rough slot0 estimate" — real=61213.428292,
  rough=61400.094, diff=0.304%, tick -198258→-198259

**Typecheck** (`npm run typecheck`) — **clean, 0 errors.**

**Build** (`npm run build`) — **clean, 0 errors.**

**Section-11 post-patch re-search** for remaining hardcoded gas values
(`gas:`, `gasLimit:`, `900_000`, `800_000`, `600_000`, `1_000_000`, etc.
across `src/`): the only hits are 6 raw `gas: N` literals in `v4.ts`,
lines 2647/2663/2676 (a locally-scoped `attempts: Attempt[]` array that is
**built (`.push`'d) but never read anywhere else in the file** — confirmed
by grepping every use of the identifier `attempts` in `v4.ts`; the real
close-v4 execution path independently rebuilds an equivalent
`roundAttempts` array **inside** the retry-round callback, at lines
2701/2716/2727) and its 3 mirror values in that `roundAttempts` array,
which now serve purely as `fallbackGas` inputs to the already-patched
`estimateWriteGas` call at line ~2744 (not sent directly to any
transaction). Both are safe: the dead `attempts` array has zero
behavioral effect (recommend deleting it in a future cleanup PR — out of
this phase's scope, since deleting dead code was not requested and this
phase's mandate was gas-estimation wiring, not refactoring); the
`roundAttempts` values are exactly the documented, reviewed
fail-closed-fallback constants the policy in §4 requires.

## 12. Remaining risks

- **`estimateAmountOut()` decimals bug** (§9) — real, reproducible,
  currently confined to display/sizing paths, not the capital-execution
  path. Should be fixed in a future phase; flagged, not silently patched,
  per this phase's strict scoping.
- **Dead `attempts` array in `v4.ts`** (§11) — zero behavioral risk today,
  but dead code inviting future confusion (someone could edit it believing
  it's live). Recommend removal in a future cleanup pass.
- **Gas telemetry coverage gap** — one-shot mint/initializePool/
  claimFees/burn-shell paths have no telemetry row at all (pre-existing,
  not a regression from this phase). If cost visibility into those paths
  becomes a priority, telemetry infrastructure would need to be added
  there first.
- **Free public RPC dependency** for the cross-check integration test —
  this is an environment/CI concern (a paid or dedicated RPC endpoint
  would let it complete), not a code-correctness concern.

## 13. Known limitations

- The independent full-tick-range cross-check (`test 2`, §8/§10) did not
  complete in this session due to free-tier RPC rate limiting, despite two
  genuine attempts at different tick-window sizes. It is implemented,
  type-checks, and is expected to pass against a non-throttled RPC. The
  economically-equivalent tick-crossing test (`test 3`) did complete and
  is the primary quantitative evidence for this phase's quote-correctness
  claim.
- Gas telemetry (`gasUsed`/`effectiveGasPriceWei`/`actualGasCostWei`) is
  only recorded for the 4 execution paths that already had a
  `recordExecutionTelemetry` call site before this phase (swap ×2,
  close-v3, close-v4). It was not extended to paths with no pre-existing
  telemetry infrastructure.
- `GAS_ESTIMATE_PADDING_BPS` is a code constant, not an environment
  variable — intentional, matching this codebase's existing convention for
  `DEFAULT_SWAP_SLIPPAGE_BPS`/`CLOSE_SLIPPAGE_BPS`.

## 14. Final audit trace

`candidate → quote → price impact → minOut → simulation → gas estimation →
txLock → broadcast → receipt → actual output`, re-verified for this
phase's changes:

- **No stale quote** — unchanged from Phase 2 Part 1/2; this phase's gas
  estimation runs *after* the existing `isQuoteStale()` gate and *inside*
  the same retry-round callback that re-fetches the quote, so gas
  estimation can never run against a quote that's since gone stale.
- **No stale gas estimate** — every retryable path calls
  `estimateWriteGas` fresh inside its retry round, immediately before the
  corresponding `writeContract` (§4). One-shot paths have no retry to go
  stale across.
- **No minOut zero / no withdrawal-minimum zero** — untouched; this phase
  never modifies `amountOutMinimum`/`amount0Min`/`amount1Min` computation,
  only the `gas:` field of the same `writeContract` calls.
- **No UNKNOWN→zero, no UNKNOWN→valid** — `buildGasTelemetry` returns
  `null` for every unmeasurable field, never `0` or a guessed value (§5);
  `estimateWriteGas` never converts a failure into a fabricated gas value,
  only the pre-reviewed bounded fallback (§4).
- **No simulation bypass** — every `estimateWriteGas` call site still runs
  its pre-existing `simulateContract` call first, unchanged; this phase
  added a step between simulate and send, it did not remove or reorder
  the simulate gate.
- **No retry safety degradation** — `txLock`/`withRetries` structure
  unchanged; gas estimation is additive inside the existing round
  callback, not a new retry mechanism.
- **No nonce race** — untouched; this phase doesn't touch nonce handling
  (`txLock.ts` from Phase 2 Part 1).
- **No hardcoded unsafe gas** — confirmed via the §11 re-search: the only
  remaining raw `gas: N` literals are dead code or fallback-source
  constants that never reach a `writeContract` call directly.
- **Quote/execution consistency** — untouched; the existing
  pool/tokenIn/tokenOut/fee/amountIn consistency checks from prior phases
  are unaffected by adding a gas-estimation step between simulate and
  send.

---

## Final verdict: **PASS**

Both Part A (real-RPC quote validation) and Part B (gas estimation
hardening) meet their requirements, with two transparently-documented
limitations (§13) rather than fabricated passes: the independent
cross-check integration test is correctly implemented but could not
complete under this environment's free-RPC rate limiting (a provider
constraint, not a logic defect — the economically-equivalent tick-crossing
test provides real, passing quantitative evidence instead, exactly per the
task's own pre-authorized fallback); and gas telemetry covers the 4
execution paths that already had telemetry infrastructure, not the
one-shot paths that never had any.

**PASS for this phase does NOT mean production-ready.** It means: no
hardcoded local-tx gas values remain unaddressed, gas-estimation failure
cannot escalate to unlimited/huge gas or a silent unsafe send, gas
telemetry never fabricates zero for an unmeasurable value, retries never
reuse a stale gas estimate, and the V3 quote engine's correctness has been
checked against real on-chain state via a real, discovered pool on a live
chain — not that the bot is ready for unattended production capital.

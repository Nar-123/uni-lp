/**
 * PnL computation tests — Phase 3 (gross/net separation, ROI, UNKNOWN
 * handling, multi-position isolation). Same scratch-env setup as
 * ledger.test.ts — see its header comment for why.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unicrit-pnl-test-'));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_USER_IDS = '1';
process.env.DB_PATH = path.join(scratchDir, 'bot.json');
process.env.WALLETS_PATH = path.join(scratchDir, 'wallets.json');

const { recordLedger } = await import('../src/db/index.js');
const { computePositionPnl, computePnlPct } = await import('../src/pnl/compute.js');
const { CHAINS } = await import('../src/config.js');

const CHAIN = 8453;

function freshTokenId(): string {
  return `pnl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ── Gross vs net PnL (§20) ────────────────────────────────────────────────

test('PnL: gross and net are both present, and net is UNKNOWN (null) when no gas data can be matched', async () => {
  const tokenId = freshTokenId();
  recordLedger({ chainId: CHAIN, tokenId, kind: 'deposit', usd: 1000, txHash: '0xd001000000000000000000000000000000000000000000000000000d001' });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 1150, txHash: '0xd002000000000000000000000000000000000000000000000000000d002' });

  const pnl = await computePositionPnl(CHAIN, tokenId, { valueUsd: 0, unclaimedFeesUsd: 0, priceComplete: true });

  assert.equal(pnl.grossPnlUsd, pnl.pnlUsd, 'grossPnlUsd must be an exact alias of the existing pnlUsd formula');
  assert.equal(pnl.pnlUsd, 150, '1150 withdrawal - 1000 deposit = 150 gross profit');
  assert.equal(pnl.gasCostUsd, null, 'no execution_telemetry exists for these tx hashes — must be UNKNOWN, not 0');
  assert.equal(pnl.netPnlUsd, null, 'net must also be UNKNOWN when its gas-cost input is UNKNOWN — never silently equal to gross');
  assert.equal(pnl.gasCostComplete, false);
});

// ── ROI denominator (§24) ────────────────────────────────────────────────

test('ROI: pnlPct denominator is capital invested (deposits), not current value', () => {
  // profit=50 on deposits=100 (current value irrelevant to the denominator) -> 50%, not e.g. profit/currentValue
  assert.equal(computePnlPct(50, 100, true), 50);
  // Same profit, different (larger) current value must not change the ROI% — the formula never references current value at all.
  assert.equal(computePnlPct(50, 100, true), 50);
});

test('ROI: unknown price data yields UNKNOWN ROI (null), never a fabricated percentage', () => {
  assert.equal(computePnlPct(-500, 100, false), null, 'priceComplete=false must veto the calculation regardless of the raw numbers');
});

test('ROI: zero capital invested yields UNKNOWN (null), not Infinity or a divide-by-zero artifact', () => {
  assert.equal(computePnlPct(100, 0, true), null);
});

// ── Negative PnL (§34) ────────────────────────────────────────────────────

test('PnL: a genuine loss is reported as a negative number, never clamped to zero', async () => {
  const tokenId = freshTokenId();
  recordLedger({ chainId: CHAIN, tokenId, kind: 'deposit', usd: 1000, txHash: '0xd003000000000000000000000000000000000000000000000000000d003' });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 400, txHash: '0xd004000000000000000000000000000000000000000000000000000d004' });

  const pnl = await computePositionPnl(CHAIN, tokenId, { valueUsd: 0, unclaimedFeesUsd: 0, priceComplete: true });
  assert.equal(pnl.pnlUsd, -600);
  assert.ok(pnl.pnlUsd < 0, 'loss must remain negative, not clamped to 0');
  assert.equal(pnl.pnlPct, -60);
});

// ── Multiple positions do not leak into each other (§25) ─────────────────

test('PnL: position A and position B are accounted independently — no cross-contamination', async () => {
  const tokenA = freshTokenId();
  const tokenB = freshTokenId();
  recordLedger({ chainId: CHAIN, tokenId: tokenA, kind: 'deposit', usd: 1000, txHash: '0xa001000000000000000000000000000000000000000000000000000a001' });
  recordLedger({ chainId: CHAIN, tokenId: tokenA, kind: 'withdrawal', usd: 1200, txHash: '0xa002000000000000000000000000000000000000000000000000000a002' });
  recordLedger({ chainId: CHAIN, tokenId: tokenB, kind: 'deposit', usd: 500, txHash: '0xb001000000000000000000000000000000000000000000000000000b001' });
  recordLedger({ chainId: CHAIN, tokenId: tokenB, kind: 'withdrawal', usd: 300, txHash: '0xb002000000000000000000000000000000000000000000000000000b002' });

  const pnlA = await computePositionPnl(CHAIN, tokenA, { valueUsd: 0, unclaimedFeesUsd: 0, priceComplete: true });
  const pnlB = await computePositionPnl(CHAIN, tokenB, { valueUsd: 0, unclaimedFeesUsd: 0, priceComplete: true });

  assert.equal(pnlA.pnlUsd, 200, 'position A: 1200 - 1000');
  assert.equal(pnlB.pnlUsd, -200, 'position B: 300 - 500');
  assert.equal(pnlA.depositsUsd, 1000);
  assert.equal(pnlB.depositsUsd, 500);
});

// ── Partial withdrawal is not automatically declared profit (§9) ─────────

test('partial withdrawal: withdrawing less than deposited cost basis is NOT automatically profit', async () => {
  const tokenId = freshTokenId();
  recordLedger({ chainId: CHAIN, tokenId, kind: 'deposit', usd: 1000, txHash: '0xc001000000000000000000000000000000000000000000000000000c001' });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'withdrawal', usd: 400, txHash: '0xc002000000000000000000000000000000000000000000000000000c002' });
  // Position still has $650 of current value left (partial close) — total accounting must still reflect a loss overall, not treat the $400 withdrawal in isolation as +$400 profit.
  const pnl = await computePositionPnl(CHAIN, tokenId, { valueUsd: 650, unclaimedFeesUsd: 0, priceComplete: true });
  assert.equal(pnl.pnlUsd, 50, 'current(650) + withdrawals(400) - deposits(1000) = 50, not the withdrawal amount alone');
});

// ── Liquidity increase maintains aggregate cost basis (§8) ────────────────

test('liquidity increase: cost basis aggregates across multiple deposit events for the same position', async () => {
  const tokenId = freshTokenId();
  recordLedger({ chainId: CHAIN, tokenId, kind: 'deposit', usd: 1000, txHash: '0xe001000000000000000000000000000000000000000000000000000e001' });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'deposit', usd: 300, txHash: '0xe002000000000000000000000000000000000000000000000000000e002' });
  const pnl = await computePositionPnl(CHAIN, tokenId, { valueUsd: 1300, unclaimedFeesUsd: 0, priceComplete: true });
  assert.equal(pnl.depositsUsd, 1300, 'the $300 increase must add to, not replace, the $1000 initial cost basis');
  assert.equal(pnl.pnlUsd, 0, 'break-even: current value exactly matches the aggregated $1300 cost basis');
});

// ── Historical cost basis must not be revalued at current price (§7/§30) ─

test('deposit cost basis: a deposit with a valid stored usd is NOT revalued at the current live price', async () => {
  const tokenId = freshTokenId();
  const usdc = CHAINS[CHAIN].usdc!;
  // Historical usd (450) intentionally differs from what amountHuman(500)
  // * the live USDC price (deterministically $1, no network call) would
  // produce (500) — if repriceDepositsUsd were still preferring the live
  // price, depositsUsd would come back as 500, not 450.
  recordLedger({
    chainId: CHAIN,
    tokenId,
    kind: 'deposit',
    tokenAddress: usdc,
    amountRaw: '500000000',
    amountHuman: 500,
    usd: 450,
    txHash: '0xg001000000000000000000000000000000000000000000000000000g001',
  });
  const pnl = await computePositionPnl(CHAIN, tokenId, { valueUsd: 450, unclaimedFeesUsd: 0, priceComplete: true });
  assert.equal(pnl.depositsUsd, 450, 'the recorded historical usd must be used, not amountHuman * current price (500)');
});

test('deposit cost basis: a deposit with a missing/zero stored usd falls back to live-price re-derivation (legacy-row compensation)', async () => {
  const tokenId = freshTokenId();
  const usdc = CHAINS[CHAIN].usdc!;
  recordLedger({
    chainId: CHAIN,
    tokenId,
    kind: 'deposit',
    tokenAddress: usdc,
    amountRaw: '500000000',
    amountHuman: 500,
    usd: 0, // simulates a legacy row written with a bad/zero historical price
    txHash: '0xg002000000000000000000000000000000000000000000000000000g002',
  });
  const pnl = await computePositionPnl(CHAIN, tokenId, { valueUsd: 0, unclaimedFeesUsd: 0, priceComplete: true });
  assert.equal(pnl.depositsUsd, 500, 'a genuinely-zero stored usd should still fall back to live-price * amount, matching the original bug-compensation intent');
});

// ── Unclaimed vs claimed fees are not double-counted (§22) ────────────────

test('fees: unclaimed fee value and claimed fee cash are both represented without double-counting', async () => {
  const tokenId = freshTokenId();
  recordLedger({ chainId: CHAIN, tokenId, kind: 'deposit', usd: 1000, txHash: '0xf001000000000000000000000000000000000000000000000000000f001' });
  recordLedger({ chainId: CHAIN, tokenId, kind: 'fee_claim', usd: 50, txHash: '0xf002000000000000000000000000000000000000000000000000000f002' });
  // currentValueUsd (1000, principal only) + unclaimedFeesUsd (30, still
  // sitting in the position) are BOTH distinct from the already-claimed 50.
  const pnl = await computePositionPnl(CHAIN, tokenId, { valueUsd: 1000, unclaimedFeesUsd: 30, priceComplete: true });
  assert.equal(pnl.pnlUsd, 80, 'current(1000) + unclaimed(30) + claimed(50) - deposits(1000) = 80 — each fee dollar counted exactly once');
});

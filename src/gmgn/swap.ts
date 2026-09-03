import { maxUint256, type Address, type Hash, type Hex } from 'viem';
import { CHAINS, txUrl, type SupportedChainId } from '../config.js';
import { erc20Abi } from '../chain/abis.js';
import { getHotWalletAddress, getPublicClient, getWalletClient } from '../chain/clients.js';
import {
  getTokenBalance,
  isNativeTokenAddress,
  NATIVE_TOKEN,
} from '../chain/tokens.js';
import { sleep } from '../chain/retry.js';
import {
  GMGN_NATIVE,
  GmgnError,
  gmgnManagedSwap,
  gmgnOrderGet,
  gmgnQuote,
  type GmgnQuote,
} from './cli.js';
import { EXECUTION_RECEIPT_TIMEOUT_MS } from '../chain/receiptWait.js';

/**
 * Who signs the swap.
 *
 * `local` (default) — GMGN quotes the route; this bot signs with its hot key.
 * `managed` — gmgn-cli swap signs from the wallet bound to the GMGN API key.
 */
export type GmgnSwapMode = 'local' | 'managed';

export function gmgnSwapMode(): GmgnSwapMode {
  return process.env.GMGN_SWAP_MODE?.trim().toLowerCase() === 'managed'
    ? 'managed'
    : 'local';
}

export function gmgnSlippagePct(): number {
  const raw = Number(process.env.GMGN_SLIPPAGE_PCT ?? 15);
  if (!Number.isFinite(raw) || raw <= 0) return 15;
  return Math.min(100, Math.round(raw));
}

export type GmgnSwapResult = {
  hash: Hash;
  txLink: string;
  amountIn: bigint;
  amountOutQuoted: bigint;
  minOutput: bigint;
  mode: GmgnSwapMode;
};

/** GMGN treats wrapped-native input as native. */
function toGmgnToken(chainId: SupportedChainId, token: Address): Address {
  if (isNativeTokenAddress(token)) return GMGN_NATIVE;
  if (token.toLowerCase() === CHAINS[chainId].wrapped.toLowerCase()) return GMGN_NATIVE;
  return token;
}

function assertManagedBinding(from: Address): void {
  const bound = process.env.GMGN_WALLET_ADDRESS?.trim();
  if (!bound) {
    throw new GmgnError(
      'GMGN_SWAP_MODE=managed requires GMGN_WALLET_ADDRESS (wallet bound to your GMGN API key).',
    );
  }
  if (bound.toLowerCase() !== from.toLowerCase()) {
    throw new GmgnError(
      `GMGN wallet binding mismatch — bot hot wallet is ${from}, GMGN_WALLET_ADDRESS is ${bound}. Aborting.`,
    );
  }
}

async function ensureRouterAllowance(
  chainId: SupportedChainId,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);
  const owner = getHotWalletAddress();
  const current = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
  if ((current as bigint) >= amount) return;

  console.log(`[gmgn] approving ${spender} for ${token} on ${chainId}`);
  const hash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, maxUint256],
    account: wallet.account,
    chain: wallet.chain,
  });
  await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
}

function validateQuote(
  q: GmgnQuote,
  expected: { amountRaw: bigint; chainId: SupportedChainId },
): void {
  if (!q?.tx) throw new GmgnError('GMGN quote missing tx payload');
  if (q.tx.chain_id !== expected.chainId) {
    throw new GmgnError(
      `GMGN quote targets chain ${q.tx.chain_id}, expected ${expected.chainId}`,
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(q.tx.to)) {
    throw new GmgnError(`GMGN quote has invalid tx.to: ${String(q.tx.to).slice(0, 64)}`);
  }
  if (!/^0x[a-fA-F0-9]*$/.test(q.tx.data) || q.tx.data.length < 10) {
    throw new GmgnError('GMGN quote has invalid tx.data');
  }
  if (BigInt(q.tx.amount_in) !== expected.amountRaw) {
    throw new GmgnError(
      `GMGN quote amount_in ${q.tx.amount_in} != requested ${expected.amountRaw}`,
    );
  }
  if (BigInt(q.min_output_amount) <= 0n) {
    throw new GmgnError('GMGN quote min_output_amount is 0');
  }
}

/**
 * Swap `amountRaw` of `tokenIn` into `tokenOut` via GMGN.
 * Hard-requires gmgn-cli + API key — no Uniswap fallback.
 *
 * WETH/WBNB input is unwrapped first (GMGN quotes native, not wrapped).
 */
export async function gmgnSwap(params: {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountRaw: bigint;
  slippagePct?: number;
}): Promise<GmgnSwapResult> {
  const { chainId, tokenOut } = params;
  let { tokenIn, amountRaw } = params;
  if (amountRaw <= 0n) throw new GmgnError('gmgnSwap: amountRaw is 0');

  // GMGN settles native, not WETH — unwrap so msg.value path works
  if (
    !isNativeTokenAddress(tokenIn) &&
    tokenIn.toLowerCase() === CHAINS[chainId].wrapped.toLowerCase()
  ) {
    const { unwrapNative } = await import('../chain/wrap.js');
    const bal = await getTokenBalance(chainId, tokenIn, getHotWalletAddress());
    const use = amountRaw < bal ? amountRaw : bal;
    if (use <= 0n) throw new GmgnError('gmgnSwap: no WETH/WBNB to unwrap');
    await unwrapNative(chainId, use);
    tokenIn = NATIVE_TOKEN;
    amountRaw = use;
    console.log(`[gmgn] unwrapped ${use} wrapped-native before swap`);
  }

  const slippagePct = params.slippagePct ?? gmgnSlippagePct();
  const from = getHotWalletAddress();
  const inToken = toGmgnToken(chainId, tokenIn);
  const outToken = toGmgnToken(chainId, tokenOut);

  if (inToken.toLowerCase() === outToken.toLowerCase()) {
    throw new GmgnError('gmgnSwap: input and output resolve to the same token');
  }

  const mode = gmgnSwapMode();

  if (mode === 'managed') {
    assertManagedBinding(from);
    return managedSwap({
      chainId,
      from,
      inToken,
      outToken,
      amountRaw,
      slippagePct,
    });
  }

  const quote = await gmgnQuote({
    chainId,
    from,
    inputToken: inToken,
    outputToken: outToken,
    amountRaw,
    slippagePct,
  });
  validateQuote(quote, { amountRaw, chainId });

  const router = quote.tx.to as Address;
  const value = BigInt(quote.tx.value ?? '0');
  const minOut = BigInt(quote.min_output_amount);

  console.log(
    `[gmgn] quote chain=${chainId} ${inToken} → ${outToken} in=${amountRaw} out=${quote.output_amount} ` +
      `min=${minOut} router=${router} type=${quote.tx.type ?? '?'}`,
  );

  // ERC-20 input needs allowance; native is paid as msg.value from the quote
  if (!isNativeTokenAddress(inToken) && !isNativeTokenAddress(tokenIn)) {
    await ensureRouterAllowance(chainId, tokenIn, router, amountRaw);
  }

  const wallet = getWalletClient(chainId);
  const client = getPublicClient(chainId);

  // Dry-run before broadcasting — a reverting swap should fail here, not
  // after being mined.
  try {
    await client.call({
      to: router,
      data: quote.tx.data as Hex,
      value,
      account: wallet.account,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new GmgnError(`GMGN swap would revert (simulation failed): ${msg.slice(0, 240)}`);
  }

  const hash = await wallet.sendTransaction({
    account: wallet.account,
    chain: wallet.chain,
    to: router,
    data: quote.tx.data as Hex,
    value,
    ...(quote.tx.gas_limit ? { gas: BigInt(quote.tx.gas_limit) } : {}),
  });

  const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') {
    throw new GmgnError(`GMGN swap reverted: ${txUrl(chainId, hash)}`);
  }

  return {
    hash,
    txLink: txUrl(chainId, hash),
    amountIn: amountRaw,
    amountOutQuoted: BigInt(quote.output_amount),
    minOutput: minOut,
    mode,
  };
}

async function managedSwap(p: {
  chainId: SupportedChainId;
  from: Address;
  inToken: Address;
  outToken: Address;
  amountRaw: bigint;
  slippagePct: number;
}): Promise<GmgnSwapResult> {
  const submitted = await gmgnManagedSwap({
    chainId: p.chainId,
    from: p.from,
    inputToken: p.inToken,
    outputToken: p.outToken,
    amountRaw: p.amountRaw,
    slippagePct: p.slippagePct,
  });

  const orderId = submitted.order_id ?? submitted.orderId;
  let hash = (submitted.hash ?? submitted.tx_hash) as Hash | undefined;

  if (orderId) {
    for (let i = 0; i < 3; i++) {
      await sleep(5_000);
      const order = await gmgnOrderGet(p.chainId, orderId).catch((e) => {
        console.warn('[gmgn] order get failed:', e instanceof Error ? e.message : e);
        return null;
      });
      if (!order) continue;
      hash = (order.hash ?? order.tx_hash ?? hash) as Hash | undefined;
      const status = order.status?.toLowerCase();
      if (status === 'confirmed') break;
      if (status === 'failed' || status === 'expired') {
        throw new GmgnError(`GMGN managed swap ${status} (order ${orderId})`);
      }
    }
  }

  if (!hash) throw new GmgnError('GMGN managed swap returned no transaction hash');

  return {
    hash,
    txLink: txUrl(p.chainId, hash),
    amountIn: p.amountRaw,
    amountOutQuoted: 0n,
    minOutput: 0n,
    mode: 'managed',
  };
}

/**
 * Sell entire balance of `token` → **native only** via GMGN.
 * GMGN does not support selling directly to USDG/USDC — use Uniswap for that leg.
 * Returns null when balance is dust/zero.
 */
export async function gmgnSellAll(
  chainId: SupportedChainId,
  token: Address,
  opts: { minRaw?: bigint; slippagePct?: number } = {},
): Promise<GmgnSwapResult | null> {
  const balance = await getTokenBalance(chainId, token, getHotWalletAddress());
  const min = opts.minRaw ?? 1n;
  if (balance < min) {
    console.log(`[gmgn] nothing to sell for ${token} (balance ${balance})`);
    return null;
  }

  return gmgnSwap({
    chainId,
    tokenIn: token,
    tokenOut: NATIVE_TOKEN,
    amountRaw: balance,
    slippagePct: opts.slippagePct,
  });
}

/**
 * Sell a capped amount → **native only** via GMGN (never full wallet).
 * For Close→stable: call this (meme→ETH), then Uniswap ETH→stable separately.
 */
export async function gmgnSellAmount(
  chainId: SupportedChainId,
  token: Address,
  amountRaw: bigint,
  _quoteKind: 'eth' | 'stable' = 'eth',
  opts: { slippagePct?: number } = {},
): Promise<GmgnSwapResult> {
  // `_quoteKind` kept for call-site compatibility; GMGN always exits to native.
  if (amountRaw <= 0n) throw new GmgnError('gmgnSellAmount: amountRaw is 0');
  if (_quoteKind === 'stable') {
    console.warn(
      '[gmgn] sell-to-stable requested but GMGN only supports native output — selling to ETH/BNB',
    );
  }

  const bal = await getTokenBalance(chainId, token, getHotWalletAddress());
  const use = amountRaw < bal ? amountRaw : bal;
  if (use <= 0n) throw new GmgnError('gmgnSellAmount: no spendable balance');

  return gmgnSwap({
    chainId,
    tokenIn: token,
    tokenOut: NATIVE_TOKEN,
    amountRaw: use,
    slippagePct: opts.slippagePct,
  });
}

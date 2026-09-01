import { encodeFunctionData, type Address, type Hash } from 'viem';
import {
  type DexId,
  resolveV3Contracts,
  type SupportedChainId,
  txUrl,
} from '../config.js';
import { npmAbi, poolAbi } from './abis.js';
import { getHotWalletAddress, getPublicClient, getWalletClient } from './clients.js';
import { getPosition, computeV3AmountsForLiquidity } from './positions.js';
import { resolvePoolFromFactory } from './pools.js';
import { humanToFloat } from './tokens.js';
import { getTokenPriceUsd } from '../price/dexscreener.js';
import { CLOSE_SLIPPAGE_BPS, computeWithdrawalMins, SafetyError } from './safety.js';

export type CloseResult = {
  hash: Hash;
  tokenId: bigint;
  amount0: bigint;
  amount1: bigint;
  amount0Human: number;
  amount1Human: number;
  withdrawalUsd: number;
  feesPortionUsd: number;
  txLink: string;
  token0: Address;
  token1: Address;
  symbol0: string;
  symbol1: string;
  dex?: DexId;
};

const MAX_UINT128 = (1n << 128n) - 1n;

function shortErr(e: unknown): string {
  if (!(e instanceof Error)) return String(e).slice(0, 280);
  const any = e as Error & { shortMessage?: string; details?: string; cause?: unknown };
  const parts = [any.shortMessage, any.message, any.details].filter(Boolean);
  return parts.join(' | ').slice(0, 320);
}

export async function closePosition(
  chainId: SupportedChainId,
  tokenId: bigint,
  protocol: 'v3' | 'v4' = 'v3',
  dex: DexId = 'uniswap',
): Promise<CloseResult> {
  if (protocol === 'v4') {
    const { closeV4Position } = await import('./v4.js');
    const r = await closeV4Position(chainId, tokenId);
    return {
      hash: r.hash,
      tokenId: r.tokenId,
      amount0: r.amount0,
      amount1: r.amount1,
      amount0Human: r.amount0Human,
      amount1Human: r.amount1Human,
      withdrawalUsd: r.withdrawalUsd,
      feesPortionUsd: r.feesPortionUsd,
      txLink: r.txLink,
      token0: r.token0,
      token1: r.token1,
      symbol0: r.symbol0,
      symbol1: r.symbol1,
      dex: 'uniswap',
    };
  }

  // Re-read live position (liquidity can change; stale liq is a common close fail — not slippage)
  const pos = await getPosition(chainId, tokenId, dex);
  if (!pos) throw new Error(`Position #${tokenId} not found or already empty (${dex})`);

  const { npm } = resolveV3Contracts(chainId, dex);
  const recipient = getHotWalletAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);

  // Fresh on-chain liquidity (authoritative). RPC failure here is a
  // retryable read, not a licence to close with stale liquidity — throw so
  // the caller/withRetries wrapper handles it, rather than silently reusing
  // `pos.liquidity` from the earlier snapshot.
  const readLiveLiquidity = async (): Promise<bigint> => {
    const raw = await client.readContract({
      address: npm,
      abi: npmAbi,
      functionName: 'positions',
      args: [tokenId],
    });
    return raw[7] as bigint;
  };

  /**
   * Expected withdrawal for `liquidity` computed from *live* pool state
   * (fresh slot0 + pool liquidity), bounded to a minimum via CLOSE_SLIPPAGE_BPS.
   * Throws (aborts the close) if pool state can't be read — never falls back
   * to amount0Min=amount1Min=0.
   */
  const computeMins = async (
    liquidity: bigint,
  ): Promise<{ amount0Min: bigint; amount1Min: bigint }> => {
    if (liquidity <= 0n) return { amount0Min: 0n, amount1Min: 0n };
    const poolAddress = await resolvePoolFromFactory(
      chainId,
      pos.token0,
      pos.token1,
      pos.fee,
      dex,
    );
    if (!poolAddress) {
      throw new SafetyError(
        `[safety] closePosition #${tokenId}: cannot resolve pool for withdrawal-min calc — aborting`,
      );
    }
    const [slot0, poolLiquidity] = await Promise.all([
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0' }),
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'liquidity' }),
    ]);
    const { amount0, amount1 } = computeV3AmountsForLiquidity({
      chainId,
      token0: pos.token0,
      token1: pos.token1,
      decimals0: pos.decimals0,
      decimals1: pos.decimals1,
      symbol0: pos.symbol0,
      symbol1: pos.symbol1,
      name0: pos.symbol0,
      name1: pos.symbol1,
      fee: pos.fee,
      sqrtPriceX96: slot0[0] as bigint,
      poolLiquidity: poolLiquidity as bigint,
      currentTick: Number(slot0[1]),
      liquidity,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
    });
    return computeWithdrawalMins({
      expected0: amount0,
      expected1: amount1,
      slippageBps: CLOSE_SLIPPAGE_BPS,
      context: `closePosition #${tokenId}`,
    });
  };

  let liveLiq = await readLiveLiquidity();
  const initialMins = await computeMins(liveLiq);

  console.log(
    `[close v3] #${tokenId} liveLiq=${liveLiq} owed0=${pos.tokensOwed0} owed1=${pos.tokensOwed1} ` +
      `min0=${initialMins.amount0Min} min1=${initialMins.amount1Min}`,
  );

  const decreaseCall =
    liveLiq > 0n
      ? encodeFunctionData({
          abi: npmAbi,
          functionName: 'decreaseLiquidity',
          args: [
            {
              tokenId,
              liquidity: liveLiq,
              amount0Min: initialMins.amount0Min,
              amount1Min: initialMins.amount1Min,
              deadline,
            },
          ],
        })
      : null;

  const collectCall = encodeFunctionData({
    abi: npmAbi,
    functionName: 'collect',
    args: [
      {
        tokenId,
        recipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
    ],
  });

  const safeCalls = decreaseCall ? [decreaseCall, collectCall] : [collectCall];

  // Retries: up to 3 rounds × (multicall → sequential decrease/collect)
  const { withRetries } = await import('./retry.js');
  const hash = await withRetries(
    async (round) => {
      // Fresh liquidity + fresh expected-withdrawal mins each round — a
      // retry must refresh data and rerun the safety gate, never reuse a
      // stale (or zero) minimum.
      const liq = await readLiveLiquidity();
      const mins = await computeMins(liq);
      const dl = BigInt(Math.floor(Date.now() / 1000) + 1800);
      const dec =
        liq > 0n
          ? encodeFunctionData({
              abi: npmAbi,
              functionName: 'decreaseLiquidity',
              args: [
                {
                  tokenId,
                  liquidity: liq,
                  amount0Min: mins.amount0Min,
                  amount1Min: mins.amount1Min,
                  deadline: dl,
                },
              ],
            })
          : null;
      const col = encodeFunctionData({
        abi: npmAbi,
        functionName: 'collect',
        args: [
          {
            tokenId,
            recipient,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          },
        ],
      });
      const calls = dec ? [dec, col] : [col];
      console.log(`[close v3] round ${round} liq=${liq} min0=${mins.amount0Min} min1=${mins.amount1Min}`);

      try {
        await client.simulateContract({
          address: npm,
          abi: npmAbi,
          functionName: 'multicall',
          args: [calls],
          account: recipient,
        });
        const h = await wallet.writeContract({
          address: npm,
          abi: npmAbi,
          functionName: 'multicall',
          args: [calls],
          account: wallet.account!,
          chain: wallet.chain,
          gas: 900_000n,
        });
        const receipt = await client.waitForTransactionReceipt({ hash: h });
        if (receipt.status !== 'success') throw new Error(`multicall reverted ${h}`);
        return h;
      } catch (e1) {
        console.warn(`[close v3] multicall fail r${round}:`, shortErr(e1));
        // Sequential fallback — refresh liquidity AND expected-withdrawal
        // mins again; never fall back to amount0Min=amount1Min=0.
        if (liq > 0n) {
          const liq2 = await readLiveLiquidity();
          if (liq2 > 0n) {
            const mins2 = await computeMins(liq2);
            const h1 = await wallet.writeContract({
              address: npm,
              abi: npmAbi,
              functionName: 'decreaseLiquidity',
              args: [
                {
                  tokenId,
                  liquidity: liq2,
                  amount0Min: mins2.amount0Min,
                  amount1Min: mins2.amount1Min,
                  deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
                },
              ],
              account: wallet.account!,
              chain: wallet.chain,
              gas: 500_000n,
            });
            const r1 = await client.waitForTransactionReceipt({ hash: h1 });
            if (r1.status !== 'success') throw new Error(`decrease reverted ${h1}`);
          }
        }
        const h2 = await wallet.writeContract({
          address: npm,
          abi: npmAbi,
          functionName: 'collect',
          args: [
            {
              tokenId,
              recipient,
              amount0Max: MAX_UINT128,
              amount1Max: MAX_UINT128,
            },
          ],
          account: wallet.account!,
          chain: wallet.chain,
          gas: 400_000n,
        });
        const r2 = await client.waitForTransactionReceipt({ hash: h2 });
        if (r2.status !== 'success') throw new Error(`collect reverted ${h2}`);
        return h2;
      }
    },
    {
      times: 3,
      backoffMs: 1200,
      label: 'close-v3',
      shouldRetry: (err) => {
        const m = err instanceof Error ? err.message : String(err);
        return !/not found|already empty|not owner|ERC721/i.test(m);
      },
    },
  );

  // Best-effort burn NFT shell
  try {
    const burnHash = await wallet.writeContract({
      address: npm,
      abi: npmAbi,
      functionName: 'burn',
      args: [tokenId],
      account: wallet.account!,
      chain: wallet.chain,
      gas: 200_000n,
    });
    await client.waitForTransactionReceipt({ hash: burnHash });
  } catch {
    /* NFT may remain with 0 liquidity — OK */
  }

  const amount0 = pos.amount0 + pos.tokensOwed0;
  const amount1 = pos.amount1 + pos.tokensOwed1;
  const a0 = humanToFloat(amount0, pos.decimals0);
  const a1 = humanToFloat(amount1, pos.decimals1);
  const [p0, p1] = await Promise.all([
    getTokenPriceUsd(chainId, pos.token0),
    getTokenPriceUsd(chainId, pos.token1),
  ]);
  const withdrawalUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);
  const feesPortionUsd = pos.unclaimedFeesUsd;

  return {
    hash,
    tokenId,
    amount0,
    amount1,
    amount0Human: a0,
    amount1Human: a1,
    withdrawalUsd,
    feesPortionUsd,
    txLink: txUrl(chainId, hash),
    token0: pos.token0,
    token1: pos.token1,
    symbol0: pos.symbol0,
    symbol1: pos.symbol1,
    dex,
  };
}

export type ClaimFeesResult = {
  protocol: 'v3' | 'v4';
  dex?: DexId;
  hash: Hash;
  tokenId: bigint;
  feesUsd: number;
  amount0Human: number;
  amount1Human: number;
  symbol0: string;
  symbol1: string;
  txLink: string;
};

/**
 * Collect unclaimed fees only (position stays open).
 * v3: NPM collect · v4: POSM decrease(0)+take
 */
export async function claimFees(
  chainId: SupportedChainId,
  tokenId: bigint,
  protocol: 'v3' | 'v4' = 'v3',
  dex: DexId = 'uniswap',
): Promise<ClaimFeesResult> {
  if (protocol === 'v4') {
    const { claimV4Fees } = await import('./v4.js');
    const r = await claimV4Fees(chainId, tokenId);
    return {
      protocol: 'v4',
      dex: 'uniswap',
      hash: r.hash,
      tokenId: r.tokenId,
      feesUsd: r.feesUsd,
      amount0Human: r.amount0Human,
      amount1Human: r.amount1Human,
      symbol0: r.symbol0,
      symbol1: r.symbol1,
      txLink: r.txLink,
    };
  }

  const pos = await getPosition(chainId, tokenId, dex);
  if (!pos) throw new Error(`Position #${tokenId} not found or empty (${dex})`);
  if (pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n) {
    throw new Error(`No unclaimed fees on #${tokenId}`);
  }

  const { npm } = resolveV3Contracts(chainId, dex);
  const recipient = getHotWalletAddress();
  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);

  console.log(
    `[claim v3] #${tokenId} owed0=${pos.tokensOwed0} owed1=${pos.tokensOwed1} estUsd=${pos.unclaimedFeesUsd}`,
  );

  const hash = await wallet.writeContract({
    address: npm,
    abi: npmAbi,
    functionName: 'collect',
    args: [
      {
        tokenId,
        recipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
    ],
    account: wallet.account!,
    chain: wallet.chain,
    gas: 400_000n,
  });
  await client.waitForTransactionReceipt({ hash });

  return {
    protocol: 'v3',
    dex,
    hash,
    tokenId,
    feesUsd: pos.unclaimedFeesUsd,
    amount0Human: humanToFloat(pos.tokensOwed0, pos.decimals0),
    amount1Human: humanToFloat(pos.tokensOwed1, pos.decimals1),
    symbol0: pos.symbol0,
    symbol1: pos.symbol1,
    txLink: txUrl(chainId, hash),
  };
}

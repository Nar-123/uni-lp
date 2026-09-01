import { encodeFunctionData, type Address, type Hash } from 'viem';
import {
  type DexId,
  resolveV3Contracts,
  type SupportedChainId,
  txUrl,
} from '../config.js';
import { erc20Abi, npmAbi, poolAbi } from './abis.js';
import { getHotWalletAddress, getPublicClient, getWalletClient } from './clients.js';
import { getPosition, computeV3AmountsForLiquidity } from './positions.js';
import { resolvePoolFromFactory } from './pools.js';
import { humanToFloat } from './tokens.js';
import { getTokenPriceUsd } from '../price/dexscreener.js';
import {
  CLOSE_SLIPPAGE_BPS,
  computeWithdrawalMins,
  resolveReceivedAmount,
  SafetyError,
} from './safety.js';
import { estimateWriteGas } from './gas.js';

export type CloseResult = {
  hash: Hash;
  tokenId: bigint;
  /** ACTUAL amount received, measured via wallet balance delta (falls back to the pre-close estimate only if no delta was observed) — see Phase 3 accounting audit §"Withdrawal accounting". */
  amount0: bigint;
  amount1: bigint;
  amount0Human: number;
  amount1Human: number;
  /** Pre-close estimate (position-liquidity math, computed before the transaction) — kept for auditability, never used as the final realized withdrawal. */
  expected0: bigint;
  expected1: bigint;
  withdrawalUsd: number;
  feesPortionUsd: number;
  /**
   * Phase 3.5: true whenever the principal/fee split in (withdrawalUsd,
   * feesPortionUsd) is an estimate rather than an exact on-chain
   * measurement. Currently always true: the combined decrease+collect path
   * uses pos.unclaimedFeesUsd (pre-close snapshot) rather than parsing
   * DecreaseLiquidity + Collect event log deltas. See audit §11.
   */
  feeSplitIsEstimated: boolean;
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
      expected0: r.expected0,
      expected1: r.expected1,
      withdrawalUsd: r.withdrawalUsd,
      feesPortionUsd: r.feesPortionUsd,
      feeSplitIsEstimated: true,
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
  ): Promise<{
    amount0Min: bigint;
    amount1Min: bigint;
    expected0: bigint;
    expected1: bigint;
  }> => {
    if (liquidity <= 0n) {
      return { amount0Min: 0n, amount1Min: 0n, expected0: 0n, expected1: 0n };
    }
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
    const mins = computeWithdrawalMins({
      expected0: amount0,
      expected1: amount1,
      slippageBps: CLOSE_SLIPPAGE_BPS,
      context: `closePosition #${tokenId}`,
    });
    return { ...mins, expected0: amount0, expected1: amount1 };
  };

  let liveLiq = await readLiveLiquidity();
  const initialMins = await computeMins(liveLiq);
  let lastMins = initialMins;

  const token0Before = await client.readContract({
    address: pos.token0,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [recipient],
  });
  const token1Before = await client.readContract({
    address: pos.token1,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [recipient],
  });

  const recordTelemetry = async (params: {
    ok: boolean;
    txHash?: Hash;
    errorMsg?: string;
  }): Promise<void> => {
    try {
      const { recordExecutionTelemetry } = await import('../db/index.js');
      let actual0: string | null = null;
      let actual1: string | null = null;
      if (params.ok) {
        const [token0After, token1After] = await Promise.all([
          client.readContract({
            address: pos.token0,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [recipient],
          }),
          client.readContract({
            address: pos.token1,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [recipient],
          }),
        ]);
        actual0 = resolveReceivedAmount({
          balanceBefore: token0Before,
          balanceAfter: token0After,
        }).toString();
        actual1 = resolveReceivedAmount({
          balanceBefore: token1Before,
          balanceAfter: token1After,
        }).toString();
      }
      const { buildGasTelemetry } = await import('./gas.js');
      const gas = params.ok && params.txHash
        ? await buildGasTelemetry(client, params.txHash)
        : null;
      recordExecutionTelemetry({
        chainId,
        opType: 'close-v3',
        dex,
        slippageBpsUsed: CLOSE_SLIPPAGE_BPS,
        quoteSource: 'v3-sdk-position-liquidity-math',
        legs: [
          {
            token: pos.token0,
            estimatedRaw: lastMins.expected0.toString(),
            minRaw: lastMins.amount0Min.toString(),
            actualRaw: actual0,
          },
          {
            token: pos.token1,
            estimatedRaw: lastMins.expected1.toString(),
            minRaw: lastMins.amount1Min.toString(),
            actualRaw: actual1,
          },
        ],
        txHash: params.txHash ?? null,
        ok: params.ok,
        errorMsg: params.errorMsg,
        gas,
      });
    } catch {
      /* telemetry is best-effort only */
    }
  };

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
  let hash: Hash;
  try {
    hash = await withRetries(
    async (round) => {
      // Fresh liquidity + fresh expected-withdrawal mins each round — a
      // retry must refresh data and rerun the safety gate, never reuse a
      // stale (or zero) minimum.
      const liq = await readLiveLiquidity();
      const mins = await computeMins(liq);
      lastMins = mins;
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
        const multicallGas = await estimateWriteGas({
          client,
          address: npm,
          abi: npmAbi,
          functionName: 'multicall',
          args: [calls],
          account: wallet.account!.address,
          fallbackGas: 900_000n,
          context: `close-v3 #${tokenId} multicall`,
        });
        const h = await wallet.writeContract({
          address: npm,
          abi: npmAbi,
          functionName: 'multicall',
          args: [calls],
          account: wallet.account!,
          chain: wallet.chain,
          gas: multicallGas,
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
            lastMins = mins2;
            const decreaseArgs = [
              {
                tokenId,
                liquidity: liq2,
                amount0Min: mins2.amount0Min,
                amount1Min: mins2.amount1Min,
                deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
              },
            ] as const;
            const decreaseGas = await estimateWriteGas({
              client,
              address: npm,
              abi: npmAbi,
              functionName: 'decreaseLiquidity',
              args: decreaseArgs,
              account: wallet.account!.address,
              fallbackGas: 500_000n,
              context: `close-v3 #${tokenId} decreaseLiquidity`,
            });
            const h1 = await wallet.writeContract({
              address: npm,
              abi: npmAbi,
              functionName: 'decreaseLiquidity',
              args: decreaseArgs,
              account: wallet.account!,
              chain: wallet.chain,
              gas: decreaseGas,
            });
            const r1 = await client.waitForTransactionReceipt({ hash: h1 });
            if (r1.status !== 'success') throw new Error(`decrease reverted ${h1}`);
          }
        }
        const collectArgs = [
          {
            tokenId,
            recipient,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          },
        ] as const;
        const collectGas = await estimateWriteGas({
          client,
          address: npm,
          abi: npmAbi,
          functionName: 'collect',
          args: collectArgs,
          account: wallet.account!.address,
          fallbackGas: 400_000n,
          context: `close-v3 #${tokenId} collect`,
        });
        const h2 = await wallet.writeContract({
          address: npm,
          abi: npmAbi,
          functionName: 'collect',
          args: collectArgs,
          account: wallet.account!,
          chain: wallet.chain,
          gas: collectGas,
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
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    await recordTelemetry({ ok: false, errorMsg });
    throw e;
  }
  await recordTelemetry({ ok: true, txHash: hash });

  // Best-effort burn NFT shell
  try {
    const burnGas = await estimateWriteGas({
      client,
      address: npm,
      abi: npmAbi,
      functionName: 'burn',
      args: [tokenId],
      account: wallet.account!.address,
      fallbackGas: 200_000n,
      context: `close-v3 #${tokenId} burn`,
    });
    const burnHash = await wallet.writeContract({
      address: npm,
      abi: npmAbi,
      functionName: 'burn',
      args: [tokenId],
      account: wallet.account!,
      chain: wallet.chain,
      gas: burnGas,
    });
    await client.waitForTransactionReceipt({ hash: burnHash });
  } catch {
    /* NFT may remain with 0 liquidity — OK */
  }

  // Pre-close estimate (position-liquidity math computed before the
  // transaction) — kept as `expected0`/`expected1` for auditability, never
  // used as the final realized withdrawal below.
  const expected0 = pos.amount0 + pos.tokensOwed0;
  const expected1 = pos.amount1 + pos.tokensOwed1;

  // ACTUAL amount received, measured via wallet balance delta — the close
  // tx (and the best-effort burn just above, which never moves ERC-20
  // balances) has already landed by this point. Falls back to the
  // pre-close estimate only if no delta was observed (e.g. recipient
  // already held a balance and something prevented measuring the exact
  // delta) — never silently zero.
  const [token0After, token1After] = await Promise.all([
    client.readContract({ address: pos.token0, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] }),
    client.readContract({ address: pos.token1, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] }),
  ]);
  const amount0 = resolveReceivedAmount({
    balanceBefore: token0Before,
    balanceAfter: token0After,
    fallbackEstimate: expected0,
  });
  const amount1 = resolveReceivedAmount({
    balanceBefore: token1Before,
    balanceAfter: token1After,
    fallbackEstimate: expected1,
  });
  const a0 = humanToFloat(amount0, pos.decimals0);
  const a1 = humanToFloat(amount1, pos.decimals1);
  const [p0, p1] = await Promise.all([
    getTokenPriceUsd(chainId, pos.token0),
    getTokenPriceUsd(chainId, pos.token1),
  ]);
  const withdrawalUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);
  // Fee portion is still the pre-close unclaimed-fee estimate (no separate
  // on-chain event splits principal vs. fees within the combined
  // decrease+collect); the ledger split (withdrawal minus this) is
  // documented as an estimate in PHASE3_ACCOUNTING_AUDIT.md.
  const feesPortionUsd = pos.unclaimedFeesUsd;

  return {
    hash,
    tokenId,
    amount0,
    amount1,
    amount0Human: a0,
    amount1Human: a1,
    expected0,
    expected1,
    withdrawalUsd,
    feesPortionUsd,
    feeSplitIsEstimated: true,
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

  const token0Before = await client.readContract({
    address: pos.token0,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [recipient],
  });
  const token1Before = await client.readContract({
    address: pos.token1,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [recipient],
  });

  const claimArgs = [
    {
      tokenId,
      recipient,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    },
  ] as const;
  const claimGas = await estimateWriteGas({
    client,
    address: npm,
    abi: npmAbi,
    functionName: 'collect',
    args: claimArgs,
    account: wallet.account!.address,
    fallbackGas: 400_000n,
    context: `claimFees v3 #${tokenId}`,
  });
  const hash = await wallet.writeContract({
    address: npm,
    abi: npmAbi,
    functionName: 'collect',
    args: claimArgs,
    account: wallet.account!,
    chain: wallet.chain,
    gas: claimGas,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`claimFees v3 #${tokenId} tx reverted: ${hash}`);
  }

  // ACTUAL collected amount via balance delta — pos.tokensOwed0/1 is the
  // pre-collect estimate (a snapshot from before this transaction) and
  // must not be reported as the final claimed amount. Falls back to that
  // estimate only if no delta was observed.
  const [token0After, token1After] = await Promise.all([
    client.readContract({ address: pos.token0, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] }),
    client.readContract({ address: pos.token1, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] }),
  ]);
  const actual0 = resolveReceivedAmount({
    balanceBefore: token0Before,
    balanceAfter: token0After,
    fallbackEstimate: pos.tokensOwed0,
  });
  const actual1 = resolveReceivedAmount({
    balanceBefore: token1Before,
    balanceAfter: token1After,
    fallbackEstimate: pos.tokensOwed1,
  });
  const a0 = humanToFloat(actual0, pos.decimals0);
  const a1 = humanToFloat(actual1, pos.decimals1);
  const [p0, p1] = await Promise.all([
    getTokenPriceUsd(chainId, pos.token0),
    getTokenPriceUsd(chainId, pos.token1),
  ]);
  const feesUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);

  // Gas telemetry (Phase 3 §17) — claim-fees previously had none at all.
  // Best-effort: never blocks/fails the already-successful claim.
  try {
    const { recordExecutionTelemetry } = await import('../db/index.js');
    const { buildGasTelemetry } = await import('./gas.js');
    const gas = await buildGasTelemetry(client, hash, claimGas);
    recordExecutionTelemetry({
      chainId,
      opType: 'claim-fees-v3',
      dex,
      slippageBpsUsed: 0,
      quoteSource: 'v3-position-tokensOwed-snapshot',
      legs: [
        { token: pos.token0, estimatedRaw: pos.tokensOwed0.toString(), minRaw: '0', actualRaw: actual0.toString() },
        { token: pos.token1, estimatedRaw: pos.tokensOwed1.toString(), minRaw: '0', actualRaw: actual1.toString() },
      ],
      txHash: hash,
      ok: true,
      gas,
    });
  } catch {
    /* telemetry is best-effort only */
  }

  return {
    protocol: 'v3',
    dex,
    hash,
    tokenId,
    feesUsd,
    amount0Human: a0,
    amount1Human: a1,
    symbol0: pos.symbol0,
    symbol1: pos.symbol1,
    txLink: txUrl(chainId, hash),
  };
}

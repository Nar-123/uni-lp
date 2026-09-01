import type { Address } from 'viem';
import { CHAINS, type SupportedChainId } from '../config.js';
import { getHotWalletAddress, getPublicClient } from './clients.js';
import { erc20Abi } from './abis.js';
import { formatUnits, getTokenMeta, humanToFloat } from './tokens.js';
import { getTokenPriceUsd, formatUsd } from '../price/dexscreener.js';
import { config } from '../config.js';

export type WalletToken = {
  address: Address;
  symbol: string;
  decimals: number;
  balance: bigint;
  balanceHuman: number;
  valueUsd: number;
};

function skipSet(chainId: SupportedChainId): Set<string> {
  const c = CHAINS[chainId];
  const s = new Set<string>([c.wrapped.toLowerCase()]);
  if (c.usdg) s.add(c.usdg.toLowerCase());
  if (c.usdt) s.add(c.usdt.toLowerCase());
  if (c.usdc) s.add(c.usdc.toLowerCase());
  // common stables / wrapped
  s.add('0x0000000000000000000000000000000000000000');
  return s;
}

/**
 * Discover ERC-20 balances via Alchemy alchemy_getTokenBalances when RPC is Alchemy,
 * otherwise fall back to empty (user can still swap by address later).
 */
export async function listNonCoreTokens(
  chainId: SupportedChainId,
): Promise<WalletToken[]> {
  const owner = getHotWalletAddress();
  const skip = skipSet(chainId);
  const addresses = await discoverTokenAddresses(chainId, owner);
  const out: WalletToken[] = [];

  for (const addr of addresses) {
    if (skip.has(addr.toLowerCase())) continue;
    try {
      const client = getPublicClient(chainId);
      const bal = await client.readContract({
        address: addr,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      });
      if (bal === 0n) continue;
      const meta = await getTokenMeta(chainId, addr);
      // skip if symbol looks like core
      const sym = meta.symbol.toUpperCase();
      if (['WETH', 'WBNB', 'ETH', 'BNB', 'USDG', 'USDC', 'USDT'].includes(sym)) continue;

      const human = humanToFloat(bal, meta.decimals);
      if (human <= 0) continue;
      const px = (await getTokenPriceUsd(chainId, addr)) ?? 0;
      const valueUsd = human * px;
      if (valueUsd < 0.5) continue; // skip dust tokens
      out.push({
        address: addr,
        symbol: meta.symbol,
        decimals: meta.decimals,
        balance: bal,
        balanceHuman: human,
        valueUsd,
      });
    } catch {
      /* skip broken token */
    }
  }

  out.sort((a, b) => b.valueUsd - a.valueUsd);
  return out;
}

async function discoverTokenAddresses(
  chainId: SupportedChainId,
  owner: Address,
): Promise<Address[]> {
  const rpc = config.rpc[chainId];
  // Alchemy
  if (rpc.includes('alchemy.com') || rpc.includes('g.alchemy.com')) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'alchemy_getTokenBalances',
          params: [owner, 'erc20'],
        }),
      });
      const j = (await res.json()) as {
        result?: { tokenBalances?: { contractAddress: string; tokenBalance: string }[] };
      };
      const list = j.result?.tokenBalances ?? [];
      return list
        .filter((t) => {
          try {
            const bal = BigInt(t.tokenBalance || '0x0');
            return bal > 0n;
          } catch {
            return false;
          }
        })
        .map((t) => t.contractAddress as Address);
    } catch (e) {
      console.warn('[tokens] alchemy_getTokenBalances failed', e);
    }
  }

  // Fallback: tokens we've touched via positions + common from dexscreener not available
  // Return empty — /tokens will say none found
  return [];
}

export function formatTokenLine(t: WalletToken, index: number): string {
  return (
    `${index + 1}. ${t.symbol}\n` +
    `   ${formatUnits(t.balance, t.decimals)} (~${formatUsd(t.valueUsd)})\n` +
    `   ${t.address}`
  );
}

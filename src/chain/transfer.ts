import {
  encodeFunctionData,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { CHAINS, type SupportedChainId } from '../config.js';
import { getWalletById, getActiveWallet } from '../wallet/keys.js';
import { getHotWalletAddress, getPublicClient, getWalletClient } from './clients.js';
import { erc20Abi } from './abis.js';
import { formatUnits, getTokenBalance, getTokenMeta } from './tokens.js';
import { GAS_RESERVE_WEI } from './wrap.js';
import { EXECUTION_RECEIPT_TIMEOUT_MS } from './receiptWait.js';

export type TransferAsset = 'native' | Address;

export type TransferResult = {
  hash: Hash;
  chainId: SupportedChainId;
  from: Address;
  to: Address;
  amount: bigint;
  symbol: string;
  decimals: number;
  isNative: boolean;
};

/**
 * Transfer native or ERC-20 from a stored wallet to any address (incl. another hot wallet).
 * Keeps a small gas reserve when sending native.
 */
export async function transferBetweenWallets(params: {
  chainId: SupportedChainId;
  /** Source wallet id (defaults to active) */
  fromWalletId?: string;
  toAddress: Address;
  amount: bigint;
  /** 'native' or ERC-20 token address */
  asset: TransferAsset;
}): Promise<TransferResult> {
  const { chainId, toAddress, amount, asset } = params;
  if (amount <= 0n) throw new Error('Amount must be positive');

  const fromW = params.fromWalletId
    ? getWalletById(params.fromWalletId)
    : getActiveWallet();
  if (!fromW) throw new Error('Source wallet not found');

  const from = fromW.address as Address;
  if (from.toLowerCase() === toAddress.toLowerCase()) {
    throw new Error('Cannot transfer to the same address');
  }

  const publicClient = getPublicClient(chainId);
  const wallet = getWalletClient(chainId, fromW.id);
  const isNative = asset === 'native';

  if (isNative) {
    const bal = await publicClient.getBalance({ address: from });
    const reserve = GAS_RESERVE_WEI[chainId];
    const maxSend = bal > reserve ? bal - reserve : 0n;
    if (amount > maxSend) {
      const c = CHAINS[chainId];
      throw new Error(
        `Insufficient ${c.nativeSymbol}: need ${formatUnits(amount, 18)} ` +
          `(max after gas reserve ${formatUnits(maxSend, 18)}; bal ${formatUnits(bal, 18)})`,
      );
    }
    const hash = await wallet.sendTransaction({
      account: from,
      to: toAddress,
      value: amount,
      chain: wallet.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
    return {
      hash,
      chainId,
      from,
      to: toAddress,
      amount,
      symbol: CHAINS[chainId].nativeSymbol,
      decimals: 18,
      isNative: true,
    };
  }

  const token = asset as Address;
  const meta = await getTokenMeta(chainId, token);
  const bal = await getTokenBalance(chainId, token, from);
  if (amount > bal) {
    throw new Error(
      `Insufficient ${meta.symbol}: need ${formatUnits(amount, meta.decimals)}, have ${formatUnits(bal, meta.decimals)}`,
    );
  }

  // Ensure native gas for ERC-20 transfer
  const nativeBal = await publicClient.getBalance({ address: from });
  if (nativeBal === 0n) {
    throw new Error(`Source wallet has no ${CHAINS[chainId].nativeSymbol} for gas`);
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [toAddress, amount],
  }) as Hex;

  const hash = await wallet.sendTransaction({
    account: from,
    to: token,
    data,
    chain: wallet.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });

  return {
    hash,
    chainId,
    from,
    to: toAddress,
    amount,
    symbol: meta.symbol,
    decimals: meta.decimals,
    isNative: false,
  };
}

/** Max transferable native (balance − gas reserve) for a wallet on a chain. */
export async function getTransferableNative(
  chainId: SupportedChainId,
  walletId?: string,
): Promise<bigint> {
  const addr = getHotWalletAddress(walletId);
  const client = getPublicClient(chainId);
  const bal = await client.getBalance({ address: addr });
  const reserve = GAS_RESERVE_WEI[chainId];
  return bal > reserve ? bal - reserve : 0n;
}

/** Native balance for any stored wallet (does not use active only). */
export async function getWalletNativeBalance(
  chainId: SupportedChainId,
  walletId: string,
): Promise<bigint> {
  return getNativeBalanceFor(chainId, walletId);
}

async function getNativeBalanceFor(
  chainId: SupportedChainId,
  walletId: string,
): Promise<bigint> {
  const addr = getHotWalletAddress(walletId);
  const client = getPublicClient(chainId);
  return client.getBalance({ address: addr });
}

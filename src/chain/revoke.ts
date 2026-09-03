/**
 * Scan and revoke ERC-20 / Permit2 allowances on hot wallet.
 * Protects against unlimited approvals if a protocol contract is compromised.
 */
import { type Address, type Hash, maxUint256 } from 'viem';
import {
  CHAINS,
  PERMIT2,
  depositAssets,
  txUrl,
  type SupportedChainId,
  SUPPORTED_CHAIN_IDS,
} from '../config.js';
import { erc20Abi, permit2Abi } from './abis.js';
import {
  getHotWalletAddress,
  getPublicClient,
  getWalletClient,
} from './clients.js';
import { getTokenMeta } from './tokens.js';
import { EXECUTION_RECEIPT_TIMEOUT_MS } from './receiptWait.js';

/** Relay contracts commonly approved by bridge quotes (same on RH + BSC Cancun). */
export const RELAY_SPENDERS = {
  erc20Router: '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f' as Address,
  approvalProxy: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be' as Address,
  /** Canonical EVM solver — often receives direct transfer/approval in deposit steps */
  solvers: [
    '0xf70da97812cb96acdf810712aa562db8dfa3dbef',
    '0xa67d7eb4dc68fa6ce8e34ef8cadaf075b9893fbb',
    '0x56c262027e0de4aea31d2489529cb25d23e58a8b',
    '0xabb2acd3be814a80e502575d6c1dc5f789e9cd10',
    '0xada5bb90d0de0bd1b6f3938708f49295a8d1f7cb',
  ] as Address[],
} as const;

/** Across Swap API deposit/spender contracts seen on RH + BSC quotes. */
export const ACROSS_SPENDERS = {
  /** Universal Swap / Spoke entry used by /swap/approval on BSC (and similar) */
  swapEntry: '0x10D8b8DaA26d307489803e10477De69C0492B610' as Address,
} as const;

const MAX_UINT160 = (1n << 160n) - 1n;

export type ApprovalKind = 'erc20' | 'permit2';

export type FoundApproval = {
  chainId: SupportedChainId;
  kind: ApprovalKind;
  token: Address;
  tokenSymbol: string;
  spender: Address;
  spenderLabel: string;
  amount: bigint;
  unlimited: boolean;
};

export type SpenderInfo = { address: Address; label: string };

export function knownSpenders(chainId: SupportedChainId): SpenderInfo[] {
  const c = CHAINS[chainId];
  const out: SpenderInfo[] = [
    { address: PERMIT2, label: 'Permit2' },
    { address: c.swapRouter02, label: 'SwapRouter02' },
    { address: c.npm, label: 'NPM v3' },
    { address: c.v4PositionManager, label: 'v4 POSM' },
    { address: RELAY_SPENDERS.erc20Router, label: 'Relay Router' },
    { address: RELAY_SPENDERS.approvalProxy, label: 'Relay ApprovalProxy' },
    { address: ACROSS_SPENDERS.swapEntry, label: 'Across Swap' },
  ];
  // PancakeSwap V3 on BSC
  if (c.pancakeswapV3) {
    out.push(
      { address: c.pancakeswapV3.npm, label: 'PCS NPM v3' },
      { address: c.pancakeswapV3.swapRouter, label: 'PCS SwapRouter' },
    );
  }
  let i = 0;
  for (const s of RELAY_SPENDERS.solvers) {
    i += 1;
    out.push({ address: s, label: `Relay Solver ${i}` });
  }
  // de-dupe by address
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = x.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Core tokens we always check + optional extra addresses. */
export async function knownTokens(
  chainId: SupportedChainId,
  extras: Address[] = [],
): Promise<{ address: Address; symbol: string }[]> {
  const base = depositAssets(chainId).map((a) => ({
    address: a.address,
    symbol: a.symbol,
  }));
  const seen = new Set(base.map((t) => t.address.toLowerCase()));
  for (const addr of extras) {
    const k = addr.toLowerCase();
    if (seen.has(k) || k === '0x0000000000000000000000000000000000000000') continue;
    seen.add(k);
    try {
      const meta = await getTokenMeta(chainId, addr);
      base.push({ address: addr, symbol: meta.symbol });
    } catch {
      base.push({ address: addr, symbol: addr.slice(0, 8) });
    }
  }
  return base;
}

function isUnlimitedErc20(amount: bigint): boolean {
  // treat near-max as unlimited (bots approve maxUint256)
  return amount >= maxUint256 / 2n;
}

function isUnlimitedPermit2(amount: bigint): boolean {
  return amount >= MAX_UINT160 / 2n;
}

/**
 * Scan ERC-20 allowances (token → spender) and Permit2 allowances
 * (token → v4 POSM via Permit2) for known tokens/spenders.
 */
export async function scanApprovals(
  chainId: SupportedChainId,
  opts?: { extraTokens?: Address[] },
): Promise<FoundApproval[]> {
  const client = getPublicClient(chainId);
  const owner = getHotWalletAddress();
  const tokens = await knownTokens(chainId, opts?.extraTokens ?? []);
  const spenders = knownSpenders(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  const found: FoundApproval[] = [];

  for (const token of tokens) {
    let decimals = 18;
    try {
      const meta = await getTokenMeta(chainId, token.address);
      decimals = meta.decimals;
    } catch {
      /* use 18 */
    }

    for (const sp of spenders) {
      try {
        const amount = await client.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [owner, sp.address],
        });
        if (amount > 0n) {
          found.push({
            chainId,
            kind: 'erc20',
            token: token.address,
            tokenSymbol: token.symbol,
            spender: sp.address,
            spenderLabel: sp.label,
            amount,
            unlimited: isUnlimitedErc20(amount),
          });
        }
      } catch {
        /* token may not implement allowance */
      }
    }

    // Permit2 → POSM (v4 mint path)
    try {
      const [allowedAmt, expiration] = await client.readContract({
        address: PERMIT2,
        abi: permit2Abi,
        functionName: 'allowance',
        args: [owner, token.address, posm],
      });
      const now = Math.floor(Date.now() / 1000);
      if (allowedAmt > 0n && Number(expiration) > now) {
        found.push({
          chainId,
          kind: 'permit2',
          token: token.address,
          tokenSymbol: token.symbol,
          spender: posm,
          spenderLabel: 'Permit2→v4 POSM',
          amount: BigInt(allowedAmt),
          unlimited: isUnlimitedPermit2(BigInt(allowedAmt)),
        });
      }
    } catch {
      /* Permit2 missing or revert */
    }
  }

  // Also Permit2 → SwapRouter02 if any residual
  for (const token of tokens) {
    try {
      const router = CHAINS[chainId].swapRouter02;
      const [allowedAmt, expiration] = await client.readContract({
        address: PERMIT2,
        abi: permit2Abi,
        functionName: 'allowance',
        args: [owner, token.address, router],
      });
      const now = Math.floor(Date.now() / 1000);
      if (allowedAmt > 0n && Number(expiration) > now) {
        found.push({
          chainId,
          kind: 'permit2',
          token: token.address,
          tokenSymbol: token.symbol,
          spender: router,
          spenderLabel: 'Permit2→SwapRouter02',
          amount: BigInt(allowedAmt),
          unlimited: isUnlimitedPermit2(BigInt(allowedAmt)),
        });
      }
    } catch {
      /* ok */
    }
  }

  return found;
}

export async function scanApprovalsMulti(
  chainIds: SupportedChainId[] = [...SUPPORTED_CHAIN_IDS],
): Promise<FoundApproval[]> {
  const all: FoundApproval[] = [];
  for (const id of chainIds) {
    all.push(...(await scanApprovals(id)));
  }
  return all;
}

export type RevokeResult = {
  approval: FoundApproval;
  hash: Hash;
  link: string;
};

/** Set allowance to 0 (ERC-20 approve or Permit2 approve). */
export async function revokeApproval(a: FoundApproval): Promise<RevokeResult> {
  const wallet = getWalletClient(a.chainId);
  const client = getPublicClient(a.chainId);
  const account = wallet.account!;

  let hash: Hash;
  if (a.kind === 'erc20') {
    hash = await wallet.writeContract({
      address: a.token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [a.spender, 0n],
      account,
      chain: wallet.chain,
    });
  } else {
    // amount=0, expiration=0 clears Permit2 allowance
    hash = await wallet.writeContract({
      address: PERMIT2,
      abi: permit2Abi,
      functionName: 'approve',
      args: [a.token, a.spender, 0n, 0],
      account,
      chain: wallet.chain,
    });
  }

  const receipt = await client.waitForTransactionReceipt({ hash, timeout: EXECUTION_RECEIPT_TIMEOUT_MS });
  if (receipt.status === 'reverted') {
    throw new Error(`Revoke tx reverted: ${hash}`);
  }
  return { approval: a, hash, link: txUrl(a.chainId, hash) };
}

export async function revokeAll(
  approvals: FoundApproval[],
  onProgress?: (msg: string, i: number, total: number) => void | Promise<void>,
): Promise<{ ok: RevokeResult[]; failed: { approval: FoundApproval; error: string }[] }> {
  const ok: RevokeResult[] = [];
  const failed: { approval: FoundApproval; error: string }[] = [];
  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i]!;
    await onProgress?.(
      `${a.tokenSymbol} → ${a.spenderLabel} (${CHAINS[a.chainId].name})`,
      i + 1,
      approvals.length,
    );
    try {
      ok.push(await revokeApproval(a));
    } catch (e) {
      failed.push({
        approval: a,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { ok, failed };
}

export function formatApprovalLine(a: FoundApproval, idx?: number): string {
  const chain = CHAINS[a.chainId].name;
  const amt = a.unlimited ? 'unlimited' : `${a.amount.toString()} (raw)`;
  const kind = a.kind === 'permit2' ? 'P2' : 'ERC20';
  const prefix = idx != null ? `${idx}. ` : '';
  return (
    `${prefix}${a.tokenSymbol} → ${a.spenderLabel} (${kind})\n` +
    `   ${chain} · ${amt} · ${a.spender.slice(0, 10)}…`
  );
}

export function formatApprovalsList(list: FoundApproval[]): string {
  if (!list.length) {
    return (
      `🔒 No active approvals found for known tokens/spenders.\n` +
      `Checked: Permit2 · SwapRouter02 · NPM · v4 POSM · Relay.`
    );
  }
  const lines = [
    `🔒 Active approvals (${list.length})`,
    `Revoke unlimited allowances so a compromised protocol can't drain tokens.`,
    ``,
  ];
  list.forEach((a, i) => {
    lines.push(formatApprovalLine(a, i + 1));
  });
  return lines.join('\n');
}

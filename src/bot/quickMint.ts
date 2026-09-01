import type { Address } from 'viem';
import { CHAINS, depositAssets, type SupportedChainId } from '../config.js';
import { listPoolsForToken, type ListedPool } from '../chain/pools.js';
import { describeMintPreview } from '../chain/mint.js';
import { getTokenMeta } from '../chain/tokens.js';
import { getEffectiveDepositBalance } from '../chain/wrap.js';
import type { UserSession } from './session.js';

import type { DepositMode } from '../db/index.js';

const NATIVE = '0x0000000000000000000000000000000000000000';

export function isDepositInPool(
  chainId: SupportedChainId,
  pool: ListedPool,
  deposit: Address,
): boolean {
  const lower = deposit.toLowerCase();
  const t0 = pool.token0.toLowerCase();
  const t1 = pool.token1.toLowerCase();
  if (t0 === lower || t1 === lower) return true;
  const wrapped = CHAINS[chainId].wrapped.toLowerCase();
  // v4 native currency (address zero) pairs with wrapped deposit
  if (lower === wrapped && (t0 === NATIVE || t1 === NATIVE)) return true;
  if (lower === NATIVE && (t0 === wrapped || t1 === wrapped)) return true;
  return false;
}

/** Pick deposit asset from prefs + pool membership. */
export function pickDepositAsset(
  chainId: SupportedChainId,
  pool: ListedPool,
  mode: DepositMode = 'auto',
): { address: Address; symbol: string } | null {
  const assets = depositAssets(chainId);
  const inPool = (a: Address) => isDepositInPool(chainId, pool, a);

  const wrappedAsset = assets.find(
    (a) => a.address.toLowerCase() === CHAINS[chainId].wrapped.toLowerCase(),
  );
  const stable = assets.find(
    (a) =>
      (a.symbol === 'USDG' || a.symbol === 'USDT' || a.symbol === 'USDC') && inPool(a.address),
  );
  const wrappedIn = wrappedAsset && inPool(wrappedAsset.address) ? wrappedAsset : null;

  if (mode === 'wrapped') {
    if (wrappedIn) return wrappedIn;
    // fallback to whatever is in pool
  }
  if (mode === 'stable') {
    if (stable) return stable;
    // fallback — do NOT keep a stable address that isn't in this pool
  }
  // auto / fallback: prefer wrapped (native can auto-wrap), then stable
  if (wrappedIn) return wrappedIn;
  if (stable) return stable;
  for (const a of assets) {
    if (inPool(a.address)) return a;
  }
  return null;
}

/**
 * Balance-aware deposit pick. Prefer settings mode when funded; otherwise pick
 * the pool leg the wallet can actually pay (native+WETH counts for wrapped).
 */
export async function pickDepositAssetSmart(
  chainId: SupportedChainId,
  pool: ListedPool,
  mode: DepositMode = 'auto',
): Promise<{ address: Address; symbol: string; note?: string } | null> {
  const preferred = pickDepositAsset(chainId, pool, mode);
  const candidates: { address: Address; symbol: string }[] = [];
  const seen = new Set<string>();
  const push = (a: { address: Address; symbol: string } | null | undefined) => {
    if (!a) return;
    const k = a.address.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    candidates.push(a);
  };
  push(preferred);
  push(pickDepositAsset(chainId, pool, 'wrapped'));
  push(pickDepositAsset(chainId, pool, 'stable'));
  push(pickDepositAsset(chainId, pool, 'auto'));

  if (!candidates.length) return null;

  type Scored = {
    address: Address;
    symbol: string;
    effective: bigint;
    note?: string;
  };
  const scored: Scored[] = [];
  for (const c of candidates) {
    try {
      const eff = await getEffectiveDepositBalance(chainId, c.address);
      scored.push({ ...c, effective: eff.effective });
    } catch {
      scored.push({ ...c, effective: 0n });
    }
  }

  // Prefer preferred if it has any balance (incl. wrappable native for WETH)
  if (preferred) {
    const pref = scored.find(
      (s) => s.address.toLowerCase() === preferred.address.toLowerCase(),
    );
    if (pref && pref.effective > 0n) {
      return {
        address: pref.address,
        symbol: pref.symbol,
        note:
          preferred.symbol !== pref.symbol
            ? undefined
            : mode !== 'auto'
              ? `deposit mode ${mode}`
              : undefined,
      };
    }
  }

  // Else: highest effective balance among pool deposit assets
  scored.sort((a, b) => (a.effective < b.effective ? 1 : a.effective > b.effective ? -1 : 0));
  const best = scored[0]!;
  if (best.effective > 0n) {
    const switched =
      preferred && preferred.address.toLowerCase() !== best.address.toLowerCase();
    return {
      address: best.address,
      symbol: best.symbol,
      note: switched
        ? `auto-switched from ${preferred!.symbol} (unfunded) → ${best.symbol} (funded)`
        : undefined,
    };
  }

  // Nothing funded — still return preferred/best so mint can wrap or clear-error
  if (preferred) return { ...preferred, note: 'no balance yet — wrap/swap may fund' };
  return { address: best.address, symbol: best.symbol };
}

function isStableAddr(chainId: SupportedChainId, addr: string): boolean {
  const c = CHAINS[chainId];
  const a = addr.toLowerCase();
  if (c.usdg && c.usdg.toLowerCase() === a) return true;
  if (c.usdt && c.usdt.toLowerCase() === a) return true;
  if (c.usdc && c.usdc.toLowerCase() === a) return true;
  return false;
}

function isEthSideSymbol(sym: string): boolean {
  const s = sym.toUpperCase();
  return s === 'ETH' || s === 'WETH' || s === 'BNB' || s === 'WBNB';
}

/**
 * Deposit legs from live pool currencies.
 * For v3 meme/ETH: the deposit MUST be the pool's exact non-meme token address
 * (not a guessed config WETH if addresses differ).
 * Native (0x0) → config wrapped for funding/wrap.
 */
export async function knownDepositLegsInPool(
  chainId: SupportedChainId,
  currencyA: Address,
  currencyB: Address,
  /** When set (pasted CA), only the other side is a deposit candidate */
  memeToken?: Address,
): Promise<{ address: Address; symbol: string }[]> {
  const c = CHAINS[chainId];
  const wrapped = c.wrapped;
  const meme = memeToken?.toLowerCase();
  const out: { address: Address; symbol: string }[] = [];
  const seen = new Set<string>();

  const add = (address: Address, symbol: string) => {
    const k = address.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ address, symbol });
  };

  for (const raw of [currencyA, currencyB]) {
    const lower = raw.toLowerCase();
    if (meme && lower === meme) continue; // never deposit the meme for single-sided

    if (lower === NATIVE) {
      add(wrapped, c.wrappedSymbol);
      continue;
    }

    let symbol = '?';
    try {
      symbol = (await getTokenMeta(chainId, raw)).symbol;
    } catch {
      /* */
    }

    const isWrapped = lower === wrapped.toLowerCase();
    const isStable = isStableAddr(chainId, lower);
    const ethSide = isWrapped || isEthSideSymbol(symbol);

    // Always accept wrapped / stable / eth-side; with memeToken any non-meme side is ok
    if (isWrapped || isStable || ethSide || meme) {
      // Prefer canonical config.wrapped address when this IS our WETH (same addr)
      if (isWrapped) add(wrapped, c.wrappedSymbol);
      else add(raw, symbol);
    }
  }

  return out;
}

/**
 * Resolve deposit from on-chain pool currencies (not stale session token).
 * Dep Auto always re-picks from the pool; manual asset pick only kept if still valid.
 *
 * @param memeToken optional pasted CA — deposit = the other pool token (exact address)
 */
export async function resolveDepositForPool(
  chainId: SupportedChainId,
  pool: ListedPool,
  mode: DepositMode,
  current?: Address,
  /** true when user explicitly tapped Asset… — keep if still in pool */
  userPicked = false,
  memeToken?: Address,
): Promise<{ address: Address; symbol: string; note?: string }> {
  // Prefer live currencies (v4 key / listed addresses)
  let c0 = pool.token0;
  let c1 = pool.token1;
  if (pool.protocol === 'v4' && pool.poolKey) {
    c0 = pool.poolKey.currency0;
    c1 = pool.poolKey.currency1;
  } else if (pool.protocol === 'v3' || !pool.protocol) {
    try {
      // Read raw token0/token1 from the pool contract (authoritative)
      const { getPublicClient } = await import('../chain/clients.js');
      const { poolAbi } = await import('../chain/abis.js');
      const client = getPublicClient(chainId);
      const poolAddr = pool.poolAddress as Address;
      const [t0, t1] = await Promise.all([
        client.readContract({
          address: poolAddr,
          abi: poolAbi,
          functionName: 'token0',
        }),
        client.readContract({
          address: poolAddr,
          abi: poolAbi,
          functionName: 'token1',
        }),
      ]);
      c0 = t0 as Address;
      c1 = t1 as Address;
    } catch {
      try {
        const { loadPool } = await import('../chain/pools.js');
        const live = await loadPool(chainId, pool.poolAddress as Address);
        c0 = live.token0.address;
        c1 = live.token1.address;
      } catch {
        /* use listed */
      }
    }
  }

  // Infer meme side: pasted CA if it is in the pool; else listed otherAddress is often the quote
  let memeCa = memeToken;
  if (memeCa) {
    const m = memeCa.toLowerCase();
    if (m !== c0.toLowerCase() && m !== c1.toLowerCase()) {
      // CA not a pool currency (shouldn't happen) — ignore filter
      memeCa = undefined;
    }
  }

  let legs = await knownDepositLegsInPool(chainId, c0, c1, memeCa);
  if (!legs.length) {
    legs = await knownDepositLegsInPool(chainId, c0, c1, undefined);
  }
  if (!legs.length) {
    throw new Error(
      `No deposit leg in pool (${c0.slice(0, 10)}…/${c1.slice(0, 10)}…). ` +
        `Can't single-side — pick another pool.`,
    );
  }

  // Manual pick: keep only if it's still a known leg of THIS pool
  if (userPicked && current) {
    const keep = legs.find((l) => l.address.toLowerCase() === current.toLowerCase());
    if (keep) {
      return { address: keep.address, symbol: keep.symbol, note: 'user-picked deposit' };
    }
  }

  // Score legs by effective balance (config WETH includes wrappable native)
  type Scored = { address: Address; symbol: string; effective: bigint };
  const scored: Scored[] = [];
  for (const leg of legs) {
    try {
      const eff = await getEffectiveDepositBalance(chainId, leg.address);
      scored.push({ ...leg, effective: eff.effective });
    } catch {
      scored.push({ ...leg, effective: 0n });
    }
  }

  const wrappedAddr = CHAINS[chainId].wrapped.toLowerCase();
  let pick: Scored | undefined;

  if (mode === 'wrapped') {
    pick =
      scored.find((s) => s.address.toLowerCase() === wrappedAddr) ??
      scored.find((s) => isEthSideSymbol(s.symbol));
  } else if (mode === 'stable') {
    pick = scored.find((s) => isStableAddr(chainId, s.address));
  }

  // Dep Auto / fallback: prefer eth-side if funded (native+WETH), else best funded
  if (!pick || mode === 'auto') {
    const funded = scored.filter((s) => s.effective > 0n);
    if (funded.length) {
      const ethFunded = funded.find(
        (s) => s.address.toLowerCase() === wrappedAddr || isEthSideSymbol(s.symbol),
      );
      if (mode === 'auto' && ethFunded) pick = ethFunded;
      else {
        funded.sort((a, b) => (a.effective < b.effective ? 1 : -1));
        pick = funded[0];
      }
    } else {
      pick =
        scored.find((s) => s.address.toLowerCase() === wrappedAddr) ??
        scored.find((s) => isEthSideSymbol(s.symbol)) ??
        scored[0];
    }
  }

  if (!pick) {
    const funded = scored.filter((s) => s.effective > 0n);
    funded.sort((a, b) => (a.effective < b.effective ? 1 : -1));
    pick = funded[0] ?? scored[0];
  }

  if (!pick) {
    throw new Error('Could not resolve deposit token for pool');
  }

  // Critical: deposit address must be the exact on-chain pool token.
  // If we resolved config.wrapped, map to whichever pool token is the eth-side.
  let depositAddr = pick.address;
  const c0l = c0.toLowerCase();
  const c1l = c1.toLowerCase();
  const pickL = pick.address.toLowerCase();
  if (pickL === wrappedAddr) {
    if (c0l === wrappedAddr || c0l === NATIVE) {
      // deposit stays wrapped (native pool → WETH funding; v3 WETH pool → WETH)
      depositAddr = c0l === NATIVE ? CHAINS[chainId].wrapped : c0;
    } else if (c1l === wrappedAddr || c1l === NATIVE) {
      depositAddr = c1l === NATIVE ? CHAINS[chainId].wrapped : c1;
    } else {
      // Pool eth-side is a different address (symbol ETH) — use that exact token
      try {
        const m0 = await getTokenMeta(chainId, c0);
        const m1 = await getTokenMeta(chainId, c1);
        if (isEthSideSymbol(m0.symbol) && (!memeCa || c0l !== memeCa.toLowerCase())) {
          depositAddr = c0;
        } else if (isEthSideSymbol(m1.symbol) && (!memeCa || c1l !== memeCa.toLowerCase())) {
          depositAddr = c1;
        }
      } catch {
        /* keep pick */
      }
    }
  }

  // Final: deposit must equal c0 or c1 (or wrapped when pool has native)
  let d = depositAddr.toLowerCase();
  const inPool =
    d === c0l ||
    d === c1l ||
    (d === wrappedAddr && (c0l === NATIVE || c1l === NATIVE));
  if (!inPool) {
    // Force the non-meme pool currency (exact address)
    if (memeCa) {
      const m = memeCa.toLowerCase();
      const other = c0l === m ? c1 : c1l === m ? c0 : c0;
      depositAddr = other.toLowerCase() === NATIVE ? CHAINS[chainId].wrapped : other;
    } else {
      try {
        const m0 = await getTokenMeta(chainId, c0);
        const m1 = await getTokenMeta(chainId, c1);
        if (isEthSideSymbol(m0.symbol) || isStableAddr(chainId, c0l)) {
          depositAddr = c0l === NATIVE ? CHAINS[chainId].wrapped : c0;
        } else if (isEthSideSymbol(m1.symbol) || isStableAddr(chainId, c1l)) {
          depositAddr = c1l === NATIVE ? CHAINS[chainId].wrapped : c1;
        } else {
          depositAddr = c0l === NATIVE ? CHAINS[chainId].wrapped : c0;
        }
      } catch {
        depositAddr = c0l === NATIVE ? CHAINS[chainId].wrapped : c0;
      }
    }
    d = depositAddr.toLowerCase();
  }

  let symbol = pick.symbol;
  try {
    symbol = (await getTokenMeta(chainId, depositAddr)).symbol;
  } catch {
    /* */
  }
  // Normalize display for our WETH
  if (depositAddr.toLowerCase() === wrappedAddr) {
    symbol = CHAINS[chainId].wrappedSymbol;
  }

  let effective = 0n;
  try {
    effective = (await getEffectiveDepositBalance(chainId, depositAddr)).effective;
  } catch {
    /* */
  }

  const notes: string[] = [];
  if (mode === 'auto') {
    notes.push(`Dep Auto → ${symbol}`);
  }
  notes.push(`pool token ${depositAddr.slice(0, 10)}…`);
  if (depositAddr.toLowerCase() === wrappedAddr && effective > 0n) {
    notes.push('native auto-wrap if WETH short');
  }

  return {
    address: depositAddr,
    symbol,
    note: notes.join(' · '),
  };
}

export async function buildQuickMintConfirm(
  s: UserSession,
  ca: Address,
): Promise<{
  text: string;
  pool: ListedPool;
  depositToken: Address;
  depositSymbol: string;
  priceMismatch: boolean;
}> {
  if (!s.chainId) throw new Error('No chain set — /settings or /chain first');

  const { DEFAULT_PREFS } = await import('../db/index.js');
  const minTvl = DEFAULT_PREFS.minTvlUsd;
  const pools = await listPoolsForToken(s.chainId, ca, minTvl);
  if (!pools.length) {
    throw new Error(
      `No Uniswap v3/v4 pools (min TVL $${minTvl.toLocaleString()}) — paste CA in chat to create a v4 pool`,
    );
  }

  const pool = pools[0]!;
  const dep = pickDepositAsset(s.chainId, pool, s.depositMode ?? 'auto');
  if (!dep) {
    throw new Error(
      `No deposit asset (WETH/USDG/USDT/USDC) in top pool ${pool.poolAddress}. Change deposit mode in /settings.`,
    );
  }

  const meta = await getTokenMeta(s.chainId, dep.address);
  const detail = await describeMintPreview({
    chainId: s.chainId,
    poolAddress: pool.poolAddress,
    depositToken: dep.address,
    balancePercent: s.balancePercent,
    widthPercent: s.widthPercent,
    protocol: pool.protocol,
    poolKey: pool.poolKey,
    poolId: pool.poolId,
  });
  s.mintPriceMismatch = detail.priceMismatch;

  const tvl =
    pool.tvlUsd >= 1000
      ? `$${(pool.tvlUsd / 1000).toFixed(1)}k`
      : `$${pool.tvlUsd.toFixed(0)}`;

  const ver =
    pool.protocol === 'v4'
      ? 'v4'
      : pool.dex === 'pancakeswap'
        ? 'PCS v3'
        : 'UNI v3';
  const text =
    `Confirm mint · ${CHAINS[s.chainId].name} · ${ver}\n` +
    `${pool.otherSymbol} · fee ${((pool.fee ?? 0) / 10000).toFixed(2)}% · TVL ${tvl}\n` +
    `width ${s.widthPercent}% · ${meta.symbol}\n\n` +
    `${detail.text}`;

  return {
    text,
    pool,
    depositToken: dep.address,
    depositSymbol: meta.symbol,
    priceMismatch: detail.priceMismatch,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

/** Legacy single-wallet file shape */
export type HotWalletFile = {
  address: Address;
  privateKey: Hex;
  createdAt: string;
  note: string;
};

export type WalletSource = 'env' | 'generated' | 'imported' | 'legacy';

export type StoredWallet = {
  id: string;
  label: string;
  address: Address;
  privateKey: Hex;
  createdAt: string;
  source: WalletSource;
};

export type WalletsFile = {
  version: 1;
  activeWalletId: string;
  wallets: StoredWallet[];
};

const DEFAULT_LEGACY_PATH = './data/hot-wallet.json';
const DEFAULT_WALLETS_PATH = './data/wallets.json';

let _store: WalletsFile | null = null;
let _walletsPath = '';
let _onActiveChange: (() => void) | null = null;

/** Register callback when active wallet changes (clients invalidate cache). */
export function onActiveWalletChange(cb: () => void): void {
  _onActiveChange = cb;
}

function walletsPath(): string {
  return path.resolve(process.env.WALLETS_PATH ?? DEFAULT_WALLETS_PATH);
}

function legacyPath(): string {
  return path.resolve(process.env.WALLET_PATH ?? DEFAULT_LEGACY_PATH);
}

export function normalizePk(pk: string): Hex {
  const p = (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(p)) {
    throw new Error('Private key must be a 32-byte hex key (64 hex chars, optional 0x)');
  }
  return p;
}

function newWalletId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function defaultLabel(index: number, address: Address): string {
  return `Wallet ${index} (${shortAddr(address)})`;
}

function persist(): void {
  if (!_store) return;
  fs.mkdirSync(path.dirname(_walletsPath), { recursive: true });
  fs.writeFileSync(_walletsPath, JSON.stringify(_store, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(_walletsPath, 0o600);
  } catch {
    // Windows may ignore chmod
  }
}

function makeWallet(
  privateKey: Hex,
  source: WalletSource,
  label?: string,
  index = 1,
): StoredWallet {
  const account = privateKeyToAccount(privateKey);
  return {
    id: newWalletId(),
    label: label?.trim() || defaultLabel(index, account.address),
    address: account.address,
    privateKey,
    createdAt: new Date().toISOString(),
    source,
  };
}

function migrateFromLegacy(): WalletsFile {
  const fromEnv = process.env.PRIVATE_KEY?.trim();
  if (fromEnv) {
    const privateKey = normalizePk(fromEnv);
    const w = makeWallet(privateKey, 'env', 'Env wallet', 1);
    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log('  MULTI-WALLET: loaded PRIVATE_KEY as wallet #1');
    console.log(`  Address: ${w.address}`);
    console.log('══════════════════════════════════════════════════');
    console.log('');
    return { version: 1, activeWalletId: w.id, wallets: [w] };
  }

  const legacy = legacyPath();
  if (fs.existsSync(legacy)) {
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8')) as HotWalletFile;
    if (!raw.privateKey) throw new Error(`Invalid wallet file (missing privateKey): ${legacy}`);
    const privateKey = normalizePk(raw.privateKey);
    const account = privateKeyToAccount(privateKey);
    const w = makeWallet(privateKey, 'legacy', 'Main (legacy)', 1);
    // Prefer file address if present and matches
    if (raw.address && raw.address.toLowerCase() !== account.address.toLowerCase()) {
      console.warn(
        `Legacy wallet address mismatch (file=${raw.address}, derived=${account.address}); using derived.`,
      );
    }
    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log('  MULTI-WALLET: migrated legacy hot-wallet.json');
    console.log(`  Address: ${w.address}`);
    console.log(`  From: ${legacy}`);
    console.log('══════════════════════════════════════════════════');
    console.log('');
    return { version: 1, activeWalletId: w.id, wallets: [w] };
  }

  // First run — generate
  const privateKey = generatePrivateKey();
  const w = makeWallet(privateKey, 'generated', 'Main', 1);
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  NEW HOT WALLET GENERATED (first run)');
  console.log(`  Address: ${w.address}`);
  console.log(`  Multi-wallet store: ${walletsPath()}`);
  console.log('  Fund this wallet on Robinhood (4663), BSC (56), and/or Base (8453).');
  console.log('  NEVER commit this file. Back it up securely.');
  console.log('══════════════════════════════════════════════════');
  console.log('');
  return { version: 1, activeWalletId: w.id, wallets: [w] };
}

function loadStore(): WalletsFile {
  if (_store) return _store;
  _walletsPath = walletsPath();
  fs.mkdirSync(path.dirname(_walletsPath), { recursive: true });

  if (fs.existsSync(_walletsPath)) {
    const raw = JSON.parse(fs.readFileSync(_walletsPath, 'utf8')) as WalletsFile;
    if (!raw.wallets?.length || !raw.activeWalletId) {
      throw new Error(`Invalid wallets file: ${_walletsPath}`);
    }
    // Normalize keys + re-derive addresses
    for (const w of raw.wallets) {
      w.privateKey = normalizePk(w.privateKey);
      const account = privateKeyToAccount(w.privateKey);
      w.address = account.address;
    }
    if (!raw.wallets.some((w) => w.id === raw.activeWalletId)) {
      raw.activeWalletId = raw.wallets[0]!.id;
    }
    _store = raw;
    return _store;
  }

  _store = migrateFromLegacy();
  persist();
  return _store;
}

/** Boot / ensure store ready. Same return shape as legacy resolvePrivateKey. */
export function resolvePrivateKey(): {
  privateKey: Hex;
  address: Address;
  source: 'env' | 'file' | 'generated';
  walletPath: string;
} {
  const store = loadStore();
  const active = store.wallets.find((w) => w.id === store.activeWalletId) ?? store.wallets[0]!;
  const source: 'env' | 'file' | 'generated' =
    active.source === 'env' ? 'env' : active.source === 'generated' ? 'generated' : 'file';
  return {
    privateKey: active.privateKey,
    address: active.address,
    source,
    walletPath: _walletsPath || walletsPath(),
  };
}

export function listWallets(): StoredWallet[] {
  return loadStore().wallets.map((w) => ({ ...w }));
}

export function getActiveWallet(): StoredWallet {
  const store = loadStore();
  const w = store.wallets.find((x) => x.id === store.activeWalletId) ?? store.wallets[0];
  if (!w) throw new Error('No wallets configured');
  return { ...w };
}

export function getWalletById(id: string): StoredWallet | null {
  const w = loadStore().wallets.find((x) => x.id === id);
  return w ? { ...w } : null;
}

export function getActiveWalletId(): string {
  return loadStore().activeWalletId;
}

export function setActiveWallet(id: string): StoredWallet {
  const store = loadStore();
  const w = store.wallets.find((x) => x.id === id);
  if (!w) throw new Error(`Wallet not found: ${id}`);
  if (store.activeWalletId === id) return { ...w };
  store.activeWalletId = id;
  persist();
  _onActiveChange?.();
  return { ...w };
}

export function generateWallet(label?: string): StoredWallet {
  const store = loadStore();
  const privateKey = generatePrivateKey();
  const w = makeWallet(privateKey, 'generated', label, store.wallets.length + 1);
  store.wallets.push(w);
  persist();
  return { ...w };
}

export function importWallet(privateKeyRaw: string, label?: string): StoredWallet {
  const store = loadStore();
  const privateKey = normalizePk(privateKeyRaw.trim());
  const account = privateKeyToAccount(privateKey);
  const dup = store.wallets.find(
    (w) => w.address.toLowerCase() === account.address.toLowerCase(),
  );
  if (dup) {
    throw new Error(`Wallet already imported: ${dup.label} (${shortAddr(dup.address)})`);
  }
  const w = makeWallet(privateKey, 'imported', label, store.wallets.length + 1);
  store.wallets.push(w);
  persist();
  return { ...w };
}

export function renameWallet(id: string, label: string): StoredWallet {
  const store = loadStore();
  const w = store.wallets.find((x) => x.id === id);
  if (!w) throw new Error(`Wallet not found: ${id}`);
  const cleaned = label.trim().slice(0, 48);
  if (!cleaned) throw new Error('Label cannot be empty');
  w.label = cleaned;
  persist();
  return { ...w };
}

/**
 * Remove a wallet. Cannot remove the last wallet.
 * If removing active, switches to another.
 */
export function removeWallet(id: string): { removed: StoredWallet; newActive: StoredWallet } {
  const store = loadStore();
  if (store.wallets.length <= 1) {
    throw new Error('Cannot delete the last wallet');
  }
  const idx = store.wallets.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error(`Wallet not found: ${id}`);
  const [removed] = store.wallets.splice(idx, 1);
  if (store.activeWalletId === id) {
    store.activeWalletId = store.wallets[0]!.id;
    _onActiveChange?.();
  }
  persist();
  const newActive = store.wallets.find((x) => x.id === store.activeWalletId) ?? store.wallets[0]!;
  return { removed: { ...removed! }, newActive: { ...newActive } };
}

export function formatWalletLine(w: StoredWallet, activeId?: string): string {
  const aid = activeId ?? getActiveWalletId();
  const star = w.id === aid ? '★ ' : '  ';
  return `${star}${w.label} · \`${shortAddr(w.address)}\``;
}

export function shortAddress(addr: string): string {
  return shortAddr(addr);
}

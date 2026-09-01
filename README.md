# Uniswap v3/v4 + PancakeSwap V3 LP Telegram Bot

Telegram bot for **single-sided Uniswap v3 & v4 LP** on **Robinhood Chain (4663)**, **BSC (56)**, and **Base (8453)** — plus **PancakeSwap V3** on BSC.

Paste a token CA → confirm → mint. Manage positions, close LP, and swap leftover tokens to native.

## Features

| Feature | Description |
|---------|-------------|
| **Quick mint** | Paste CA → auto top-TVL **v3 or v4** pool → confirm (uses saved settings) |
| **Screener** | `/screener` — GMGN market trending · configurable filters · tap 🚀 Mint |
| **PancakeSwap V3 (BSC)** | Auto-merged with Uniswap by TVL · mint / list / claim / close |
| **v4 pools** | DexScreener discovery · PositionManager mint/burn · StateView reads |
| **Settings** | Full inline menu: chain, range width, amount %, deposit mode, close zapout |
| **Single-sided LP** | Correct Uniswap orientation (token0 above market / token1 below) |
| **Auto-wrap** | Native → WETH/WBNB when depositing wrapped |
| **List / close** | Compact positions + close buttons (v3 NPM + v4 POSM) |
| **Zapout (GMGN)** | After close: meme legs → native/stable via `gmgn-cli` (hard-required) |
| **PnL** | Deposit / withdrawal ledger + live mark (DexScreener) |
| **Tokens** | List non-core ERC-20s · sell → native via GMGN |
| **Bridge** | Robinhood ↔ BSC ↔ Base — best quote from [Relay](https://relay.link) + [Across](https://across.to) |
| **Swap** | `/swap` same-chain native ↔ stable (Relay + Across) · custom CA via Uniswap |
| **Revoke** | `/revoke` zeros unlimited ERC-20/Permit2 allowances |
| **Multi-wallet** | Generate / import PK · select active · transfer between wallets |

## Stack

- TypeScript · Node.js · [grammY](https://grammy.dev) · [viem](https://viem.sh)
- `@uniswap/v3-sdk` · `@uniswap/v4-sdk` · `@uniswap/sdk-core`
- DexScreener API · JSON local ledger (`data/`)

## Quick start

```bash
git clone <your-repo-url>
cd lp-uniswap
cp .env.example .env
# edit .env — see below
npm install
npm run dev
```

### Required env

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_USER_IDS` | Your Telegram numeric user id(s), comma-separated |

### Recommended env

| Variable | Description |
|----------|-------------|
| `RPC_4663` | Robinhood RPC (Alchemy/QuickNode recommended) |
| `RPC_56` | BSC RPC |
| `RPC_8453` | Base RPC (default `https://mainnet.base.org`) |
| `PRIVATE_KEY` | Optional seed for first wallet; else migrates `data/hot-wallet.json` or generates `data/wallets.json` |
| `RELAY_API_KEY` | Optional; higher rate limits for `/bridge` ([get key](https://docs.relay.link/references/api/api-keys)) |
| `ACROSS_API_KEY` | Optional; Across Swap API for best-quote aggregation with Relay ([docs](https://docs.across.to/api-reference)) |
| `ACROSS_INTEGRATOR_ID` | Optional; Across integrator id (required with `ACROSS_API_KEY`) |
| `UNISWAP_API_KEY` | Optional; Uniswap Trading API for `/swap` custom CA ([portal](https://developers.uniswap.org/)) — **not** used for close zapout |
| `GMGN_CLI_PATH` | Optional; path to `gmgn-cli` (default: `gmgn-cli` on PATH) |
| `GMGN_SLIPPAGE_PCT` | Optional; zapout / meme-sell slippage percent (default `15`) |
| `GMGN_SWAP_MODE` | Optional; `local` (default) or `managed` — see SECURITY.md |

**GMGN setup (required for zapout, `/tokens` sell, `/screener`):**

```bash
# install gmgn-cli, then:
gmgn-cli config   # writes keypair / opens API key flow → ~/.config/gmgn/
```

Without a GMGN API key, positions still close but auto-swap (zapout) and screener fail clearly.

## Security (read this)

**Do not commit:**

- `.env`
- `data/wallets.json` / `data/hot-wallet.json` (private keys)
- `data/bot.json` (ledger, Telegram ids, prefs)

These are gitignored. Before publishing:

```bash
# confirm secrets are not tracked
git status
# should NOT list .env or data/*.json
```

If you ever committed a key/token:

1. **Revoke** Telegram bot token in BotFather  
2. **Rotate** Alchemy/RPC keys  
3. **Move funds** off the exposed wallet and generate a new key  

This bot is **custodial** (hot wallet keys stored locally). Manage multiple wallets via `/wallet`. Only add trusted Telegram user ids.

## Commands

| Command | Action |
|---------|--------|
| `/start` | Help + settings menu |
| `/settings` | Chain, width %, amount %, deposit mode, close zapout (inline) |
| `/screener` | GMGN trending with filters · tap **Mint** |
| `/wallet` | Multi-wallet: balances · select · generate · import PK · transfer |
| `/bridge` | Bridge Robinhood ↔ BSC ↔ Base (Relay + Across) |
| `/swap` | Same-chain native ↔ stable (Relay) |
| `/revoke` | Scan & revoke unlimited token approvals |
| `/list` | Positions + **Close** buttons |
| `/close` | Close menu |
| `/tokens` | Non-core tokens · sell → native via GMGN |
| `/pnl` | Portfolio summary |
| `/add` | Full mint wizard (pick pool) |
| `/cancel` | Reset flow |

**Quick mint:** set `/settings` once → paste token CA (or `/screener` → Mint) → Confirm.

### Screener defaults

| Filter | Default | CLI flag |
|--------|---------|----------|
| Interval | `6h` | `--interval` |
| Min volume | `$300k` | `--min-volume` |
| Min KOL | `10` | `--min-renowned-count` |
| Min total fees | `0.5` | `--min-gas-fee` |
| Min market cap | `$500k` | `--min-marketcap` |

Uses the **active settings chain**. Edit via ⚙️ Filters on the screener message.

## Config notes

Official Uniswap v3/v4 and PancakeSwap V3 addresses (factory, NPM, routers, WETH/WBNB) live in `src/config.ts` — these are **public** deployment addresses, not secrets.

On **BSC**, pool discovery merges Uniswap + PancakeSwap V3 (sorted by TVL). Labels show `UNI` / `PCS`.

USDG on Robinhood: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (chain public token list).

### Bridge (Relay + Across)

`/bridge` quotes both providers and picks the best output:

| Chain | Assets |
|-------|--------|
| Robinhood (4663) | USDG · ETH · WETH |
| BSC (56) | USDT · BNB · WBNB |
| Base (8453) | USDC · ETH · WETH |

All pairwise directions are available. Same-kind pairs are suggested (USDG↔USDT↔USDC, ETH↔BNB, WETH↔WBNB); cross pairs work too. Native deposits keep a small gas reserve.

## Scripts

```bash
npm run dev        # development
npm run build      # compile to dist/
npm start          # node dist/index.js
npm run typecheck
```

Debug helpers under `scripts/` are for local dev only (hardcoded example pools).

## License

MIT — use at your own risk. Smart contract and trading activity can lose funds.

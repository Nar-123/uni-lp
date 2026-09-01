# Security

## Never commit

| Path | Why |
|------|-----|
| `.env` | Bot token, Telegram ids, RPC keys, optional private key |
| `data/wallets.json` | Multi-wallet private keys (active + imports) |
| `data/hot-wallet.json` | Legacy single hot wallet private key |
| `data/bot.json` | User prefs, ledger, Telegram user ids |

## Hot wallets

- Stored in `data/wallets.json` (multi-wallet: generate / import via `/wallet`)
- Migrates legacy `PRIVATE_KEY` or `data/hot-wallet.json` on first multi-wallet boot
- Active wallet has full control of funds for mint/swap/bridge
- Back up offline; import/reveal PK only in private chats; delete key messages after use

## Allowlist

Only `TELEGRAM_USER_IDS` can use the bot. Empty/misconfigured allowlist will refuse startup or unauthorized users.

## GMGN (zapout / screener / /tokens sell)

Close auto-swap (zapout), leftover meme sells (`/tokens`), and `/screener` all go through
`gmgn-cli`. The bot process **never reads** `GMGN_API_KEY` — credentials stay in
`~/.config/gmgn/` and are loaded by the CLI.

### Local mode (default, preferred)

1. `gmgn-cli order quote` returns an unsigned transaction.
2. This bot signs and broadcasts with its own hot key.
3. GMGN never holds the LP wallet private key.

### Managed mode (opt-in only)

`GMGN_SWAP_MODE=managed` makes `gmgn-cli swap` sign from the wallet bound to your
GMGN API key. That requires importing the hot wallet key into GMGN.

- A GMGN compromise reaches the same funds as a bot compromise.
- Requires `GMGN_WALLET_ADDRESS` (must match the active hot wallet) and
  `GMGN_ALLOW_AUTOMATED_TRADES=1`.
- Prefer local mode for any wallet that holds real size.

### Invocation safety

- Always `execFile` with an argument array — never a shell string.
- Addresses are validated (`0x` + 40 hex) before becoming argv.
- Token `name` / `symbol` from GMGN are attacker-controlled: display-only,
  sanitized for Telegram HTML, never interpolated into commands.

### Fail closed

Without `gmgn-cli` or a valid API key, **zapout and meme sells fail** with a clear
error. Positions still close (liquidity is returned); leftovers stay in the wallet
until GMGN is configured.

## Reporting

If you find a vulnerability in this repo, open a private security advisory or contact the maintainer. Do not open a public issue with live keys or funded addresses.

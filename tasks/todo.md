# GMGN Zapout + Screener

## Plan
- [x] Port multi-chain `src/gmgn/cli.ts` + `swap.ts`
- [x] Hard-wire `swapAfterClose` → GMGN (no Uniswap fallback)
- [x] `/tokens` sell via GMGN
- [x] Screener prefs in `db/index.ts`
- [x] `/screener` + rich HTML UI + filters + mint handoff
- [x] README / .env.example / SECURITY
- [x] Typecheck

## Review
- Zapout path: close → balance delta → `gmgnSellAmount` for meme/stable; unwrap WETH locally
- Hard-require: missing CLI/key → clear error; position still closed
- Screener: `market trending` with 6h / vol 300k / KOL 10 / fees 0.5 / mc 500k
- UI: Telegram HTML (bold, italic, code, blockquote, links) + mint / page / filter keyboards
- Credentials stay in `~/.config/gmgn/`; `execFile` only

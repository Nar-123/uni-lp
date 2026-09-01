# Local debug scripts

These scripts load your local `.env` and hot wallet. They hardcode **public** pool addresses for ad-hoc testing.

**Do not run them with a funded key you care about unless you understand the txs.**

```bash
# from repo root, with .env configured
npx tsx scripts/debug-mint.ts
```

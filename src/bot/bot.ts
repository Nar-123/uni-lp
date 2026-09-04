import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import {
  CHAINS,
  RANGE_PRESETS,
  SUPPORTED_CHAIN_IDS,
  assertAddress,
  config,
  depositAssets,
  dexCode,
  dexLabel,
  isSupportedChainId,
  parseDexCode,
  primaryStableAddress,
  primaryStableSymbol,
  txUrl,
  type DexId,
  type SupportedChainId,
} from '../config.js';
import { requireAuth } from './auth.js';
import {
  getSession,
  resetFlow,
  clearBridgeSession,
  clearSwapSession,
  clearRevokeSession,
  clearWrapSession,
  clearWalletSession,
  syncSessionFromPrefs,
  type UserSession,
} from './session.js';
import { getHotWalletAddress } from '../chain/clients.js';
import {
  transferBetweenWallets,
  getTransferableNative,
} from '../chain/transfer.js';
import {
  listWallets,
  getActiveWallet,
  getActiveWalletId,
  setActiveWallet,
  generateWallet,
  importWallet,
  removeWallet,
  renameWallet,
  getWalletById,
  formatWalletLine,
  shortAddress,
  normalizePk,
} from '../wallet/keys.js';
import {
  isAddressHex,
  isV4PoolIdHex,
  listPoolsForToken,
  resolveListedPoolFromPaste,
} from '../chain/pools.js';
import { describeMintPreview, mintSingleSided } from '../chain/mint.js';
import { formatPositionLine, listPositions, listPositionsFast } from '../chain/positions.js';
import { claimFees, closePosition } from '../chain/close.js';
import { formatCompactRange, uniswapPositionUrl } from '../chain/prices.js';
import {
  formatUnits,
  getTokenBalance,
  getTokenMeta,
  parsePercentOfBalance,
  humanToFloat,
  humanToRaw,
} from '../chain/tokens.js';
import {
  getEffectiveDepositBalance,
  getNativeBalance,
  getWrappableNative,
  wrapNative,
  unwrapNative,
} from '../chain/wrap.js';
import { formatUsd, getTokenPriceUsd, valueUsd } from '../price/dexscreener.js';
import {
  markClosed,
  recordLedger,
  recordOpenPosition,
  setUserPrefs,
  getUserPrefs,
  setPositionLabel,
  formatSizePref,
  FIXED_AMOUNT_PRESETS,
  MIN_TVL_PRESETS,
  getTrackedPosition,
  listTrackedPositions,
  setPositionTpSl,
  listTpSlEnrolledPositions,
  parseWidthPercent,
  parseMinTvlUsd,
  setJournalAccountingMeta,
  type JournalAccountingMeta,
} from '../db/index.js';
import { computePositionPnl, portfolioSummary, buildPositionHistory } from '../pnl/compute.js';
import { renderPnlCard } from '../pnl/card.js';
import { reconcileAccounting, recoverMissingLedger, formatReconciliationReport } from '../pnl/reconcile.js';
import {
  loadMultiConfig,
  validateMultiConfig,
  getActiveStrategyName,
  runMultiStrategy,
  executeTradeIntentFromSnapshot,
  type MultiConfig,
  type MultiStrategyRun,
  type TradeIntent,
  type MultiCandidate,
  type RejectedCandidate,
} from '../strategy/index.js';
import {
  buildMultiExecuteCallbackData,
  parseMultiExecuteCallback,
  resolveMultiExecuteCallback,
} from './multiExecuteResolver.js';
import type { Address } from 'viem';

/** Confirm-mint keyboard: refresh recomputes range + spot from live pool tick. */
function mintConfirmKeyboard(opts?: {
  extras?: boolean;
  /** Show mismatch-aware primary button */
  priceMismatch?: boolean;
}): InlineKeyboard {
  const extras = opts?.extras !== false;
  const primary = opts?.priceMismatch
    ? { label: '⚠️ Review price risk', cb: 'mint:confirm' }
    : { label: '✅ Confirm mint', cb: 'mint:confirm' };
  const kb = new InlineKeyboard()
    .text(primary.label, primary.cb)
    .text('🔄 Refresh', 'mint:refresh')
    .row()
    .text('❌ Cancel', 'mint:cancel');
  if (extras) {
    kb.text('⚙️ Width…', 'pool:pickwidth').text('💱 Asset…', 'pool:pickasset');
  }
  return kb;
}

/** Second-step keyboard when pool/range ≠ DexScreener market */
function mintMismatchKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⚠️ Confirm anyway — mint', 'mint:confirm:force')
    .row()
    .text('🔄 Refresh prices', 'mint:refresh')
    .text('❌ Cancel', 'mint:cancel');
}

/** Live mint preview text (range + DexScreener market in parens) for confirm / refresh. */
async function buildMintConfirmMessage(
  s: UserSession,
): Promise<{ text: string; priceMismatch: boolean }> {
  if (!s.chainId || !s.selectedPool || !s.depositToken) {
    throw new Error('Session incomplete — pick pool and deposit asset again');
  }
  const pool = s.selectedPool;
  const preview = await describeMintPreview({
    chainId: s.chainId,
    poolAddress: pool.poolAddress,
    depositToken: s.depositToken,
    balancePercent: s.balancePercent,
    sizeMode: s.sizeMode,
    fixedAmountHuman: s.fixedAmountHuman,
    widthPercent: s.widthPercent,
    protocol: pool.protocol,
    poolKey: pool.poolKey,
    poolId: pool.poolId,
  });
  s.mintPriceMismatch = preview.priceMismatch;
  const ver =
    pool.protocol === 'v4'
      ? 'v4'
      : pool.dex === 'pancakeswap'
        ? 'PCS v3'
        : 'UNI v3';
  const tvl =
    pool.tvlUsd >= 1000
      ? `$${(pool.tvlUsd / 1000).toFixed(1)}k`
      : `$${pool.tvlUsd.toFixed(0)}`;
  const dep = s.depositSymbol ?? 'token';
  const now = new Date().toISOString().slice(11, 19); // HH:MM:SS UTC
  const text =
    `Confirm mint · ${CHAINS[s.chainId].name} · ${ver}\n` +
    `${pool.otherSymbol} · fee ${((pool.fee ?? 0) / 10000).toFixed(2)}% · TVL ${tvl}\n` +
    `width ${s.widthPercent}% · size ${formatSizePref(s)} · ${dep}\n\n` +
    `${preview.text}\n\n` +
    `⏱ Live @ ${now} UTC — tap Refresh if price moved`;
  return { text, priceMismatch: preview.priceMismatch };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout ${label} (${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const HELP = `Uniswap v3/v4 LP Bot

Mint flow
1. /settings — chain · width · amount (% or fixed) · deposit · auto-swaps
   (presets + Custom% / Custom fix — type any value)
2. Paste token CA → pick pool → Confirm
   or paste v4 poolId (0x+64) / v3 pool address → skip picker → Confirm
   or /screener → tap 🚀 Mint
   (optional: native→stable if pool needs stable)

Screener (GMGN trending)
1. /screener — filtered market trending on active chain
2. Defaults: 6h · vol≥$300k · KOL≥10 · fees≥0.5 · mc $500k–$50M
3. ⚙️ Filters · 🔄 Refresh · 🚀 Mint → same LP flow as paste CA
4. /alerts — 5m vol spikes every 60s (default vol≥$300k · KOL≥3 · fees≥0.5 · mc $300k–$50M)
5. Needs gmgn-cli + GMGN API key (~/.config/gmgn)

Close / zapout (GMGN)
1. /list → Close → Confirm (anti fat-finger)
2. Auto-swap (settings): OFF · →native · →stable
3. Meme legs sell via gmgn-cli (no Uniswap fallback)
4. No GMGN key → position still closes, zapout fails clearly

Bridge
1. /bridge — RH ↔ BSC ↔ Base (best of Relay + Across)
2. Pick direction → from token → to token → amount
3. Quote → Confirm (USDG/ETH/WETH · USDT/BNB/WBNB · USDC/ETH/WETH)

Swap
1. /swap — same-chain native ↔ stable (best quote) or custom CA (Uniswap)
2. /tokens — leftover memes → native via GMGN
3. Amount → Quote → Confirm

Wrap
1. /wrap — native → WETH/WBNB (keeps gas reserve)
2. /unwrap — WETH/WBNB → native
3. Optional amount: /wrap 0.05 · /unwrap all

Wallets
1. /wallet — balances · select active · generate · import PK · transfer
2. Active wallet is used for mint / swap / bridge / close

Security
1. /revoke — scan & zero unlimited approvals (Uniswap · Permit2 · Relay · Across)

Commands
/settings · /screener · /alerts · /wallet · /bridge · /swap · /wrap · /unwrap · /revoke · /list · /close · /tokens · /pnl · /history · /generate #id · /tp #id · /add · /cancel · /help

Experimental TP/SL
1. /settings → TP/SL ON · set default TP% / SL%
2. /tp #id — enroll position (optional: /tp #id 10 15)
3. Watcher polls every 30s · on hit waits 5s · if PnL still past level → auto-close
4. /tp #id off — unenroll · /tp list — enrolled

Defaults persist across sessions.`;

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken.trim());

  // Log every update so we can see if polling works
  bot.use(async (ctx, next) => {
    const from = ctx.from?.id;
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
    const data = ctx.callbackQuery?.data;
    console.log(`[update] from=${from} text=${text ?? ''} cb=${data ?? ''}`);
    const t0 = Date.now();
    try {
      await next();
      console.log(`[done] from=${from} ${Date.now() - t0}ms`);
    } catch (err) {
      console.error('[handler error]', err);
      try {
        await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        /* ignore */
      }
    }
  });

  bot.use(async (ctx, next) => {
    // Ignore non-private chats
    if (ctx.chat && ctx.chat.type !== 'private') {
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.reply(HELP);
    await replySettings(ctx);
  });

  bot.command('help', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.reply(HELP);
  });

  bot.command('cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    resetFlow(ctx.from!.id);
    await ctx.reply('Flow cancelled.');
  });

  bot.command('settings', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await replySettings(ctx);
  });

  bot.command('chain', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await replySettings(ctx); // full inline menu includes chain
  });

  bot.callbackQuery(/^set:chain:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const id = Number(ctx.match![1]);
    if (!isSupportedChainId(id)) {
      await ctx.answerCallbackQuery({ text: 'Unsupported' });
      return;
    }
    setUserPrefs(ctx.from!.id, { chainId: id });
    syncSessionFromPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery({ text: `${CHAINS[id].name} ✓` });
    await replySettings(ctx, true);
  });

  bot.callbackQuery(/^set:width:(\d+(?:\.\d+)?)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const w = parseWidthPercent(ctx.match![1], NaN);
    if (!Number.isFinite(w)) {
      await ctx.answerCallbackQuery({ text: 'Invalid width' });
      return;
    }
    setUserPrefs(ctx.from!.id, { widthPercent: w });
    syncSessionFromPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery({ text: `Width ${w}% ✓` });
    await replySettings(ctx, true);
  });

  bot.callbackQuery('set:width:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'await_settings_width';
    const p = getUserPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Send a **custom range width %** (1–99, e.g. \`15\` or \`12.5\`).\n` +
        `Current: ${p.widthPercent}%\n/cancel to abort.`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.callbackQuery(/^set:mintvl:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const n = Number(ctx.match![1]);
    setUserPrefs(ctx.from!.id, { minTvlUsd: parseMinTvlUsd(n) });
    await ctx.answerCallbackQuery({
      text: n === 0 ? 'Min TVL: show all' : `Min TVL $${n.toLocaleString()}`,
    });
    await replySettings(ctx, true);
  });

  bot.callbackQuery('set:mintvl:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'await_settings_mintvl';
    await ctx.answerCallbackQuery();
    await ctx.reply(
      'Send min pool TVL in USD (e.g. `1500` or `0` for all pools):',
      { parse_mode: 'Markdown' },
    );
  });

  // ── Create Uniswap v4 pool (when no/insufficient pools) ─────────────
  /** Fee presets as pips (10000 = 1%) — mirrors CREATE_V4_FEE_PRESETS */
  const CREATE_FEE_BTNS = [
    { fee: 10_000, label: '1%' },
    { fee: 20_000, label: '2%' },
    { fee: 30_000, label: '3%' },
    { fee: 50_000, label: '5%' },
    { fee: 100_000, label: '10%' },
  ] as const;

  function createV4FeeKeyboard(selectedFee?: number): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const p of CREATE_FEE_BTNS) {
      const mark = selectedFee === p.fee ? '✓ ' : '';
      kb.text(`${mark}${p.label}`, `createv4:fee:${p.fee}`);
    }
    kb.row().text('✏️ Custom fee %…', 'createv4:fee:custom').row().text('❌ Cancel', 'createv4:cancel');
    return kb;
  }

  async function showCreateV4Preview(ctx: Context, s: UserSession): Promise<void> {
    const meme = s.createV4Meme ?? s.tokenCa;
    if (!meme) throw new Error('Session expired — paste CA again');

    const prefs = getUserPrefs(ctx.from!.id);
    const quote = s.createV4Quote ?? primaryStableAddress(s.chainId) ?? CHAINS[s.chainId].wrapped;
    let deposit = quote;
    if (prefs.depositMode === 'wrapped') deposit = CHAINS[s.chainId].wrapped;
    else if (prefs.depositMode === 'stable' || prefs.depositMode === 'auto') {
      deposit = primaryStableAddress(s.chainId) ?? CHAINS[s.chainId].wrapped;
    }

    const { describeCreateV4Preview, CREATE_V4_FEE, suggestTickSpacingForFee } =
      await import('../chain/v4.js');
    const fee = s.createV4Fee ?? CREATE_V4_FEE;
    const spacing = s.createV4TickSpacing ?? suggestTickSpacingForFee(fee);

    const preview = await describeCreateV4Preview({
      chainId: s.chainId,
      memeToken: meme,
      depositToken: deposit,
      balancePercent: s.balancePercent,
      sizeMode: s.sizeMode,
      fixedAmountHuman: s.fixedAmountHuman,
      widthPercent: s.widthPercent,
      fee,
      tickSpacing: spacing,
    });
    s.createV4Meme = meme;
    s.createV4Quote = quote;
    s.createV4Fee = fee;
    s.createV4TickSpacing = spacing;
    s.depositToken = deposit;
    s.depositSymbol = (await getTokenMeta(s.chainId, deposit)).symbol;
    s.createV4PreviewText = preview.text;
    s.step = 'confirm_create_v4';
    const kb = new InlineKeyboard()
      .text('✅ Create pool + mint', 'createv4:go')
      .text('💱 Change fee', 'createv4:preview')
      .row()
      .text('❌ Cancel', 'createv4:cancel');
    try {
      await ctx.editMessageText(preview.text, { reply_markup: kb });
    } catch {
      await ctx.reply(preview.text, { reply_markup: kb });
    }
  }

  bot.callbackQuery('createv4:preview', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const meme = s.createV4Meme ?? s.tokenCa;
    if (!meme) {
      await ctx.answerCallbackQuery({ text: 'Session expired — paste CA again' });
      return;
    }
    s.createV4Meme = meme;
    s.createV4Quote = s.createV4Quote ?? primaryStableAddress(s.chainId) ?? CHAINS[s.chainId].wrapped;
    s.step = 'pick_create_v4_fee';
    await ctx.answerCallbackQuery();
    const text =
      `🆕 Create Uniswap **v4** pool\n\n` +
      `Pick **LP fee** (v4 custom fees — any %):\n` +
      `Spacing is auto-chosen for the fee.`;
    const kb = createV4FeeKeyboard(s.createV4Fee);
    try {
      await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(text, { reply_markup: kb, parse_mode: 'Markdown' });
    }
  });

  bot.callbackQuery(/^createv4:fee:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const fee = Number(ctx.match![1]);
    if (!Number.isFinite(fee) || fee < 1 || fee > 500_000) {
      await ctx.answerCallbackQuery({ text: 'Invalid fee' });
      return;
    }
    const { suggestTickSpacingForFee } = await import('../chain/v4.js');
    s.createV4Fee = fee;
    s.createV4TickSpacing = suggestTickSpacingForFee(fee);
    await ctx.answerCallbackQuery({ text: `Fee set` });
    await showCreateV4Preview(ctx, s);
  });

  bot.callbackQuery('createv4:fee:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'await_create_v4_fee';
    await ctx.answerCallbackQuery();
    await ctx.reply(
      'Send **custom fee %** for the v4 pool (e.g. `1`, `3.66`, `0.3`, `10`).\n' +
        'Max 50%. Tick spacing is chosen automatically.\n/cancel to abort.',
      { parse_mode: 'Markdown' },
    );
  });

  bot.callbackQuery('createv4:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.createV4Meme = undefined;
    s.createV4Quote = undefined;
    s.createV4PreviewText = undefined;
    s.createV4Fee = undefined;
    s.createV4TickSpacing = undefined;
    s.step = 'idle';
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('Create v4 cancelled.');
    } catch {
      await ctx.reply('Create v4 cancelled.');
    }
  });

  bot.callbackQuery('createv4:go', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const meme = s.createV4Meme ?? s.tokenCa;
    const deposit = s.depositToken;
    if (!meme || !deposit) {
      await ctx.answerCallbackQuery({ text: 'Session expired — paste CA again' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Creating v4 pool…' });
    try {
      await ctx.editMessageText('⏳ Initializing Uniswap v4 pool + minting…');
    } catch {
      await ctx.reply('⏳ Initializing Uniswap v4 pool + minting…');
    }
    try {
      const { createV4PoolAndMintSingleSided, CREATE_V4_FEE } = await import('../chain/v4.js');
      const result = await createV4PoolAndMintSingleSided({
        chainId: s.chainId,
        memeToken: meme,
        quoteToken: s.createV4Quote,
        depositToken: deposit,
        balancePercent: s.balancePercent,
        sizeMode: s.sizeMode,
        fixedAmountHuman: s.fixedAmountHuman,
        widthPercent: s.widthPercent,
        fee: s.createV4Fee ?? CREATE_V4_FEE,
        tickSpacing: s.createV4TickSpacing,
      });

      // ACTUAL deposited capital — see the matching comment at the other
      // recordLedger('deposit') call site above (PHASE3_ACCOUNTING_AUDIT.md
      // "Deposit accounting").
      const [meta0, meta1] = await Promise.all([
        getTokenMeta(s.chainId, result.token0),
        getTokenMeta(s.chainId, result.token1),
      ]);
      const [p0, p1] = await Promise.all([
        getTokenPriceUsd(s.chainId, result.token0),
        getTokenPriceUsd(s.chainId, result.token1),
      ]);
      const a0human = humanToFloat(result.amount0, meta0.decimals);
      const a1human = humanToFloat(result.amount1, meta1.decimals);
      const depUsd = a0human * (p0 ?? 0) + a1human * (p1 ?? 0);
      const depositIsToken0 = result.token0.toLowerCase() === deposit.toLowerCase();
      const depositRaw = depositIsToken0 ? result.amount0 : result.amount1;
      const depHuman = depositIsToken0 ? a0human : a1human;
      const depMeta = depositIsToken0 ? meta0 : meta1;

      recordOpenPosition({
        chainId: s.chainId,
        tokenId: result.tokenId.toString(),
        poolAddress: String(result.poolAddress),
        token0: result.token0,
        token1: result.token1,
        fee: result.fee,
        tickLower: result.tickLower,
        tickUpper: result.tickUpper,
        protocol: 'v4',
        dex: 'uniswap',
      });
      // Stage accounting metadata in the journal BEFORE recordLedger() so
      // that a crash between this point and the write below can be recovered
      // automatically on the next startup (Phase 3.5).
      setJournalAccountingMeta(s.chainId, result.hash, [{
        kind: 'deposit',
        tokenId: result.tokenId.toString(),
        tokenAddress: deposit,
        amountRaw: depositRaw.toString(),
        amountHuman: depHuman,
        usd: depUsd,
      }]);
      recordLedger({
        chainId: s.chainId,
        tokenId: result.tokenId.toString(),
        kind: 'deposit',
        tokenAddress: deposit,
        amountRaw: depositRaw.toString(),
        amountHuman: depHuman,
        usd: depUsd,
        txHash: result.hash,
      });
      const core = new Set(['WETH', 'WBNB', 'USDC', 'USDG', 'USDT', 'ETH', 'BNB']);
      const name = !core.has(meta0.symbol.toUpperCase())
        ? meta0.symbol
        : !core.has(meta1.symbol.toUpperCase())
          ? meta1.symbol
          : `${meta0.symbol}/${meta1.symbol}`;
      setPositionLabel(s.chainId, result.tokenId.toString(), name);

      const compact = formatCompactRange({
        chainId: s.chainId,
        token0: result.token0,
        token1: result.token1,
        decimals0: meta0.decimals,
        decimals1: meta1.decimals,
        symbol0: meta0.symbol,
        symbol1: meta1.symbol,
        tickLower: result.tickLower,
        tickUpper: result.tickUpper,
        currentTick: result.currentTick,
      });
      const uniLink = uniswapPositionUrl(s.chainId, result.tokenId, 'v4', 'uniswap');

      const feeUsed = s.createV4Fee ?? CREATE_V4_FEE;
      s.createV4Meme = undefined;
      s.createV4Quote = undefined;
      s.createV4PreviewText = undefined;
      s.createV4Fee = undefined;
      s.createV4TickSpacing = undefined;
      resetFlow(ctx.from!.id);
      getSession(ctx.from!.id).chainId = s.chainId;

      await ctx.reply(
        `✅ Created v4 pool + minted **${name} #${result.tokenId}**\n` +
          `Fee ${(feeUsed / 10_000).toFixed(feeUsed % 100 === 0 ? 2 : 3)}% · init ~1% below market\n` +
          `Range: ${compact}\n` +
          `Deposited ~${formatUnits(depositRaw, depMeta.decimals)} ${depMeta.symbol} (${formatUsd(depUsd)})\n` +
          `mint: ${result.txLink}\n` +
          `${uniLink}`,
        { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[createv4 failed]', msg);
      await ctx.reply(`Create v4 failed:\n${msg.slice(0, 500)}`);
    }
  });

  bot.callbackQuery(/^set:closeconfirm:(on|off)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const on = ctx.match![1] === 'on';
    setUserPrefs(ctx.from!.id, { closeConfirm: on });
    syncSessionFromPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery({
      text: on ? 'Close confirm ON (safer)' : 'Close confirm OFF (instant close)',
    });
    await replySettings(ctx, true);
  });

  bot.callbackQuery(/^set:amt:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const pct = Number(ctx.match![1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      await ctx.answerCallbackQuery({ text: 'Invalid' });
      return;
    }
    setUserPrefs(ctx.from!.id, { sizeMode: 'percent', balancePercent: pct });
    syncSessionFromPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery({ text: `Amount ${pct}% ✓` });
    await replySettings(ctx, true);
  });

  // Fixed deposit amount (deposit-token units, e.g. 0.1 WETH)
  bot.callbackQuery(/^set:fix:(0\.05|0\.1|0\.25|0\.5)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const amt = Number(ctx.match![1]);
    if (!FIXED_AMOUNT_PRESETS.includes(amt as (typeof FIXED_AMOUNT_PRESETS)[number])) {
      await ctx.answerCallbackQuery({ text: 'Invalid' });
      return;
    }
    setUserPrefs(ctx.from!.id, { sizeMode: 'fixed', fixedAmountHuman: amt });
    syncSessionFromPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery({ text: `Fixed ${amt} ✓` });
    await replySettings(ctx, true);
  });

  // Custom % of balance — type a number
  bot.callbackQuery('set:amt:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'await_settings_percent';
    await ctx.answerCallbackQuery({ text: 'Type custom %' });
    await ctx.reply(
      `Send a custom deposit **percent** of balance (1–100).\n` +
        `Examples: \`33\` · \`12.5\` · \`75\`\n` +
        `Current: ${formatSizePref(getUserPrefs(ctx.from!.id))}\n` +
        `/cancel to abort.`,
      { parse_mode: 'Markdown' },
    );
  });

  // Custom fixed deposit-token amount — type a number
  bot.callbackQuery('set:fix:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'await_settings_fixed';
    await ctx.answerCallbackQuery({ text: 'Type custom fixed' });
    await ctx.reply(
      `Send a custom **fixed** deposit amount (deposit-token units).\n` +
        `Examples: \`0.15\` · \`1\` · \`0.08\` (e.g. WETH/ETH/USDG)\n` +
        `Current: ${formatSizePref(getUserPrefs(ctx.from!.id))}\n` +
        `/cancel to abort.`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.callbackQuery(/^set:dep:(auto|wrapped|stable)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const mode = ctx.match![1] as 'auto' | 'wrapped' | 'stable';
    setUserPrefs(ctx.from!.id, { depositMode: mode });
    syncSessionFromPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery({ text: `Deposit ${mode} ✓` });
    await replySettings(ctx, true);
  });

  bot.callbackQuery(/^set:close:(off|eth|usdg)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const target = ctx.match![1] as 'off' | 'eth' | 'usdg';
    setUserPrefs(ctx.from!.id, { closeSwapTarget: target });
    syncSessionFromPrefs(ctx.from!.id);
    const cid = getUserPrefs(ctx.from!.id).chainId;
    const label =
      target === 'off'
        ? 'OFF'
        : target === 'eth'
          ? `→${CHAINS[cid].nativeSymbol}`
          : `→${primaryStableSymbol(cid)}`;
    await ctx.answerCallbackQuery({ text: `Close auto-swap ${label}` });
    await replySettings(ctx, true);
  });

  bot.callbackQuery(/^set:autoswap:stable:(on|off)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const on = ctx.match![1] === 'on';
    setUserPrefs(ctx.from!.id, { autoSwapEthToStable: on });
    await ctx.answerCallbackQuery({
      text: `Auto ETH→stable on mint: ${on ? 'ON' : 'OFF'}`,
    });
    syncSessionFromPrefs(ctx.from!.id);
    await replySettings(ctx, true);
  });

  bot.callbackQuery(/^set:tpsl:(on|off)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const on = ctx.match![1] === 'on';
    setUserPrefs(ctx.from!.id, { tpSlEnabled: on });
    syncSessionFromPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery({
      text: on
        ? 'TP/SL watcher ON (experimental) — enroll with /tp #id'
        : 'TP/SL watcher OFF',
    });
    await replySettings(ctx, true);
  });

  bot.callbackQuery('set:tpsl:tp', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'await_settings_tp';
    const p = getUserPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Send default **take-profit %** (e.g. \`10\` = close at +10% PnL).\n` +
        `Current: +${p.tpPercent}%\n/cancel to abort.`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.callbackQuery('set:tpsl:sl', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'await_settings_sl';
    const p = getUserPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Send default **stop-loss %** as positive number (e.g. \`15\` = close at -15% PnL).\n` +
        `Current: -${p.slPercent}%\n/cancel to abort.`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.callbackQuery('set:done', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const p = getUserPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery({ text: 'Saved' });
    const closeL =
      p.closeSwapTarget === 'off'
        ? 'OFF'
        : p.closeSwapTarget === 'eth'
          ? `→${CHAINS[p.chainId].nativeSymbol}`
          : `→${primaryStableSymbol(p.chainId)}`;
    try {
      await ctx.editMessageText(
        `Settings saved.\n` +
          `${CHAINS[p.chainId].name} · width ${p.widthPercent}% · size ${formatSizePref(p)} · deposit ${p.depositMode}\n` +
          `Close auto-swap: ${closeL} · Mint native→stable: ${p.autoSwapEthToStable ? 'ON' : 'OFF'}\n` +
          `TP/SL: ${p.tpSlEnabled ? 'ON' : 'OFF'} (TP +${p.tpPercent}% / SL -${p.slPercent}%)\n\n` +
          `Paste a token CA to mint.`,
      );
    } catch {
      await ctx.reply('Settings saved. Paste a CA to mint.');
    }
  });

  bot.callbackQuery('set:refresh', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery();
    await replySettings(ctx, true);
  });

  // Reveal private key of active wallet (allowlisted users only — still dangerous)
  bot.callbackQuery('set:pk', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery();
    const w = getActiveWallet();
    const kb = new InlineKeyboard()
      .text('⚠️ Yes, show private key', 'set:pk:show')
      .row()
      .text('❌ Cancel', 'set:pk:cancel');
    try {
      await ctx.editMessageText(
        `🔐 Reveal active wallet private key?\n\n` +
          `${w.label}\nAddress: \`${w.address}\`\n\n` +
          `Anyone with this key can drain the wallet.\n` +
          `Only continue if you are alone / screen is private.`,
        { reply_markup: kb, parse_mode: 'Markdown' },
      );
    } catch {
      await ctx.reply(
        `🔐 Reveal active wallet private key?\n\n${w.label}\nAddress: ${w.address}\n\nAnyone with this key can drain the wallet.`,
        { reply_markup: kb },
      );
    }
  });

  bot.callbackQuery('set:pk:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await replySettings(ctx, true);
  });

  bot.callbackQuery('set:pk:show', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery({ text: 'Revealing…' });
    const w = getActiveWallet();
    await ctx.reply(
      `🔐 Active wallet private key\n\n` +
        `${w.label}\n` +
        `Address:\n\`${w.address}\`\n\n` +
        `Private key:\n\`${w.privateKey}\`\n\n` +
        `Source: ${w.source}\n` +
        `⚠️ Delete this message after copying. Do not forward.`,
      { parse_mode: 'Markdown' },
    );
    try {
      await ctx.editMessageText(
        `Private key sent below.\n${w.label}\nAddress: \`${w.address}\`\n\nDelete that message after use.`,
        { parse_mode: 'Markdown' },
      );
    } catch {
      /* ignore */
    }
  });

  // ── Multi-wallet /wallet ─────────────────────────────────────────────
  bot.command('wallet', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    clearWalletSession(getSession(ctx.from!.id));
    await replyWalletMenu(ctx);
  });

  bot.callbackQuery('wal:menu', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    clearWalletSession(getSession(ctx.from!.id));
    await ctx.answerCallbackQuery();
    await replyWalletMenu(ctx, true);
  });

  bot.callbackQuery('wal:balances', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery({ text: 'Loading…' });
    await replyActiveBalances(ctx, true);
  });

  bot.callbackQuery('wal:select', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyWalletSelect(ctx, true);
  });

  bot.callbackQuery(/^wal:use:(.+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const id = ctx.match![1]!;
    try {
      const w = setActiveWallet(id);
      const s = getSession(ctx.from!.id);
      s.step = 'idle';
      s.walletLabelTargetId = undefined;
      await ctx.answerCallbackQuery({ text: `Active: ${w.label}` });
      await replyWalletMenu(ctx, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.answerCallbackQuery({ text: msg.slice(0, 180) });
    }
  });

  bot.callbackQuery('wal:gen', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    try {
      const w = generateWallet();
      const s = getSession(ctx.from!.id);
      clearWalletSession(s);
      s.walletLabelTargetId = w.id;
      s.step = 'await_wallet_label';
      await ctx.answerCallbackQuery({ text: 'Generated' });
      const kb = new InlineKeyboard()
        .text('Use as active', `wal:use:${w.id}`)
        .row()
        .text('Skip label', 'wal:label:skip')
        .text('← Menu', 'wal:menu');
      await ctx.editMessageText(
        `✅ New wallet generated\n\n` +
          `Label: ${w.label}\n` +
          `Address:\n\`${w.address}\`\n\n` +
          `Send a custom label (or tap Skip).\n` +
          `Fund this address before using it.`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.answerCallbackQuery({ text: msg.slice(0, 180) });
    }
  });

  bot.callbackQuery('wal:import', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    clearWalletSession(s);
    s.step = 'await_import_pk';
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text('❌ Cancel', 'wal:menu');
    try {
      await ctx.editMessageText(
        `📥 Import wallet\n\n` +
          `Send the private key as a single message (64 hex chars, optional \`0x\` prefix).\n\n` +
          `⚠️ Your message will be deleted when possible. Do not forward keys.`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch {
      await ctx.reply(
        `📥 Import wallet\n\nSend the private key as a single message.\n/cancel to abort.`,
        { reply_markup: kb },
      );
    }
  });

  bot.callbackQuery('wal:label:skip', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'idle';
    s.walletLabelTargetId = undefined;
    await ctx.answerCallbackQuery({ text: 'OK' });
    await replyWalletMenu(ctx, true);
  });

  bot.callbackQuery('wal:rename', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery();
    const wallets = listWallets();
    const kb = new InlineKeyboard();
    for (const w of wallets) {
      kb.text(w.label.slice(0, 28), `wal:rename:pick:${w.id}`).row();
    }
    kb.text('← Menu', 'wal:menu');
    try {
      await ctx.editMessageText('Rename which wallet?', { reply_markup: kb });
    } catch {
      await ctx.reply('Rename which wallet?', { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^wal:rename:pick:(.+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const id = ctx.match![1]!;
    const w = getWalletById(id);
    if (!w) {
      await ctx.answerCallbackQuery({ text: 'Not found' });
      return;
    }
    const s = getSession(ctx.from!.id);
    clearWalletSession(s);
    s.walletRenameId = id;
    s.step = 'await_wallet_rename';
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text('❌ Cancel', 'wal:menu');
    try {
      await ctx.editMessageText(
        `Rename **${w.label}**\n\`${shortAddress(w.address)}\`\n\nSend new label (max 48 chars).`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch {
      await ctx.reply(`Rename ${w.label}. Send new label.`, { reply_markup: kb });
    }
  });

  bot.callbackQuery('wal:pk', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery();
    const wallets = listWallets();
    const kb = new InlineKeyboard();
    for (const w of wallets) {
      kb.text(`🔑 ${w.label.slice(0, 24)}`, `wal:pk:ask:${w.id}`).row();
    }
    kb.text('← Menu', 'wal:menu');
    try {
      await ctx.editMessageText('Reveal private key for which wallet?', { reply_markup: kb });
    } catch {
      await ctx.reply('Reveal private key for which wallet?', { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^wal:pk:ask:(.+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const id = ctx.match![1]!;
    const w = getWalletById(id);
    if (!w) {
      await ctx.answerCallbackQuery({ text: 'Not found' });
      return;
    }
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('⚠️ Yes, show key', `wal:pk:show:${w.id}`)
      .row()
      .text('❌ Cancel', 'wal:pk');
    try {
      await ctx.editMessageText(
        `🔐 Reveal private key?\n\n${w.label}\n\`${w.address}\`\n\nAnyone with this key can drain the wallet.`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch {
      await ctx.reply(`Reveal key for ${w.label}?`, { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^wal:pk:show:(.+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const id = ctx.match![1]!;
    const w = getWalletById(id);
    if (!w) {
      await ctx.answerCallbackQuery({ text: 'Not found' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Revealing…' });
    await ctx.reply(
      `🔐 ${w.label}\n\n` +
        `Address:\n\`${w.address}\`\n\n` +
        `Private key:\n\`${w.privateKey}\`\n\n` +
        `Source: ${w.source}\n` +
        `⚠️ Delete this message after copying.`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.callbackQuery('wal:del', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery();
    const wallets = listWallets();
    if (wallets.length <= 1) {
      await ctx.answerCallbackQuery({ text: 'Need at least one wallet' }).catch(() => {});
      try {
        await ctx.editMessageText('Cannot delete the last wallet.', {
          reply_markup: new InlineKeyboard().text('← Menu', 'wal:menu'),
        });
      } catch {
        await ctx.reply('Cannot delete the last wallet.');
      }
      return;
    }
    const kb = new InlineKeyboard();
    for (const w of wallets) {
      kb.text(`🗑 ${w.label.slice(0, 24)}`, `wal:del:ask:${w.id}`).row();
    }
    kb.text('← Menu', 'wal:menu');
    try {
      await ctx.editMessageText(
        'Delete which wallet?\n(Removes key from bot store only — funds stay on-chain.)',
        { reply_markup: kb },
      );
    } catch {
      await ctx.reply('Delete which wallet?', { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^wal:del:ask:(.+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const id = ctx.match![1]!;
    const w = getWalletById(id);
    if (!w) {
      await ctx.answerCallbackQuery({ text: 'Not found' });
      return;
    }
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('⚠️ Delete permanently', `wal:del:go:${w.id}`)
      .row()
      .text('❌ Cancel', 'wal:del');
    try {
      await ctx.editMessageText(
        `Delete **${w.label}**?\n\`${w.address}\`\n\nThis removes the private key from the bot. Ensure you have a backup.`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch {
      await ctx.reply(`Delete ${w.label}?`, { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^wal:del:go:(.+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const id = ctx.match![1]!;
    try {
      const { removed, newActive } = removeWallet(id);
      await ctx.answerCallbackQuery({ text: 'Deleted' });
      await ctx.editMessageText(
        `Deleted **${removed.label}** (\`${shortAddress(removed.address)}\`)\n` +
          `Active now: **${newActive.label}**`,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard().text('← Menu', 'wal:menu'),
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.answerCallbackQuery({ text: msg.slice(0, 180) });
    }
  });

  // Transfer between wallets
  bot.callbackQuery('wal:xfer', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const wallets = listWallets();
    if (wallets.length < 2) {
      await ctx.answerCallbackQuery({ text: 'Need 2+ wallets' });
      return;
    }
    const s = getSession(ctx.from!.id);
    clearWalletSession(s);
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    for (const w of wallets) {
      const star = w.id === getActiveWalletId() ? '★ ' : '';
      kb.text(`${star}${w.label.slice(0, 26)}`, `wal:xfer:from:${w.id}`).row();
    }
    kb.text('← Menu', 'wal:menu');
    try {
      await ctx.editMessageText('Transfer · pick **source** wallet:', {
        parse_mode: 'Markdown',
        reply_markup: kb,
      });
    } catch {
      await ctx.reply('Transfer · pick source wallet:', { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^wal:xfer:from:(.+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const fromId = ctx.match![1]!;
    const from = getWalletById(fromId);
    if (!from) {
      await ctx.answerCallbackQuery({ text: 'Not found' });
      return;
    }
    const s = getSession(ctx.from!.id);
    s.transferFromId = fromId;
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    for (const w of listWallets()) {
      if (w.id === fromId) continue;
      kb.text(w.label.slice(0, 28), `wal:xfer:to:${w.id}`).row();
    }
    kb.text('← Back', 'wal:xfer').text('← Menu', 'wal:menu');
    try {
      await ctx.editMessageText(
        `Transfer from **${from.label}**\nPick **destination**:`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch {
      await ctx.reply(`From ${from.label} · pick destination:`, { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^wal:xfer:to:(.+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const toId = ctx.match![1]!;
    const s = getSession(ctx.from!.id);
    if (!s.transferFromId) {
      await ctx.answerCallbackQuery({ text: 'Start over' });
      return;
    }
    const to = getWalletById(toId);
    if (!to) {
      await ctx.answerCallbackQuery({ text: 'Not found' });
      return;
    }
    s.transferToId = toId;
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('Robinhood', 'wal:xfer:chain:4663')
      .text('BSC', 'wal:xfer:chain:56')
      .text('Base', 'wal:xfer:chain:8453')
      .row()
      .text('← Menu', 'wal:menu');
    try {
      await ctx.editMessageText(
        `To **${to.label}** (\`${shortAddress(to.address)}\`)\nPick chain:`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch {
      await ctx.reply(`To ${to.label} · pick chain:`, { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^wal:xfer:chain:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const chainId = Number(ctx.match![1]);
    if (!isSupportedChainId(chainId)) {
      await ctx.answerCallbackQuery({ text: 'Bad chain' });
      return;
    }
    const s = getSession(ctx.from!.id);
    if (!s.transferFromId || !s.transferToId) {
      await ctx.answerCallbackQuery({ text: 'Start over' });
      return;
    }
    s.transferChainId = chainId;
    await ctx.answerCallbackQuery();
    const c = CHAINS[chainId];
    const kb = new InlineKeyboard()
      .text(c.nativeSymbol, 'wal:xfer:asset:native')
      .text(c.wrappedSymbol, `wal:xfer:asset:${c.wrapped}`);
    if (c.usdg) kb.text('USDG', `wal:xfer:asset:${c.usdg}`);
    if (c.usdt) kb.text('USDT', `wal:xfer:asset:${c.usdt}`);
    if (c.usdc) kb.text('USDC', `wal:xfer:asset:${c.usdc}`);
    kb.row().text('← Menu', 'wal:menu');
    try {
      await ctx.editMessageText(`Chain: **${c.name}**\nPick asset:`, {
        parse_mode: 'Markdown',
        reply_markup: kb,
      });
    } catch {
      await ctx.reply(`Chain ${c.name} · pick asset:`, { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^wal:xfer:asset:(native|0x[a-fA-F0-9]{40})$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const raw = ctx.match![1]!;
    const s = getSession(ctx.from!.id);
    if (!s.transferFromId || !s.transferToId || !s.transferChainId) {
      await ctx.answerCallbackQuery({ text: 'Start over' });
      return;
    }
    const chainId = s.transferChainId;
    s.transferAsset = raw === 'native' ? 'native' : (raw as Address);
    s.transferSymbol =
      raw === 'native'
        ? CHAINS[chainId].nativeSymbol
        : depositAssets(chainId).find((a) => a.address.toLowerCase() === raw.toLowerCase())
            ?.symbol ?? 'token';
    await ctx.answerCallbackQuery();

    let maxHuman = '0';
    let maxRaw = 0n;
    try {
      if (s.transferAsset === 'native') {
        maxRaw = await getTransferableNative(chainId, s.transferFromId);
        maxHuman = formatUnits(maxRaw, 18);
      } else {
        const meta = await getTokenMeta(chainId, s.transferAsset);
        maxRaw = await getTokenBalance(
          chainId,
          s.transferAsset,
          getHotWalletAddress(s.transferFromId),
        );
        maxHuman = formatUnits(maxRaw, meta.decimals);
        s.transferSymbol = meta.symbol;
      }
    } catch {
      /* show 0 */
    }

    const kb = new InlineKeyboard()
      .text('25%', 'wal:xfer:pct:25')
      .text('50%', 'wal:xfer:pct:50')
      .text('All', 'wal:xfer:pct:100')
      .row()
      .text('Custom…', 'wal:xfer:custom')
      .text('← Menu', 'wal:menu');
    const from = getWalletById(s.transferFromId)!;
    const to = getWalletById(s.transferToId)!;
    try {
      await ctx.editMessageText(
        `Transfer **${s.transferSymbol}** on ${CHAINS[chainId].name}\n` +
          `From: ${from.label} → To: ${to.label}\n` +
          `Available: \`${maxHuman}\` ${s.transferSymbol}` +
          (s.transferAsset === 'native' ? ' (after gas reserve)' : '') +
          `\n\nPick amount:`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch {
      await ctx.reply(
        `Transfer ${s.transferSymbol}: available ${maxHuman}. Pick amount:`,
        { reply_markup: kb },
      );
    }
  });

  bot.callbackQuery(/^wal:xfer:pct:(25|50|100)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const pct = Number(ctx.match![1]);
    const s = getSession(ctx.from!.id);
    if (!s.transferFromId || !s.transferToId || !s.transferChainId || !s.transferAsset) {
      await ctx.answerCallbackQuery({ text: 'Start over' });
      return;
    }
    try {
      let maxRaw = 0n;
      if (s.transferAsset === 'native') {
        maxRaw = await getTransferableNative(s.transferChainId, s.transferFromId);
      } else {
        maxRaw = await getTokenBalance(
          s.transferChainId,
          s.transferAsset,
          getHotWalletAddress(s.transferFromId),
        );
      }
      const amount = (maxRaw * BigInt(pct)) / 100n;
      if (amount <= 0n) {
        await ctx.answerCallbackQuery({ text: 'Balance too low' });
        return;
      }
      s.transferAmount = amount;
      await ctx.answerCallbackQuery();
      await replyTransferConfirm(ctx, s, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.answerCallbackQuery({ text: msg.slice(0, 180) });
    }
  });

  bot.callbackQuery('wal:xfer:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (!s.transferFromId || !s.transferAsset) {
      await ctx.answerCallbackQuery({ text: 'Start over' });
      return;
    }
    s.step = 'await_transfer_amount';
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text('❌ Cancel', 'wal:menu');
    try {
      await ctx.editMessageText(
        `Send amount of **${s.transferSymbol ?? 'token'}** (e.g. \`0.05\` or \`10\`).`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch {
      await ctx.reply(`Send amount of ${s.transferSymbol ?? 'token'}.`, { reply_markup: kb });
    }
  });

  bot.callbackQuery('wal:xfer:confirm', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (
      !s.transferFromId ||
      !s.transferToId ||
      !s.transferChainId ||
      !s.transferAsset ||
      !s.transferAmount
    ) {
      await ctx.answerCallbackQuery({ text: 'Session expired' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Sending…' });
    const from = getWalletById(s.transferFromId);
    const to = getWalletById(s.transferToId);
    if (!from || !to) {
      await ctx.reply('Wallet missing — start /wallet again.');
      return;
    }
    try {
      await ctx.editMessageText('Broadcasting transfer…');
    } catch {
      /* ignore */
    }
    try {
      const result = await transferBetweenWallets({
        chainId: s.transferChainId,
        fromWalletId: s.transferFromId,
        toAddress: to.address,
        amount: s.transferAmount,
        asset: s.transferAsset,
      });
      clearWalletSession(s);
      s.step = 'idle';
      const link = txUrl(result.chainId, result.hash);
      await ctx.reply(
        `✅ Transfer complete\n\n` +
          `${formatUnits(result.amount, result.decimals)} ${result.symbol}\n` +
          `${from.label} → ${to.label}\n` +
          `${CHAINS[result.chainId].name}\n` +
          `[tx](${link})`,
        {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard().text('← Wallet menu', 'wal:menu'),
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Transfer failed: ${msg.slice(0, 400)}`, {
        reply_markup: new InlineKeyboard().text('← Menu', 'wal:menu'),
      });
    }
  });

  bot.callbackQuery('wal:xfer:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    clearWalletSession(getSession(ctx.from!.id));
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await replyWalletMenu(ctx, true);
  });

  // ── /wrap · /unwrap (native ↔ WETH/WBNB) ─────────────────────────────
  bot.command('wrap', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    resetFlow(ctx.from!.id);
    const s = getSession(ctx.from!.id);
    const chainId = s.chainId;
    const c = CHAINS[chainId];
    const arg = (ctx.match as string | undefined)?.trim() ?? '';
    try {
      const wrappable = await getWrappableNative(chainId);
      if (wrappable <= 0n) {
        await ctx.reply(
          `Nothing to wrap on ${c.name}.\n` +
            `Need native ${c.nativeSymbol} above gas reserve.`,
        );
        return;
      }
      if (arg) {
        const amt = parseWrapArg(arg, wrappable);
        if (amt == null) {
          await ctx.reply('Usage: /wrap · /wrap 0.05 · /wrap all');
          return;
        }
        await executeWrap(ctx, chainId, amt);
        return;
      }
      const kb = new InlineKeyboard()
        .text('25%', 'wrap:pct:25')
        .text('50%', 'wrap:pct:50')
        .text('All', 'wrap:pct:100')
        .row()
        .text('Custom…', 'wrap:custom')
        .text('Cancel', 'wrap:cancel');
      await ctx.reply(
        `Wrap ${c.nativeSymbol} → ${c.wrappedSymbol} on ${c.name}\n` +
          `Wrappable (after gas reserve): \`${formatUnits(wrappable, 18)}\` ${c.nativeSymbol}\n\n` +
          `Pick amount or /wrap 0.05`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Wrap failed: ${msg.slice(0, 300)}`);
    }
  });

  bot.command('unwrap', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    resetFlow(ctx.from!.id);
    const s = getSession(ctx.from!.id);
    const chainId = s.chainId;
    const c = CHAINS[chainId];
    const arg = (ctx.match as string | undefined)?.trim() ?? '';
    try {
      const bal = await getTokenBalance(chainId, c.wrapped);
      if (bal <= 0n) {
        await ctx.reply(`No ${c.wrappedSymbol} on ${c.name} to unwrap.`);
        return;
      }
      if (arg) {
        const amt = parseWrapArg(arg, bal);
        if (amt == null) {
          await ctx.reply('Usage: /unwrap · /unwrap 0.05 · /unwrap all');
          return;
        }
        await executeUnwrap(ctx, chainId, amt);
        return;
      }
      const kb = new InlineKeyboard()
        .text('25%', 'unwrap:pct:25')
        .text('50%', 'unwrap:pct:50')
        .text('All', 'unwrap:pct:100')
        .row()
        .text('Custom…', 'unwrap:custom')
        .text('Cancel', 'unwrap:cancel');
      await ctx.reply(
        `Unwrap ${c.wrappedSymbol} → ${c.nativeSymbol} on ${c.name}\n` +
          `Balance: \`${formatUnits(bal, 18)}\` ${c.wrappedSymbol}\n\n` +
          `Pick amount or /unwrap 0.05`,
        { parse_mode: 'Markdown', reply_markup: kb },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Unwrap failed: ${msg.slice(0, 300)}`);
    }
  });

  bot.callbackQuery(/^wrap:pct:(25|50|100)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const pct = Number(ctx.match![1]);
    try {
      const wrappable = await getWrappableNative(s.chainId);
      const amt = (wrappable * BigInt(pct)) / 100n;
      if (amt <= 0n) {
        await ctx.answerCallbackQuery({ text: 'Nothing to wrap' });
        return;
      }
      await ctx.answerCallbackQuery({ text: `Wrap ${pct}%…` });
      await executeWrap(ctx, s.chainId, amt, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.answerCallbackQuery({ text: 'Failed' });
      await ctx.reply(`Wrap failed: ${msg.slice(0, 300)}`);
    }
  });

  bot.callbackQuery(/^unwrap:pct:(25|50|100)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const pct = Number(ctx.match![1]);
    const wrapped = CHAINS[s.chainId].wrapped;
    try {
      const bal = await getTokenBalance(s.chainId, wrapped);
      const amt = (bal * BigInt(pct)) / 100n;
      if (amt <= 0n) {
        await ctx.answerCallbackQuery({ text: 'Nothing to unwrap' });
        return;
      }
      await ctx.answerCallbackQuery({ text: `Unwrap ${pct}%…` });
      await executeUnwrap(ctx, s.chainId, amt, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.answerCallbackQuery({ text: 'Failed' });
      await ctx.reply(`Unwrap failed: ${msg.slice(0, 300)}`);
    }
  });

  bot.callbackQuery('wrap:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'await_wrap_amount';
    await ctx.answerCallbackQuery({ text: 'Type amount' });
    try {
      await ctx.editMessageText(
        `Send amount of ${CHAINS[s.chainId].nativeSymbol} to wrap (e.g. 0.05).\n/cancel to abort.`,
      );
    } catch {
      await ctx.reply(
        `Send amount of ${CHAINS[s.chainId].nativeSymbol} to wrap (e.g. 0.05).\n/cancel to abort.`,
      );
    }
  });

  bot.callbackQuery('unwrap:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    s.step = 'await_unwrap_amount';
    await ctx.answerCallbackQuery({ text: 'Type amount' });
    try {
      await ctx.editMessageText(
        `Send amount of ${CHAINS[s.chainId].wrappedSymbol} to unwrap (e.g. 0.05).\n/cancel to abort.`,
      );
    } catch {
      await ctx.reply(
        `Send amount of ${CHAINS[s.chainId].wrappedSymbol} to unwrap (e.g. 0.05).\n/cancel to abort.`,
      );
    }
  });

  bot.callbackQuery('wrap:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    clearWrapSession(getSession(ctx.from!.id));
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('Wrap cancelled.');
    } catch {
      /* ignore */
    }
  });

  bot.callbackQuery('unwrap:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    clearWrapSession(getSession(ctx.from!.id));
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('Unwrap cancelled.');
    } catch {
      /* ignore */
    }
  });

  bot.command('add', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = syncSessionFromPrefs(ctx.from!.id);
    resetFlow(ctx.from!.id);
    const sess = getSession(ctx.from!.id);
    sess.step = 'await_ca';
    await ctx.reply(
      `Mint on ${CHAINS[s.chainId].name}.\n` +
        `Paste a token CA → pick pool.\n` +
        `(settings: width ${s.widthPercent}% · size ${formatSizePref(s)} · deposit ${s.depositMode})`,
    );
  });

  bot.command('list', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await handleList(ctx, false);
  });

  bot.callbackQuery('list:refresh', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery({ text: 'Refreshing…' });
    await handleList(ctx, true);
  });

  bot.command('tokens', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await handleTokens(ctx);
  });

  bot.command('pnl', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await handlePnl(ctx);
  });

  bot.command('history', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await handleHistory(ctx);
  });

  bot.command('generate', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await handleGenerate(ctx);
  });

  // Phase 3.5: Accounting reconciliation check + auto-recovery.
  // Only authorized users may invoke this. Does NOT expose private keys
  // or sensitive wallet data — shows only txHash prefixes, chainIds, and
  // event kinds.
  bot.command('reconcile', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    try {
      await ctx.reply('Running accounting reconciliation…');
      const recovery = recoverMissingLedger();
      const check = reconcileAccounting();
      const text = formatReconciliationReport(recovery, check);
      await ctx.reply(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Reconciliation error: ${msg.slice(0, 500)}`);
    }
  });

  bot.command('tp', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await handleTp(ctx);
  });

  // ── Phase 4: /multi — MULTI strategy dry-run report + execute ──────────
  // MULTI never bypasses the existing execution pipeline: this handler only
  // calls runMultiStrategy()/executeTradeIntent(), which route through
  // mintSingleSided() exactly like a manual mint.
  //
  // Strategy isolation (spec §9): being an authorized Telegram user is not
  // by itself "explicit selection" of MULTI — the deployment operator must
  // also opt in via STRATEGY=multi. Without it, /multi is inert regardless
  // of how valid the rest of the MULTI config is, and the default strategy
  // is completely unaffected either way.
  bot.command('multi', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    if (getActiveStrategyName() !== 'multi') {
      await ctx.reply('⛔ MULTI is not active on this bot (set STRATEGY=multi to enable).');
      return;
    }
    await ctx.reply('Scanning GMGN 6h trending for MULTI candidates…');
    await runMultiDryRunReport(ctx, false);
  });

  bot.callbackQuery('multi:refresh', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    if (getActiveStrategyName() !== 'multi') {
      await ctx.answerCallbackQuery({ text: 'MULTI is not active (STRATEGY=multi required)' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Refreshing…' });
    await runMultiDryRunReport(ctx, true);
  });

  // Phase 4.7 audit (F-13): matches ONLY the new mx:<scanId>:<token>
  // format. The pre-F-13 `multi:exec:<token>` format (no scanId) simply
  // does not match this regex at all — an old button surviving from before
  // this change fails closed by construction, not via an explicit
  // version/compatibility check.
  bot.callbackQuery(/^mx:[0-9a-f]{10}:0x[a-fA-F0-9]{40}$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    if (getActiveStrategyName() !== 'multi') {
      await ctx.answerCallbackQuery({ text: 'MULTI is not active (STRATEGY=multi required)' });
      return;
    }
    const parsed = parseMultiExecuteCallback(ctx.callbackQuery?.data ?? '');
    if (!parsed) {
      // Regex above already guarantees a match reaches here, but the
      // strict parser is the single source of truth for the callback
      // shape — never trust the regex alone for anything beyond routing.
      await ctx.answerCallbackQuery({ text: 'Stale — run /multi again' });
      return;
    }
    const sess = getSession(ctx.from!.id);
    const resolution = resolveMultiExecuteCallback(sess.multiRun, parsed);
    // Phase 4.7 audit (F-13): scanId mismatch — including the case where a
    // NEWER scan has since replaced the session and happens to contain the
    // SAME token address under a different pool/intent — is rejected here,
    // before any GMGN call, risk gate, F-08 check, or mint attempt. This is
    // the central F-13 requirement: never resolve a callback against
    // anything other than the exact scan that produced it.
    if (!resolution.ok) {
      await ctx.answerCallbackQuery({ text: 'Stale — run /multi again' });
      return;
    }
    const { run, intent, candidate } = resolution;
    const config = loadMultiConfig(run.chainId);
    // Phase 4.7 audit (F-10): checked after scan/token binding, per the
    // established order — "no scan at all"/"wrong scan" and "right scan,
    // too old" are surfaced as distinct reasons, both failing closed
    // identically (Execute refused either way).
    if (Date.now() - run.timestamp > config.snapshotTtlMs) {
      await ctx.answerCallbackQuery({ text: 'Scan expired — run /multi again' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Executing…' });
    try {
      const prefs = getUserPrefs(ctx.from!.id);
      const outcome = await executeTradeIntentFromSnapshot({
        intent,
        candidate,
        config,
        prefs,
        snapshotTimestamp: run.timestamp,
      });
      if ('skipped' in outcome) {
        await ctx.reply(`⛔ Execution blocked: ${outcome.reason}`);
      } else {
        await ctx.reply(
          `✅ MULTI entry opened — ${candidate.symbol}\n` +
            `tokenId=${outcome.tokenId}\n` +
            `tx: ${txUrl(run.chainId, outcome.txHash)}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Execution error:\n${msg.slice(0, 400)}`);
    }
  });

  bot.command('close', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await handleCloseMenu(ctx);
  });

  // ── /screener (GMGN market trending) + /alerts ─────────────────────────
  bot.command('screener', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    resetFlow(ctx.from!.id);
    await replyScreener(ctx, 0, false);
  });

  bot.command('alerts', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    resetFlow(ctx.from!.id);
    await replyScreenerFilters(ctx, false);
  });

  bot.callbackQuery('scr:refresh', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery({ text: 'Refreshing…' });
    await replyScreener(ctx, 0, true, true);
  });

  bot.callbackQuery(/^scr:page:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const page = Number(ctx.match![1]);
    await ctx.answerCallbackQuery();
    await replyScreener(ctx, page, true, false);
  });

  bot.callbackQuery('scr:filters', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery();
    await replyScreenerFilters(ctx, true);
  });

  bot.callbackQuery(/^scr:iv:(1m|5m|1h|6h|24h)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const iv = ctx.match![1] as '1m' | '5m' | '1h' | '6h' | '24h';
    setUserPrefs(ctx.from!.id, { screenerInterval: iv });
    await ctx.answerCallbackQuery({ text: `Interval ${iv}` });
    await replyScreenerFilters(ctx, true);
  });

  bot.callbackQuery(/^scr:edit:(vol|kol|fees|mcap|maxmcap|limit)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const field = ctx.match![1]!;
    const s = getSession(ctx.from!.id);
    const stepMap = {
      vol: 'await_screener_vol',
      kol: 'await_screener_kol',
      fees: 'await_screener_fees',
      mcap: 'await_screener_mcap',
      maxmcap: 'await_screener_maxmcap',
      limit: 'await_screener_limit',
    } as const;
    s.step = stepMap[field as keyof typeof stepMap];
    const prompts: Record<string, string> = {
      vol: 'Send <b>min volume USD</b> (e.g. <code>300000</code> or <code>300k</code>).',
      kol: 'Send <b>min KOL count</b> (e.g. <code>10</code>).',
      fees: 'Send <b>min total fees</b> in native units (e.g. <code>0.5</code>).',
      mcap: 'Send <b>min market cap USD</b> (e.g. <code>500k</code>).',
      maxmcap: 'Send <b>max market cap USD</b> (e.g. <code>50m</code>). <code>0</code> = no cap.',
      limit: 'Send <b>max results</b> (1–100, e.g. <code>20</code>).',
    };
    await ctx.answerCallbackQuery();
    await ctx.reply(prompts[field]! + '\n\n/cancel to abort.', { parse_mode: 'HTML' });
  });

  bot.callbackQuery(/^alert:edit:(vol|kol|fees|mcap|maxmcap)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const field = ctx.match![1]!;
    const s = getSession(ctx.from!.id);
    const stepMap = {
      vol: 'await_alert_vol',
      kol: 'await_alert_kol',
      fees: 'await_alert_fees',
      mcap: 'await_alert_mcap',
      maxmcap: 'await_alert_maxmcap',
    } as const;
    s.step = stepMap[field as keyof typeof stepMap];
    const prompts: Record<string, string> = {
      vol: 'Alert <b>min 5m volume USD</b> (e.g. <code>300k</code>).',
      kol: 'Alert <b>min KOL</b> (e.g. <code>3</code>).',
      fees: 'Alert <b>min fees</b> (e.g. <code>0.5</code>).',
      mcap: 'Alert <b>min mcap USD</b> (e.g. <code>300k</code>).',
      maxmcap: 'Alert <b>max mcap USD</b> (e.g. <code>50m</code>). <code>0</code> = no cap.',
    };
    await ctx.answerCallbackQuery();
    await ctx.reply(prompts[field]! + '\n\n/cancel to abort.', { parse_mode: 'HTML' });
  });

  bot.callbackQuery(/^alert:(on|off)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const on = ctx.match![1] === 'on';
    setUserPrefs(ctx.from!.id, { alertEnabled: on });
    await ctx.answerCallbackQuery({ text: on ? 'Alerts ON' : 'Alerts OFF' });
    await replyScreenerFilters(ctx, true);
  });

  bot.callbackQuery('scr:defaults', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    setUserPrefs(ctx.from!.id, {
      screenerInterval: '6h',
      screenerMinVolumeUsd: 300_000,
      screenerMinKol: 10,
      screenerMinTotalFee: 0.5,
      screenerMinMcapUsd: 500_000,
      screenerMaxMcapUsd: 50_000_000,
      screenerLimit: 20,
      alertEnabled: true,
      alertMinVolumeUsd: 300_000,
      alertMinMcapUsd: 300_000,
      alertMaxMcapUsd: 50_000_000,
      alertMinKol: 3,
      alertMinTotalFee: 0.5,
    });
    await ctx.answerCallbackQuery({ text: 'Defaults restored' });
    await replyScreenerFilters(ctx, true);
  });

  bot.callbackQuery('scr:run', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery({ text: 'Screening…' });
    await replyScreener(ctx, 0, true, true);
  });

  bot.callbackQuery(/^scr:mint:(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const ca = ctx.match![1] as Address;
    await ctx.answerCallbackQuery({ text: 'Opening mint…' });
    const s = syncSessionFromPrefs(ctx.from!.id);
    try {
      await startMintFromCa(ctx, s, ca);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Mint open failed:\n${msg.slice(0, 400)}`);
    }
  });

  // Pool pick → confirm with saved settings (width / amount / deposit mode)
  bot.callbackQuery(/^pool:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = syncSessionFromPrefs(ctx.from!.id);
    const idx = Number(ctx.match![1]);
    if (!s.pools?.[idx] || !s.chainId) {
      await ctx.answerCallbackQuery({ text: 'Session expired — paste CA again' });
      return;
    }
    s.selectedPool = s.pools[idx];
    // Drop stale deposit from a previous pool (was causing "not in pool" on mint)
    s.depositToken = undefined;
    s.depositSymbol = undefined;
    s.depositUserPicked = false;
    await ctx.answerCallbackQuery({ text: 'Loading preview…' });

    try {
      const { resolveDepositForPool } = await import('./quickMint.js');
      const dep = await resolveDepositForPool(
        s.chainId,
        s.selectedPool,
        s.depositMode ?? 'auto',
        undefined,
        false,
        s.tokenCa,
      );

      s.depositToken = dep.address;
      s.depositSymbol = dep.symbol;
      s.depositUserPicked = false;
      s.step = 'confirm_mint';
      const built = await buildMintConfirmMessage(s);
      let text = built.text;
      if (dep.note) text = `${text}\n\nℹ️ ${dep.note}`;
      await ctx.editMessageText(text, {
        reply_markup: mintConfirmKeyboard({ priceMismatch: built.priceMismatch }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Offer manual pick if auto-resolve failed
      s.step = 'pick_asset';
      const assets = depositAssets(s.chainId);
      const kb = new InlineKeyboard();
      for (const a of assets) {
        kb.text(a.symbol, `asset:${a.address}`).row();
      }
      kb.text('⚙️ Change width first', 'pool:pickwidth').row();
      try {
        await ctx.editMessageText(
          `Pool: ${s.selectedPool.label}\n\n` +
            `Auto deposit failed: ${msg.slice(0, 200)}\n` +
            `Pick deposit asset:`,
          { reply_markup: kb },
        );
      } catch {
        await ctx.reply(`Preview failed:\n${msg.slice(0, 400)}`);
      }
    }
  });

  bot.callbackQuery('pool:pickwidth', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (!s.selectedPool) {
      await ctx.answerCallbackQuery({ text: 'Pick a pool first' });
      return;
    }
    s.step = 'pick_width';
    const kb = new InlineKeyboard();
    for (const w of RANGE_PRESETS) {
      kb.text(mark(s.widthPercent === w, `${w}%`), `width:${w}`).row();
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Pool: ${s.selectedPool.label}\n\nSelect range width:`,
      { reply_markup: kb },
    );
  });

  bot.callbackQuery('pool:pickasset', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (!s.selectedPool || !s.chainId) {
      await ctx.answerCallbackQuery({ text: 'Pick a pool first' });
      return;
    }
    s.step = 'pick_asset';
    const assets = depositAssets(s.chainId);
    const kb = new InlineKeyboard();
    for (const a of assets) {
      kb.text(a.symbol, `asset:${a.address}`).row();
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Pool: ${s.selectedPool.label}\nWidth ${s.widthPercent}%.\nPick deposit asset:`,
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^width:(\d+(?:\.\d+)?)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const w = parseWidthPercent(ctx.match![1], NaN);
    if (!Number.isFinite(w) || !s.chainId || !s.selectedPool) {
      await ctx.answerCallbackQuery({ text: 'Invalid' });
      return;
    }
    s.widthPercent = w;
    setUserPrefs(ctx.from!.id, { widthPercent: w });
    await ctx.answerCallbackQuery({ text: `Width ${w}% ✓` });

    // If deposit already chosen → re-preview with live range/price; else pick asset
    if (s.depositToken) {
      try {
        s.step = 'confirm_mint';
        const built = await buildMintConfirmMessage(s);
        await ctx.editMessageText(built.text, {
          reply_markup: mintConfirmKeyboard({ priceMismatch: built.priceMismatch }),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.editMessageText(`Preview failed: ${msg.slice(0, 300)}`);
      }
      return;
    }

    s.step = 'pick_asset';
    const assets = depositAssets(s.chainId);
    const kb = new InlineKeyboard();
    for (const a of assets) {
      kb.text(a.symbol, `asset:${a.address}`).row();
    }
    await ctx.editMessageText(
      `Width ${w}% (saved).\nPick deposit asset (single-sided):`,
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^asset:(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (!s.chainId || !s.selectedPool || !s.widthPercent) {
      await ctx.answerCallbackQuery({ text: 'Session expired' });
      return;
    }
    const token = ctx.match![1] as Address;
    const pool = s.selectedPool;
    const tLower = token.toLowerCase();
    const wrapped = CHAINS[s.chainId].wrapped.toLowerCase();
    const native = '0x0000000000000000000000000000000000000000';
    const inPool =
      pool.token0.toLowerCase() === tLower ||
      pool.token1.toLowerCase() === tLower ||
      (tLower === wrapped &&
        (pool.token0.toLowerCase() === native || pool.token1.toLowerCase() === native));
    if (!inPool) {
      await ctx.answerCallbackQuery({
        text: 'Asset not in this pool — pick another',
        show_alert: true,
      });
      return;
    }
    s.depositToken = token;
    const meta = await getTokenMeta(s.chainId, token);
    s.depositSymbol = meta.symbol;
    s.depositUserPicked = true;
    s.step = 'await_percent';
    const eff = await getEffectiveDepositBalance(s.chainId, token);
    await ctx.answerCallbackQuery();

    let balLine = `Balance: \`${formatUnits(eff.erc20, meta.decimals)} ${meta.symbol}\``;
    if (eff.isWrapped) {
      const nativeSym = CHAINS[s.chainId].nativeSymbol;
      balLine +=
        `\nNative ${nativeSym}: \`${formatUnits(eff.native, 18)}\` (wrappable \`${formatUnits(eff.wrappable, 18)}\` after gas reserve)` +
        `\n*Available for %*: \`${formatUnits(eff.effective, 18)} ${meta.symbol}\` (WETH/WBNB + wrappable native)` +
        `\n_Shortfall is auto-wrapped on mint._`;
    }

    await ctx.editMessageText(
      `Deposit *${meta.symbol}*\n${balLine}\n\n` +
        `Send % of available to use (1–100), e.g. \`25\` or \`12.5\``,
      { parse_mode: 'Markdown' },
    );
  });

  bot.callbackQuery('mint:confirm', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (!s.selectedPool || !s.depositToken) {
      await ctx.answerCallbackQuery({ text: 'Session expired — paste CA again' });
      return;
    }

    // Re-check live mismatch before mint (pool tick can move)
    try {
      const built = await buildMintConfirmMessage(s);
      if (built.priceMismatch) {
        await ctx.answerCallbackQuery({ text: 'Price mismatch — confirm risk' });
        await ctx.editMessageText(
          built.text +
            `\n\n⚠️ **Second confirmation required**\n` +
            `Pool now is the **on-chain tick**, not DexScreener.\n` +
            `Only proceed if you accept a possibly off-market range.`,
          { reply_markup: mintMismatchKeyboard(), parse_mode: 'Markdown' },
        );
        return;
      }
    } catch (e) {
      // If re-preview fails, still allow force path via mint attempt
      console.warn('[mint:confirm recheck]', e instanceof Error ? e.message : e);
    }

    await executeMintFromConfirm(ctx, s);
  });

  /** User accepted pool/market mismatch — mint anyway */
  bot.callbackQuery('mint:confirm:force', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (!s.selectedPool || !s.depositToken) {
      await ctx.answerCallbackQuery({ text: 'Session expired — paste CA again' });
      return;
    }
    await executeMintFromConfirm(ctx, s);
  });

  async function executeMintFromConfirm(ctx: Context, s: UserSession): Promise<void> {
    if (!s.selectedPool || !s.depositToken) return;
    await ctx.answerCallbackQuery({ text: 'Minting…' });
    await ctx.editMessageText(
      '⏳ Minting position…\n_(wrap / ETH→stable auto if enabled)_',
      { parse_mode: 'Markdown' },
    );
    const prepLines: string[] = [];
    try {
      const selected = s.selectedPool;
      const prefs = getUserPrefs(ctx.from!.id);

      // Dep Auto: always re-derive deposit from live pool legs (WETH vs USDG).
      // Never mint with a token that isn't currency0/currency1.
      {
        const { resolveDepositForPool } = await import('./quickMint.js');
        const mode = prefs.depositMode ?? s.depositMode ?? 'auto';
        const resolved = await resolveDepositForPool(
          s.chainId,
          selected,
          mode,
          s.depositToken,
          s.depositUserPicked === true && mode !== 'auto',
          s.tokenCa, // meme CA → deposit = exact other pool token (v3 ETH/meow)
        );
        if (
          !s.depositToken ||
          s.depositToken.toLowerCase() !== resolved.address.toLowerCase()
        ) {
          console.log(
            `[mint] deposit re-resolved ${s.depositSymbol ?? s.depositToken} → ${resolved.symbol}` +
              (resolved.note ? ` (${resolved.note})` : ''),
          );
        }
        if (resolved.note) prepLines.push(resolved.note);
        s.depositToken = resolved.address;
        s.depositSymbol = resolved.symbol;
      }

      // Auto ETH/WETH → USDG/USDC when deposit is stable (hard-fail if short & can't fund)
      {
        const { isStableToken, prepareStableDepositForMint } = await import('../chain/swap.js');
        if (isStableToken(s.chainId, s.depositToken)) {
          try {
            const prep = await prepareStableDepositForMint({
              chainId: s.chainId,
              stableToken: s.depositToken,
              sizeMode: s.sizeMode,
              balancePercent: s.balancePercent,
              fixedAmountHuman: s.fixedAmountHuman,
              autoSwap: prefs.autoSwapEthToStable,
            });
            prepLines.push(...prep.lines);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn('[mint auto stable]', msg);
            // Fail mint early with clear reason (do not attempt 0-balance mint)
            await ctx.reply(`❌ Can't fund stable deposit:\n${msg.slice(0, 500)}`);
            return;
          }
        }
      }

      // v4 native ETH pools: always pass protocol+key (bytes32 poolId must not hit v3 path)
      const protocol =
        selected.protocol === 'v4' ||
        (typeof selected.poolId === 'string' && /^0x[a-fA-F0-9]{64}$/i.test(selected.poolId)) ||
        /^0x[a-fA-F0-9]{64}$/i.test(String(selected.poolAddress))
          ? 'v4'
          : (selected.protocol ?? 'v3');

      const mintDex: DexId =
        protocol === 'v4' ? 'uniswap' : (selected.dex ?? 'uniswap');

      const result = await mintSingleSided({
        chainId: s.chainId,
        poolAddress: selected.poolAddress,
        depositToken: s.depositToken,
        balancePercent: s.balancePercent,
        sizeMode: s.sizeMode,
        fixedAmountHuman: s.fixedAmountHuman,
        widthPercent: s.widthPercent,
        protocol,
        dex: mintDex,
        poolKey: selected.poolKey,
        poolId: selected.poolId ?? (protocol === 'v4' ? (selected.poolAddress as `0x${string}`) : undefined),
      });

      // On-chain mint succeeded — never report "Mint failed" for post-mint bookkeeping.
      try {
        // ACTUAL deposited capital: result.amount0/amount1 is the real
        // on-chain amount pulled into the position (v3: decoded from the
        // mint's IncreaseLiquidity event; v4: re-derived from the minted
        // position's live liquidity) — not the pre-mint offered ceiling
        // (result.depositAmount), which can exceed what was actually
        // consumed. See PHASE3_ACCOUNTING_AUDIT.md "Deposit accounting".
        const [meta0, meta1] = await Promise.all([
          getTokenMeta(s.chainId, result.token0),
          getTokenMeta(s.chainId, result.token1),
        ]);
        const [p0, p1] = await Promise.all([
          getTokenPriceUsd(s.chainId, result.token0),
          getTokenPriceUsd(s.chainId, result.token1),
        ]);
        const a0human = humanToFloat(result.amount0, meta0.decimals);
        const a1human = humanToFloat(result.amount1, meta1.decimals);
        const depUsd = a0human * (p0 ?? 0) + a1human * (p1 ?? 0);
        const depositIsToken0 = result.token0.toLowerCase() === s.depositToken.toLowerCase();
        const depositRaw = depositIsToken0 ? result.amount0 : result.amount1;
        const depHuman = depositIsToken0 ? a0human : a1human;
        const depMeta = depositIsToken0 ? meta0 : meta1;

        recordOpenPosition({
          chainId: s.chainId,
          tokenId: result.tokenId.toString(),
          poolAddress: String(result.poolAddress),
          token0: result.token0,
          token1: result.token1,
          fee: result.fee,
          tickLower: result.tickLower,
          tickUpper: result.tickUpper,
          protocol: result.protocol ?? selected.protocol ?? 'v3',
          dex: result.dex ?? mintDex,
        });
        // Stage accounting metadata in the journal BEFORE recordLedger() (Phase 3.5).
        setJournalAccountingMeta(s.chainId, result.hash, [{
          kind: 'deposit',
          tokenId: result.tokenId.toString(),
          tokenAddress: s.depositToken,
          amountRaw: depositRaw.toString(),
          amountHuman: depHuman,
          usd: depUsd,
        }]);
        recordLedger({
          chainId: s.chainId,
          tokenId: result.tokenId.toString(),
          kind: 'deposit',
          tokenAddress: s.depositToken,
          amountRaw: depositRaw.toString(),
          amountHuman: depHuman,
          usd: depUsd,
          txHash: result.hash,
        });

        resetFlow(ctx.from!.id);
        getSession(ctx.from!.id).chainId = s.chainId;

        const wrapLine = result.wrap
          ? `Wrapped ${formatUnits(result.wrap.amount, 18)} native → ${depMeta.symbol}\n` +
            `wrap: ${txUrl(s.chainId, result.wrap.hash)}\n`
          : '';

        const core = new Set(['WETH', 'WBNB', 'USDC', 'USDG', 'USDT', 'ETH', 'BNB']);
        const name = !core.has(meta0.symbol.toUpperCase())
          ? meta0.symbol
          : !core.has(meta1.symbol.toUpperCase())
            ? meta1.symbol
            : `${meta0.symbol}/${meta1.symbol}`;
        setPositionLabel(s.chainId, result.tokenId.toString(), name);

        const compact = formatCompactRange({
          chainId: s.chainId,
          token0: result.token0,
          token1: result.token1,
          decimals0: meta0.decimals,
          decimals1: meta1.decimals,
          symbol0: meta0.symbol,
          symbol1: meta1.symbol,
          tickLower: result.tickLower,
          tickUpper: result.tickUpper,
          currentTick: result.currentTick,
        });
        const ver = result.protocol ?? selected.protocol ?? 'v3';
        const resultDex = result.dex ?? mintDex;
        const venueTag =
          ver === 'v4' ? 'v4' : resultDex === 'pancakeswap' ? 'PCS' : 'UNI';
        const uniLink = uniswapPositionUrl(s.chainId, result.tokenId, ver, resultDex);

        const prepBlock = prepLines.length ? prepLines.join('\n') + '\n' : '';
        await ctx.reply(
          `✅ ${name} #${result.tokenId} [${venueTag}]\n` +
            prepBlock +
            wrapLine +
            `Range: ${compact}\n` +
            `Deposited ~${formatUnits(depositRaw, depMeta.decimals)} ${depMeta.symbol} (${formatUsd(depUsd)})\n` +
            `mint: ${result.txLink}\n` +
            `${uniLink}`,
          { link_preview_options: { is_disabled: true } },
        );
      } catch (postErr) {
        const msg = postErr instanceof Error ? postErr.message : String(postErr);
        console.error('[mint post-success]', msg);
        // Still confirm success — position is on-chain
        await ctx.reply(
          `✅ Minted #${result.tokenId} (on-chain OK)\n` +
            `mint: ${result.txLink}\n` +
            `Note: post-mint bookkeeping failed:\n${msg.slice(0, 300)}`,
          { link_preview_options: { is_disabled: true } },
        );
        resetFlow(ctx.from!.id);
        getSession(ctx.from!.id).chainId = s.chainId;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[mint failed]', msg);
      if (e instanceof Error && e.stack) console.error(e.stack);
      const prepHint =
        prepLines.length > 0 ? `\n\nPrep:\n${prepLines.join('\n').slice(0, 300)}` : '';
      await ctx.reply(`Mint failed:\n${msg.slice(0, 450)}${prepHint}`);
    }
  }

  bot.callbackQuery('mint:refresh', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (!s.selectedPool || !s.depositToken || !s.chainId) {
      await ctx.answerCallbackQuery({ text: 'Session expired — paste CA again' });
      return;
    }
    // Answer first — RPC preview can take a second on volatile pools
    await ctx.answerCallbackQuery({ text: 'Refreshing price & range…' });
    try {
      s.step = 'confirm_mint';
      const built = await buildMintConfirmMessage(s);
      try {
        await ctx.editMessageText(built.text, {
          reply_markup: mintConfirmKeyboard({ priceMismatch: built.priceMismatch }),
        });
      } catch (editErr) {
        const em = editErr instanceof Error ? editErr.message : String(editErr);
        // Same content (price unchanged within the second) — ignore
        if (!/message is not modified/i.test(em)) throw editErr;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await ctx.editMessageText(
          `Refresh failed:\n${msg.slice(0, 400)}\n\nTap Refresh again or Cancel.`,
          { reply_markup: mintConfirmKeyboard({ priceMismatch: s.mintPriceMismatch }) },
        );
      } catch {
        await ctx.reply(`Refresh failed:\n${msg.slice(0, 400)}`);
      }
    }
  });

  bot.callbackQuery('mint:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const chainId = getSession(ctx.from!.id).chainId;
    resetFlow(ctx.from!.id);
    if (chainId) getSession(ctx.from!.id).chainId = chainId;
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await ctx.editMessageText('Mint cancelled.');
  });

  // Close step 1: confirmation (anti fat-finger) — skip if closeConfirm OFF
  // Formats: close:v3:123 | close:v3:pcs:123 | close:v4:123 | close:v4:uni:123
  bot.callbackQuery(/^close:(?:(v3|v4):)?(?:(uni|pcs):)?(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = syncSessionFromPrefs(ctx.from!.id);
    const protocol = (ctx.match![1] as 'v3' | 'v4' | undefined) ?? 'v3';
    const dex = parseDexCode(ctx.match![2]);
    const tokenId = BigInt(ctx.match![3]!);
    const prefs = getUserPrefs(ctx.from!.id);
    const venue = protocol === 'v4' ? 'v4' : dexLabel(dex);

    // Instant close — no second tap
    if (!prefs.closeConfirm) {
      await ctx.answerCallbackQuery({ text: 'Closing…' });
      try {
        await ctx.editMessageText(`⏳ Closing #${tokenId} (${venue})…`);
      } catch {
        await ctx.reply(`⏳ Closing #${tokenId} (${venue})…`);
      }
      await executeClosePosition(ctx, s.chainId, protocol, tokenId, prefs, dex);
      return;
    }

    await ctx.answerCallbackQuery();

    let detail = `#${tokenId} [${venue}]`;
    try {
      const positions = await listPositionsFast(s.chainId);
      const p = positions.find(
        (x) =>
          x.tokenId === tokenId &&
          (x.protocol ?? 'v3') === protocol &&
          (protocol === 'v4' || (x.dex ?? 'uniswap') === dex),
      );
      if (p) {
        detail =
          `#${tokenId} [${venue}] ${p.symbol0}/${p.symbol1}\n` +
          `Val ~${formatUsd(p.valueUsd)} · ${p.inRange ? '🟢 IN' : '🔴 OUT'}`;
      }
    } catch {
      /* preview optional */
    }

    const autoNote =
      prefs.closeSwapTarget === 'off'
        ? `\nAuto-swap after close: OFF`
        : prefs.closeSwapTarget === 'eth'
          ? `\n⚡ After close (GMGN): meme+stable → ${CHAINS[s.chainId].nativeSymbol}`
          : `\n⚡ After close (GMGN): meme → stable`;

    const kb = new InlineKeyboard()
      .text('✅ Confirm close', `closego:${protocol}:${dexCode(dex)}:${tokenId}`)
      .row()
      .text('❌ Cancel', 'close:cancel');
    try {
      await ctx.editMessageText(
        `⚠️ Close position?\n\n${detail}${autoNote}\n\nThis fully exits LP (decrease + collect).`,
        { reply_markup: kb },
      );
    } catch {
      await ctx.reply(
        `⚠️ Close position?\n\n${detail}${autoNote}\n\nThis fully exits LP (decrease + collect).`,
        { reply_markup: kb },
      );
    }
  });

  bot.callbackQuery('close:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('Close cancelled.');
    } catch {
      /* ignore */
    }
  });

  // Claim fees only (position stays open)
  // Formats: claim:v3:123 | claim:v3:pcs:123 | claim:v4:123
  bot.callbackQuery(/^claim:(v3|v4)(?::(uni|pcs))?:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = syncSessionFromPrefs(ctx.from!.id);
    const protocol = ctx.match![1] as 'v3' | 'v4';
    const dex = parseDexCode(ctx.match![2]);
    const tokenId = BigInt(ctx.match![3]!);
    const venue = protocol === 'v4' ? 'v4' : dexLabel(dex);
    await ctx.answerCallbackQuery({ text: 'Claiming fees…' });
    try {
      await ctx.reply(`⏳ Claiming fees on #${tokenId} [${venue}]…`);
      const result = await claimFees(s.chainId, tokenId, protocol, dex);
      if (result.feesUsd > 0 || result.amount0Human > 0 || result.amount1Human > 0) {
        // Stage accounting metadata in the journal BEFORE recordLedger() (Phase 3.5).
        setJournalAccountingMeta(s.chainId, result.hash, [{
          kind: 'fee_claim',
          tokenId: tokenId.toString(),
          tokenAddress: null,
          amountRaw: null,
          amountHuman: result.amount0Human + result.amount1Human,
          usd: result.feesUsd,
        }]);
        recordLedger({
          chainId: s.chainId,
          tokenId: tokenId.toString(),
          kind: 'fee_claim',
          usd: result.feesUsd,
          amountHuman: result.amount0Human + result.amount1Human,
          txHash: result.hash,
        });
      }
      await ctx.reply(
        `✅ Claimed fees #${tokenId} [${venue}]\n` +
          `~${result.amount0Human.toFixed(6)} ${result.symbol0} + ` +
          `${result.amount1Human.toFixed(6)} ${result.symbol1}\n` +
          `~${formatUsd(result.feesUsd)}\n` +
          `tx: ${result.txLink}`,
        { link_preview_options: { is_disabled: true } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[claim failed]', msg);
      await ctx.reply(`Claim failed:\n${msg.slice(0, 500)}`);
    }
  });

  // Close step 2: execute (after confirm)
  bot.callbackQuery(/^closego:(v3|v4):(uni|pcs):(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = syncSessionFromPrefs(ctx.from!.id);
    const protocol = ctx.match![1] as 'v3' | 'v4';
    const dex = parseDexCode(ctx.match![2]);
    const tokenId = BigInt(ctx.match![3]!);
    const prefs = getUserPrefs(ctx.from!.id);
    const venue = protocol === 'v4' ? 'v4' : dexLabel(dex);
    await ctx.answerCallbackQuery({ text: 'Closing…' });
    try {
      await ctx.editMessageText(`⏳ Closing #${tokenId} (${venue})…`);
    } catch {
      await ctx.reply(`⏳ Closing #${tokenId} (${venue})…`);
    }
    await executeClosePosition(ctx, s.chainId, protocol, tokenId, prefs, dex);
  });

  // Legacy closego without dex (pre-PCS buttons)
  bot.callbackQuery(/^closego:(v3|v4):(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = syncSessionFromPrefs(ctx.from!.id);
    const protocol = ctx.match![1] as 'v3' | 'v4';
    const tokenId = BigInt(ctx.match![2]!);
    const prefs = getUserPrefs(ctx.from!.id);
    await ctx.answerCallbackQuery({ text: 'Closing…' });
    try {
      await ctx.editMessageText(`⏳ Closing #${tokenId} (${protocol})…`);
    } catch {
      await ctx.reply(`⏳ Closing #${tokenId} (${protocol})…`);
    }
    await executeClosePosition(ctx, s.chainId, protocol, tokenId, prefs, 'uniswap');
  });

  // /tokens → sell to native via GMGN (hard-require; no Uniswap fallback)
  // Callback encodes token address so buttons survive bot restarts (no session index).
  bot.callbackQuery(/^swap:(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = syncSessionFromPrefs(ctx.from!.id);
    const token = ctx.match![1] as Address;
    await ctx.answerCallbackQuery({ text: 'Loading…' });
    try {
      const meta = await getTokenMeta(s.chainId, token);
      const bal = await getTokenBalance(s.chainId, token);
      const human = formatUnits(bal, meta.decimals, 6);
      const px = (await getTokenPriceUsd(s.chainId, token)) ?? 0;
      const usd =
        px > 0 ? ` (~${formatUsd(Number(human) * px)})` : '';
      const native = CHAINS[s.chainId].nativeSymbol;
      const kb = new InlineKeyboard()
        .text(`✅ Sell all ${meta.symbol} → ${native} (GMGN)`, `swapgo:${token}`)
        .row()
        .text('❌ Cancel', 'swap:cancel');
      await ctx.reply(
        `Sell <b>${escapeHtmlBot(meta.symbol)}</b> → <b>${native}</b> via <b>GMGN</b>\n\n` +
          `Balance: <code>${human}</code>${usd}\n` +
          `<code>${token}</code>\n\n` +
          `<i>Requires gmgn-cli + API key. No Uniswap fallback.</i>`,
        { reply_markup: kb, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Preview failed:\n${msg.slice(0, 400)}`);
    }
  });

  bot.callbackQuery(/^swapgo:(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = syncSessionFromPrefs(ctx.from!.id);
    const token = ctx.match![1] as Address;
    await ctx.answerCallbackQuery({ text: 'GMGN sell…' });
    let symbol = token.slice(0, 10);
    try {
      const meta = await getTokenMeta(s.chainId, token);
      symbol = meta.symbol;
    } catch {
      /* ok */
    }
    const native = CHAINS[s.chainId].nativeSymbol;
    try {
      await ctx.editMessageText(`⏳ Selling ${symbol} → ${native} via GMGN…`);
    } catch {
      /* ignore */
    }
    try {
      const { gmgnSellAll } = await import('../gmgn/swap.js');
      const result = await gmgnSellAll(s.chainId, token);
      if (!result) {
        await ctx.reply(`Nothing to sell for ${symbol} (zero/dust balance).`);
        return;
      }
      await ctx.reply(
        `✅ GMGN sold ${symbol} → ${native}\n` +
          `mode: ${result.mode}\n` +
          `tx: ${result.txLink}`,
        { link_preview_options: { is_disabled: true } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[gmgn sell failed]', msg);
      await ctx.reply(
        `GMGN sell failed:\n${msg.slice(0, 500)}\n\n` +
          `Install/configure gmgn-cli + ~/.config/gmgn API key.`,
      );
    }
  });

  bot.callbackQuery('swap:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('Swap cancelled.');
    } catch {
      /* ignore */
    }
  });

  // ── /swap (Relay native↔stable · Uniswap custom CA) ─────────────────────
  // Callbacks use rswap: prefix so they don't clash with /tokens Uniswap swap:
  bot.command('swap', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    resetFlow(ctx.from!.id);
    const s = getSession(ctx.from!.id);
    // Default to settings chain
    s.swapChainId = s.chainId;
    s.swapKind = 'relay';
    await replySwapPairs(ctx, s);
  });

  bot.callbackQuery(/^rswap:chain:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const chainId = Number(ctx.match![1]);
    if (!isSupportedChainId(chainId)) {
      await ctx.answerCallbackQuery({ text: 'Invalid chain' });
      return;
    }
    const s = getSession(ctx.from!.id);
    clearSwapSession(s);
    s.swapChainId = chainId;
    s.swapKind = 'relay';
    await ctx.answerCallbackQuery({ text: CHAINS[chainId].name });
    await replySwapPairs(ctx, s, true);
  });

  bot.callbackQuery(/^rswap:pair:([A-Za-z0-9]+):([A-Za-z0-9]+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const fromSym = ctx.match![1]!.toUpperCase();
    const toSym = ctx.match![2]!.toUpperCase();
    const chainId = s.swapChainId ?? s.chainId;
    const { isSwapAssetSymbol } = await import('../chain/relay.js');
    if (!isSwapAssetSymbol(chainId, fromSym) || !isSwapAssetSymbol(chainId, toSym)) {
      await ctx.answerCallbackQuery({ text: 'Unknown pair' });
      return;
    }
    if (fromSym === toSym) {
      await ctx.answerCallbackQuery({ text: 'Pick different tokens' });
      return;
    }
    s.swapChainId = chainId;
    s.swapKind = 'relay';
    s.swapFromSymbol = fromSym;
    s.swapToSymbol = toSym;
    s.swapFromToken = undefined;
    s.swapToToken = undefined;
    s.swapFromIsNative = undefined;
    s.swapToIsNative = undefined;
    s.swapAmount = undefined;
    s.swapPreview = undefined;
    s.swapTokenQuoteText = undefined;
    await ctx.answerCallbackQuery({ text: `${fromSym} → ${toSym}` });
    await replySwapAmount(ctx, s);
  });

  // Buy custom CA: pick pay asset → paste destination CA
  bot.callbackQuery('rswap:buyca', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const chainId = s.swapChainId ?? s.chainId;
    s.swapChainId = chainId;
    s.swapKind = 'token';
    s.swapToToken = undefined;
    s.swapToSymbol = undefined;
    s.swapToIsNative = false;
    s.swapAmount = undefined;
    await ctx.answerCallbackQuery({ text: 'Buy custom CA' });
    await replySwapPickPayAsset(ctx, s, 'buy');
  });

  // Sell custom CA: paste source CA → pick receive asset
  bot.callbackQuery('rswap:sellca', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const chainId = s.swapChainId ?? s.chainId;
    s.swapChainId = chainId;
    s.swapKind = 'token';
    s.swapFromToken = undefined;
    s.swapFromSymbol = undefined;
    s.swapFromIsNative = false;
    s.swapToToken = undefined;
    s.swapToSymbol = undefined;
    s.swapAmount = undefined;
    s.step = 'await_swap_from_ca';
    await ctx.answerCallbackQuery({ text: 'Sell custom CA' });
    try {
      await ctx.editMessageText(
        `💱 Sell custom token on ${CHAINS[chainId].name}\n\n` +
          `Paste the token CA you want to sell.\n` +
          `/cancel to abort.`,
      );
    } catch {
      await ctx.reply(
        `💱 Sell custom token on ${CHAINS[chainId].name}\n\n` +
          `Paste the token CA you want to sell.\n` +
          `/cancel to abort.`,
      );
    }
  });

  // Pay-with asset for buy-CA (from = listed, to = CA next)
  bot.callbackQuery(/^rswap:pay:([A-Za-z0-9]+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const chainId = s.swapChainId ?? s.chainId;
    const sym = ctx.match![1]!.toUpperCase();
    const { isSwapAssetSymbol } = await import('../chain/relay.js');
    if (!isSwapAssetSymbol(chainId, sym)) {
      await ctx.answerCallbackQuery({ text: 'Unknown asset' });
      return;
    }
    applyListedAssetAsFrom(s, chainId, sym);
    s.swapKind = 'token';
    s.step = 'await_swap_to_ca';
    await ctx.answerCallbackQuery({ text: `Pay with ${sym}` });
    try {
      await ctx.editMessageText(
        `💱 Buy custom token · pay with ${sym}\n` +
          `${CHAINS[chainId].name}\n\n` +
          `Paste the token CA you want to buy.\n` +
          `/cancel to abort.`,
      );
    } catch {
      await ctx.reply(
        `💱 Buy custom token · pay with ${sym}\n` +
          `Paste the token CA you want to buy.\n` +
          `/cancel to abort.`,
      );
    }
  });

  // Receive asset for sell-CA (from = CA already set)
  bot.callbackQuery(/^rswap:recv:([A-Za-z0-9]+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const chainId = s.swapChainId ?? s.chainId;
    const sym = ctx.match![1]!.toUpperCase();
    const { isSwapAssetSymbol } = await import('../chain/relay.js');
    if (!isSwapAssetSymbol(chainId, sym)) {
      await ctx.answerCallbackQuery({ text: 'Unknown asset' });
      return;
    }
    if (!s.swapFromToken || !s.swapFromSymbol) {
      await ctx.answerCallbackQuery({ text: 'Paste sell CA first' });
      return;
    }
    applyListedAssetAsTo(s, chainId, sym);
    s.swapKind = 'token';
    s.swapAmount = undefined;
    await ctx.answerCallbackQuery({ text: `Receive ${sym}` });
    await replySwapAmount(ctx, s);
  });

  bot.callbackQuery(/^rswap:amt:(25|50|100)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const pct = Number(ctx.match![1]);
    await ctx.answerCallbackQuery({ text: `${pct}%` });
    await runSwapQuote(ctx, s, { mode: 'percent', percent: pct });
  });

  bot.callbackQuery('rswap:amt:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (!s.swapFromSymbol || s.swapChainId == null) {
      await ctx.answerCallbackQuery({ text: 'Start with /swap' });
      return;
    }
    s.step = 'await_swap_amount';
    await ctx.answerCallbackQuery({ text: 'Type amount' });
    try {
      await ctx.editMessageText(
        `Send amount of ${s.swapFromSymbol} to swap (e.g. 10 or 0.05).\n/cancel to abort.`,
      );
    } catch {
      await ctx.reply(
        `Send amount of ${s.swapFromSymbol} to swap (e.g. 10 or 0.05).\n/cancel to abort.`,
      );
    }
  });

  bot.callbackQuery('rswap:confirm', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (s.swapChainId == null || !s.swapFromSymbol || !s.swapToSymbol || s.swapAmount == null) {
      await ctx.answerCallbackQuery({ text: 'Session expired — /swap again' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Swapping…' });

    // Custom CA → Uniswap Trading API / local multi-hop
    if (s.swapKind === 'token') {
      try {
        await ctx.editMessageText(
          `⏳ Swapping ${s.swapFromSymbol} → ${s.swapToSymbol}…`,
        );
      } catch {
        /* ignore */
      }
      try {
        const { swapFlexible, NATIVE_TOKEN } = await import('../chain/swap.js');
        const tokenIn = s.swapFromIsNative
          ? NATIVE_TOKEN
          : (s.swapFromToken as Address);
        const tokenOut = s.swapToIsNative
          ? NATIVE_TOKEN
          : (s.swapToToken as Address);
        if (!tokenIn || !tokenOut) {
          throw new Error('Missing token addresses — /swap again');
        }
        const fromSym = s.swapFromSymbol;
        const toSym = s.swapToSymbol;
        const amtRaw = s.swapAmount;
        const fromNative = s.swapFromIsNative === true;
        const r = await swapFlexible({
          chainId: s.swapChainId,
          tokenIn,
          tokenOut,
          amountIn: amtRaw,
          fromIsNative: fromNative,
          toIsNative: s.swapToIsNative === true,
        });
        const amtIn = formatUnits(
          amtRaw,
          fromNative
            ? 18
            : (await getTokenMeta(s.swapChainId, tokenIn)).decimals,
        );
        clearSwapSession(s);
        s.step = 'idle';
        await ctx.reply(
          `✅ Swapped ${amtIn} ${fromSym} → ${toSym}\n` +
            `Route: ${r.routeLabel}\n` +
            `tx: ${r.txLink}`,
          { link_preview_options: { is_disabled: true } },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[token swap failed]', msg);
        await ctx.reply(`Swap failed:\n${msg.slice(0, 600)}`);
      }
      return;
    }

    // Listed pairs: best of Relay + Across
    const {
      previewAggregatedSwap,
      executeAggregatedQuote,
      formatAggregatedResult,
    } = await import('../chain/aggregate.js');
    try {
      await ctx.editMessageText('⏳ Getting best quote (Relay + Across)…');
    } catch {
      /* ignore */
    }
    try {
      const preview = await previewAggregatedSwap({
        chainId: s.swapChainId,
        fromSymbol: s.swapFromSymbol,
        toSymbol: s.swapToSymbol,
        amount: s.swapAmount,
      });
      s.swapPreview = preview;
      try {
        await ctx.editMessageText(
          `⏳ Swapping via ${preview.provider === 'across' ? 'Across' : 'Relay'}: ${preview.amountInFormatted} ${preview.from.symbol} → ${preview.to.symbol}…`,
        );
      } catch {
        /* ignore */
      }
      const result = await executeAggregatedQuote(preview, async (msg) => {
        try {
          await ctx.editMessageText(`⏳ ${msg}`);
        } catch {
          /* ignore */
        }
      });
      clearSwapSession(s);
      s.step = 'idle';
      await ctx.reply(formatAggregatedResult(result, preview), {
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[aggregated swap failed]', msg);
      await ctx.reply(`Swap failed:\n${msg.slice(0, 600)}`);
    }
  });

  bot.callbackQuery('rswap:refresh', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (s.swapAmount == null) {
      await ctx.answerCallbackQuery({ text: 'No amount yet' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Refreshing quote…' });
    await runSwapQuote(ctx, s, { mode: 'raw', amount: s.swapAmount });
  });

  bot.callbackQuery('rswap:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    clearSwapSession(s);
    s.step = 'idle';
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('Swap cancelled.');
    } catch {
      await ctx.reply('Swap cancelled.');
    }
  });

  // ── /revoke (zero unlimited ERC-20 / Permit2 approvals) ─────────────────
  bot.command('revoke', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    resetFlow(ctx.from!.id);
    await replyRevokeMenu(ctx);
  });

  bot.callbackQuery(/^revoke:scan:(all|4663|56|8453)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const which = ctx.match![1]!;
    await ctx.answerCallbackQuery({ text: 'Scanning…' });
    const chainIds: SupportedChainId[] =
      which === 'all'
        ? [...SUPPORTED_CHAIN_IDS]
        : [Number(which) as SupportedChainId];
    await runRevokeScan(ctx, chainIds);
  });

  bot.callbackQuery(/^revoke:one:(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const idx = Number(ctx.match![1]);
    const list = s.revokeApprovals ?? [];
    const a = list[idx];
    if (!a) {
      await ctx.answerCallbackQuery({ text: 'Stale list — /revoke again' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Revoking…' });
    try {
      await ctx.editMessageText(
        `⏳ Revoking ${a.tokenSymbol} → ${a.spenderLabel} on ${CHAINS[a.chainId].name}…`,
      );
    } catch {
      /* ignore */
    }
    try {
      const { revokeApproval } = await import('../chain/revoke.js');
      const r = await revokeApproval(a);
      // drop from session list
      s.revokeApprovals = list.filter((_, i) => i !== idx);
      await ctx.reply(
        `✅ Revoked ${a.tokenSymbol} → ${a.spenderLabel}\n${r.link}`,
        { link_preview_options: { is_disabled: true } },
      );
      if (s.revokeApprovals.length) {
        await replyRevokeList(ctx, s.revokeApprovals);
      } else {
        clearRevokeSession(s);
        s.step = 'idle';
        await ctx.reply('🔒 All listed approvals revoked.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Revoke failed:\n${msg.slice(0, 500)}`);
    }
  });

  bot.callbackQuery('revoke:all', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const list = s.revokeApprovals ?? [];
    if (!list.length) {
      await ctx.answerCallbackQuery({ text: 'Nothing to revoke' });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Revoking ${list.length}…` });
    try {
      await ctx.editMessageText(`⏳ Revoking ${list.length} approval(s)…`);
    } catch {
      /* ignore */
    }
    try {
      const { revokeAll } = await import('../chain/revoke.js');
      const { ok, failed } = await revokeAll(list, async (msg, i, total) => {
        try {
          await ctx.editMessageText(`⏳ ${i}/${total}: ${msg}`);
        } catch {
          /* ignore */
        }
      });
      clearRevokeSession(s);
      s.step = 'idle';
      const lines = [
        `🔒 Revoke complete: ${ok.length} ok` +
          (failed.length ? `, ${failed.length} failed` : ''),
      ];
      for (const r of ok.slice(0, 12)) {
        lines.push(
          `✅ ${r.approval.tokenSymbol}→${r.approval.spenderLabel}: ${r.link}`,
        );
      }
      if (ok.length > 12) lines.push(`… +${ok.length - 12} more`);
      for (const f of failed.slice(0, 5)) {
        lines.push(
          `❌ ${f.approval.tokenSymbol}→${f.approval.spenderLabel}: ${f.error.slice(0, 80)}`,
        );
      }
      await ctx.reply(lines.join('\n'), {
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Revoke-all failed:\n${msg.slice(0, 500)}`);
    }
  });

  bot.callbackQuery('revoke:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    clearRevokeSession(s);
    s.step = 'idle';
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('Revoke cancelled.');
    } catch {
      await ctx.reply('Revoke cancelled.');
    }
  });

  // ── /bridge (best of Relay + Across: Robinhood ↔ BSC) ───────────────────
  bot.command('bridge', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    resetFlow(ctx.from!.id);
    await replyBridgeDirection(ctx);
  });

  bot.callbackQuery(/^bridge:dir:(\d+):(\d+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const from = Number(ctx.match![1]);
    const to = Number(ctx.match![2]);
    if (!isSupportedChainId(from) || !isSupportedChainId(to) || from === to) {
      await ctx.answerCallbackQuery({ text: 'Invalid direction' });
      return;
    }
    const s = getSession(ctx.from!.id);
    clearBridgeSession(s);
    s.bridgeFromChain = from;
    s.bridgeToChain = to;
    s.step = 'idle';
    await ctx.answerCallbackQuery({ text: `${CHAINS[from].name} → ${CHAINS[to].name}` });
    await replyBridgeFromToken(ctx, s);
  });

  bot.callbackQuery(/^bridge:from:([A-Za-z0-9]+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (s.bridgeFromChain == null || s.bridgeToChain == null) {
      await ctx.answerCallbackQuery({ text: 'Start with /bridge' });
      return;
    }
    const sym = ctx.match![1]!;
    const { isBridgeAssetSymbol } = await import('../chain/relay.js');
    if (!isBridgeAssetSymbol(s.bridgeFromChain, sym)) {
      await ctx.answerCallbackQuery({ text: 'Unknown token' });
      return;
    }
    s.bridgeFromSymbol = sym.toUpperCase();
    s.bridgeToSymbol = undefined;
    s.bridgeAmount = undefined;
    s.bridgePreview = undefined;
    await ctx.answerCallbackQuery({ text: `From ${s.bridgeFromSymbol}` });
    await replyBridgeToToken(ctx, s);
  });

  bot.callbackQuery(/^bridge:to:([A-Za-z0-9]+)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (s.bridgeFromChain == null || s.bridgeToChain == null || !s.bridgeFromSymbol) {
      await ctx.answerCallbackQuery({ text: 'Start with /bridge' });
      return;
    }
    const sym = ctx.match![1]!;
    const { isBridgeAssetSymbol } = await import('../chain/relay.js');
    if (!isBridgeAssetSymbol(s.bridgeToChain, sym)) {
      await ctx.answerCallbackQuery({ text: 'Unknown token' });
      return;
    }
    s.bridgeToSymbol = sym.toUpperCase();
    s.bridgeAmount = undefined;
    s.bridgePreview = undefined;
    await ctx.answerCallbackQuery({ text: `To ${s.bridgeToSymbol}` });
    await replyBridgeAmount(ctx, s);
  });

  bot.callbackQuery(/^bridge:amt:(25|50|100)$/, async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    const pct = Number(ctx.match![1]);
    await ctx.answerCallbackQuery({ text: `${pct}%` });
    await runBridgeQuote(ctx, s, { mode: 'percent', percent: pct });
  });

  bot.callbackQuery('bridge:amt:custom', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (!s.bridgeFromSymbol || s.bridgeFromChain == null) {
      await ctx.answerCallbackQuery({ text: 'Start with /bridge' });
      return;
    }
    s.step = 'await_bridge_amount';
    await ctx.answerCallbackQuery({ text: 'Type amount' });
    try {
      await ctx.editMessageText(
        `Send amount of ${s.bridgeFromSymbol} to bridge (e.g. 10 or 0.05).\n/cancel to abort.`,
      );
    } catch {
      await ctx.reply(
        `Send amount of ${s.bridgeFromSymbol} to bridge (e.g. 10 or 0.05).\n/cancel to abort.`,
      );
    }
  });

  bot.callbackQuery('bridge:confirm', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (
      s.bridgeFromChain == null ||
      s.bridgeToChain == null ||
      !s.bridgeFromSymbol ||
      !s.bridgeToSymbol ||
      s.bridgeAmount == null
    ) {
      await ctx.answerCallbackQuery({ text: 'Session expired — /bridge again' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Bridging…' });

    const {
      previewAggregatedBridge,
      executeAggregatedQuote,
      formatAggregatedResult,
    } = await import('../chain/aggregate.js');

    try {
      await ctx.editMessageText('⏳ Getting best quote (Relay + Across)…');
    } catch {
      /* ignore */
    }

    try {
      // Re-quote so steps/calldata are fresh (race providers again)
      const preview = await previewAggregatedBridge({
        fromChain: s.bridgeFromChain,
        toChain: s.bridgeToChain,
        fromSymbol: s.bridgeFromSymbol,
        toSymbol: s.bridgeToSymbol,
        amount: s.bridgeAmount,
      });
      s.bridgePreview = preview;

      try {
        await ctx.editMessageText(
          `⏳ Bridging via ${preview.provider === 'across' ? 'Across' : 'Relay'}: ${preview.amountInFormatted} ${preview.from.symbol} → ${preview.to.symbol}…`,
        );
      } catch {
        /* ignore */
      }

      const result = await executeAggregatedQuote(preview, async (msg) => {
        try {
          await ctx.editMessageText(`⏳ ${msg}`);
        } catch {
          /* ignore edit races */
        }
      });

      clearBridgeSession(s);
      s.step = 'idle';
      await ctx.reply(formatAggregatedResult(result, preview), {
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[bridge failed]', msg);
      await ctx.reply(`Bridge failed:\n${msg.slice(0, 600)}`);
    }
  });

  bot.callbackQuery('bridge:refresh', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    if (s.bridgeAmount == null) {
      await ctx.answerCallbackQuery({ text: 'No amount yet' });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Refreshing quote…' });
    await runBridgeQuote(ctx, s, { mode: 'raw', amount: s.bridgeAmount });
  });

  bot.callbackQuery('bridge:cancel', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    clearBridgeSession(s);
    s.step = 'idle';
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.editMessageText('Bridge cancelled.');
    } catch {
      await ctx.reply('Bridge cancelled.');
    }
  });

  bot.callbackQuery('bridge:back:dir', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const s = getSession(ctx.from!.id);
    clearBridgeSession(s);
    s.step = 'idle';
    await ctx.answerCallbackQuery();
    await replyBridgeDirection(ctx, true);
  });

  // Text / CA / percent
  bot.on('message:text', async (ctx) => {
    if (!(await requireAuth(ctx))) return;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    // Settings custom size: keep step (syncSessionFromPrefs does not reset step)
    const s = getSession(ctx.from!.id);
    // Refresh prefs fields without clobbering await_settings_* step
    {
      const prefs = getUserPrefs(ctx.from!.id);
      s.chainId = prefs.chainId;
      s.widthPercent = prefs.widthPercent;
      s.balancePercent = prefs.balancePercent;
      s.sizeMode = prefs.sizeMode;
      s.fixedAmountHuman = prefs.fixedAmountHuman;
      s.depositMode = prefs.depositMode;
    }

    // Multi-wallet: import private key
    if (s.step === 'await_import_pk') {
      // Best-effort delete so key doesn't linger in chat history
      try {
        await ctx.deleteMessage();
      } catch {
        /* may lack delete rights */
      }
      try {
        const pk = normalizePk(text.replace(/\s+/g, ''));
        const w = importWallet(pk);
        s.step = 'await_wallet_label';
        s.walletLabelTargetId = w.id;
        const kb = new InlineKeyboard()
          .text('Use as active', `wal:use:${w.id}`)
          .row()
          .text('Skip label', 'wal:label:skip')
          .text('← Menu', 'wal:menu');
        await ctx.reply(
          `✅ Imported wallet\n\n` +
            `Label: ${w.label}\n` +
            `Address:\n\`${w.address}\`\n\n` +
            `Send a custom label (or tap Skip).`,
          { parse_mode: 'Markdown', reply_markup: kb },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Import failed: ${msg.slice(0, 300)}\n\nTry again or /cancel.`, {
          reply_markup: new InlineKeyboard().text('← Menu', 'wal:menu'),
        });
      }
      return;
    }

    // Multi-wallet: optional label after generate/import
    if (s.step === 'await_wallet_label') {
      const id = s.walletLabelTargetId;
      if (!id) {
        s.step = 'idle';
        await replyWalletMenu(ctx);
        return;
      }
      try {
        const w = renameWallet(id, text);
        s.step = 'idle';
        s.walletLabelTargetId = undefined;
        await ctx.reply(`Labeled **${w.label}**.`, {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('Use as active', `wal:use:${w.id}`)
            .text('← Menu', 'wal:menu'),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Label failed: ${msg.slice(0, 200)}`);
      }
      return;
    }

    // Multi-wallet: rename
    if (s.step === 'await_wallet_rename') {
      const id = s.walletRenameId;
      if (!id) {
        s.step = 'idle';
        await replyWalletMenu(ctx);
        return;
      }
      try {
        const w = renameWallet(id, text);
        s.step = 'idle';
        s.walletRenameId = undefined;
        await ctx.reply(`Renamed to **${w.label}**.`, {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard().text('← Menu', 'wal:menu'),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Rename failed: ${msg.slice(0, 200)}`);
      }
      return;
    }

    // Multi-wallet: transfer custom amount
    if (s.step === 'await_transfer_amount') {
      if (
        !s.transferFromId ||
        !s.transferToId ||
        !s.transferChainId ||
        !s.transferAsset
      ) {
        s.step = 'idle';
        await ctx.reply('Transfer session expired. Start with /wallet.');
        return;
      }
      const raw = text.replace(/,/g, '.').replace(/[^\d.eE+-]/g, '');
      const human = Number(raw);
      if (!Number.isFinite(human) || human <= 0 || human > 1_000_000_000) {
        await ctx.reply('Enter a positive amount (e.g. 0.05). /cancel to abort.');
        return;
      }
      try {
        let decimals = 18;
        if (s.transferAsset !== 'native') {
          const meta = await getTokenMeta(s.transferChainId, s.transferAsset);
          decimals = meta.decimals;
          s.transferSymbol = meta.symbol;
        }
        const amount = humanToRaw(human, decimals);
        if (amount <= 0n) {
          await ctx.reply('Amount too small.');
          return;
        }
        s.transferAmount = amount;
        s.step = 'idle';
        await replyTransferConfirm(ctx, s, false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Invalid amount: ${msg.slice(0, 200)}`);
      }
      return;
    }

    // Custom range width from /settings
    if (s.step === 'await_settings_width') {
      const n = Number(text.replace(/%/g, '').replace(',', '.').trim());
      const w = parseWidthPercent(n, NaN);
      if (!Number.isFinite(w)) {
        await ctx.reply('Enter a width between 1 and 99 (e.g. 15 or 12.5).');
        return;
      }
      setUserPrefs(ctx.from!.id, { widthPercent: w });
      s.widthPercent = w;
      s.step = 'idle';
      await ctx.reply(`Range width set to **${w}%**.`, { parse_mode: 'Markdown' });
      await replySettings(ctx);
      return;
    }

    // Custom bridge amount
    if (s.step === 'await_bridge_amount') {
      const raw = text.replace(/,/g, '.').replace(/[^\d.eE+-]/g, '');
      const amt = Number(raw);
      if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000_000) {
        await ctx.reply('Enter a positive amount (e.g. 10 or 0.05). /cancel to abort.');
        return;
      }
      await runBridgeQuote(ctx, s, { mode: 'fixed', fixedHuman: amt });
      return;
    }

    // Custom Relay / Uniswap swap amount
    if (s.step === 'await_swap_amount') {
      const raw = text.replace(/,/g, '.').replace(/[^\d.eE+-]/g, '');
      const amt = Number(raw);
      if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000_000) {
        await ctx.reply('Enter a positive amount (e.g. 10 or 0.05). /cancel to abort.');
        return;
      }
      await runSwapQuote(ctx, s, { mode: 'fixed', fixedHuman: amt });
      return;
    }

    // /swap buy custom CA — paste destination token
    if (s.step === 'await_swap_to_ca') {
      const m = text.match(/0x[a-fA-F0-9]{40}/);
      if (!m) {
        await ctx.reply('Paste a valid token CA (0x…). /cancel to abort.');
        return;
      }
      try {
        const ca = assertAddress(m[0]!);
        const chainId = s.swapChainId ?? s.chainId;
        if (!s.swapFromSymbol) {
          await ctx.reply('Session expired — start with /swap');
          s.step = 'idle';
          return;
        }
        const meta = await getTokenMeta(chainId, ca);
        s.swapKind = 'token';
        s.swapToToken = ca;
        s.swapToIsNative = false;
        s.swapToSymbol = meta.symbol || ca.slice(0, 8);
        s.swapAmount = undefined;
        s.step = 'idle';
        await ctx.reply(
          `Buying *${s.swapToSymbol}* (\`${ca}\`)\n` +
            `Pay with: ${s.swapFromSymbol}`,
          { parse_mode: 'Markdown' },
        );
        await replySwapAmount(ctx, s);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Invalid token: ${msg.slice(0, 200)}`);
      }
      return;
    }

    // /swap sell custom CA — paste source token
    if (s.step === 'await_swap_from_ca') {
      const m = text.match(/0x[a-fA-F0-9]{40}/);
      if (!m) {
        await ctx.reply('Paste a valid token CA (0x…). /cancel to abort.');
        return;
      }
      try {
        const ca = assertAddress(m[0]!);
        const chainId = s.swapChainId ?? s.chainId;
        const meta = await getTokenMeta(chainId, ca);
        s.swapKind = 'token';
        s.swapFromToken = ca;
        s.swapFromIsNative = false;
        s.swapFromSymbol = meta.symbol || ca.slice(0, 8);
        s.swapToToken = undefined;
        s.swapToSymbol = undefined;
        s.swapAmount = undefined;
        s.step = 'idle';
        await replySwapPickRecvAsset(ctx, s);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Invalid token: ${msg.slice(0, 200)}`);
      }
      return;
    }

    // Custom wrap amount
    if (s.step === 'await_wrap_amount') {
      const raw = text.replace(/,/g, '.').replace(/[^\d.eE+-]/g, '');
      const human = Number(raw);
      if (!Number.isFinite(human) || human <= 0 || human > 1_000_000) {
        await ctx.reply('Enter a positive amount (e.g. 0.05). /cancel to abort.');
        return;
      }
      s.step = 'idle';
      try {
        await executeWrap(ctx, s.chainId, humanToRaw(human, 18));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Wrap failed: ${msg.slice(0, 300)}`);
      }
      return;
    }

    // Custom unwrap amount
    if (s.step === 'await_unwrap_amount') {
      const raw = text.replace(/,/g, '.').replace(/[^\d.eE+-]/g, '');
      const human = Number(raw);
      if (!Number.isFinite(human) || human <= 0 || human > 1_000_000) {
        await ctx.reply('Enter a positive amount (e.g. 0.05). /cancel to abort.');
        return;
      }
      s.step = 'idle';
      try {
        await executeUnwrap(ctx, s.chainId, humanToRaw(human, 18));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Unwrap failed: ${msg.slice(0, 300)}`);
      }
      return;
    }

    // Custom v4 create fee %
    if (s.step === 'await_create_v4_fee') {
      try {
        const { parseV4FeePercent, suggestTickSpacingForFee, formatV4FeePercent } =
          await import('../chain/v4.js');
        const fee = parseV4FeePercent(text);
        s.createV4Fee = fee;
        s.createV4TickSpacing = suggestTickSpacingForFee(fee);
        s.step = 'confirm_create_v4';
        await ctx.reply(
          `Fee set to **${formatV4FeePercent(fee)}** (spacing ${s.createV4TickSpacing}).`,
          { parse_mode: 'Markdown' },
        );
        await showCreateV4Preview(ctx, s);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`${msg}\nTry again (e.g. \`3.66\`) or /cancel.`);
      }
      return;
    }

    // Screener + alert filter custom inputs
    if (
      s.step === 'await_screener_vol' ||
      s.step === 'await_screener_kol' ||
      s.step === 'await_screener_fees' ||
      s.step === 'await_screener_mcap' ||
      s.step === 'await_screener_maxmcap' ||
      s.step === 'await_screener_limit' ||
      s.step === 'await_alert_vol' ||
      s.step === 'await_alert_kol' ||
      s.step === 'await_alert_fees' ||
      s.step === 'await_alert_mcap' ||
      s.step === 'await_alert_maxmcap'
    ) {
      const raw = text.replace(/[$,_\s]/g, '').toLowerCase();
      let n: number;
      if (raw.endsWith('k')) n = Number(raw.slice(0, -1)) * 1_000;
      else if (raw.endsWith('m')) n = Number(raw.slice(0, -1)) * 1_000_000;
      else if (raw.endsWith('b')) n = Number(raw.slice(0, -1)) * 1_000_000_000;
      else n = Number(raw.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) {
        await ctx.reply('Enter a non-negative number (e.g. `300000`, `300k`, `50m`, `0.5`).');
        return;
      }
      if (s.step === 'await_screener_vol') {
        setUserPrefs(ctx.from!.id, { screenerMinVolumeUsd: n });
        await ctx.reply(`Screener min vol → <b>$${n.toLocaleString()}</b>.`, { parse_mode: 'HTML' });
      } else if (s.step === 'await_screener_kol') {
        setUserPrefs(ctx.from!.id, { screenerMinKol: Math.round(n) });
        await ctx.reply(`Screener min KOL → <b>${Math.round(n)}</b>.`, { parse_mode: 'HTML' });
      } else if (s.step === 'await_screener_fees') {
        setUserPrefs(ctx.from!.id, { screenerMinTotalFee: n });
        await ctx.reply(`Screener min fees → <b>${n}</b>.`, { parse_mode: 'HTML' });
      } else if (s.step === 'await_screener_mcap') {
        setUserPrefs(ctx.from!.id, { screenerMinMcapUsd: n });
        await ctx.reply(`Screener min mcap → <b>$${n.toLocaleString()}</b>.`, { parse_mode: 'HTML' });
      } else if (s.step === 'await_screener_maxmcap') {
        setUserPrefs(ctx.from!.id, { screenerMaxMcapUsd: n });
        await ctx.reply(
          n === 0
            ? 'Screener max mcap → <b>no cap</b>.'
            : `Screener max mcap → <b>$${n.toLocaleString()}</b>.`,
          { parse_mode: 'HTML' },
        );
      } else if (s.step === 'await_screener_limit') {
        const lim = Math.min(100, Math.max(1, Math.round(n)));
        setUserPrefs(ctx.from!.id, { screenerLimit: lim });
        await ctx.reply(`Display limit → <b>${lim}</b>.`, { parse_mode: 'HTML' });
      } else if (s.step === 'await_alert_vol') {
        setUserPrefs(ctx.from!.id, { alertMinVolumeUsd: n });
        await ctx.reply(`Alert min 5m vol → <b>$${n.toLocaleString()}</b>.`, { parse_mode: 'HTML' });
      } else if (s.step === 'await_alert_kol') {
        setUserPrefs(ctx.from!.id, { alertMinKol: Math.round(n) });
        await ctx.reply(`Alert min KOL → <b>${Math.round(n)}</b>.`, { parse_mode: 'HTML' });
      } else if (s.step === 'await_alert_fees') {
        setUserPrefs(ctx.from!.id, { alertMinTotalFee: n });
        await ctx.reply(`Alert min fees → <b>${n}</b>.`, { parse_mode: 'HTML' });
      } else if (s.step === 'await_alert_mcap') {
        setUserPrefs(ctx.from!.id, { alertMinMcapUsd: n });
        await ctx.reply(`Alert min mcap → <b>$${n.toLocaleString()}</b>.`, { parse_mode: 'HTML' });
      } else if (s.step === 'await_alert_maxmcap') {
        setUserPrefs(ctx.from!.id, { alertMaxMcapUsd: n });
        await ctx.reply(
          n === 0
            ? 'Alert max mcap → <b>no cap</b>.'
            : `Alert max mcap → <b>$${n.toLocaleString()}</b>.`,
          { parse_mode: 'HTML' },
        );
      }
      s.step = 'idle';
      await replyScreenerFilters(ctx, false);
      return;
    }

    // Custom min TVL from /settings
    if (s.step === 'await_settings_mintvl') {
      const n = Number(text.replace(/[$,_\s]/g, '').replace(',', '.').trim());
      if (!Number.isFinite(n) || n < 0 || n > 100_000_000) {
        await ctx.reply('Enter a min TVL in USD (0–100000000), e.g. `2000` or `0`.');
        return;
      }
      const cleaned = parseMinTvlUsd(n);
      setUserPrefs(ctx.from!.id, { minTvlUsd: cleaned });
      s.step = 'idle';
      await ctx.reply(
        cleaned === 0
          ? 'Min pool TVL: **show all**.'
          : `Min pool TVL set to **$${cleaned.toLocaleString()}**.`,
        { parse_mode: 'Markdown' },
      );
      await replySettings(ctx);
      return;
    }

    // Custom default TP% from /settings
    if (s.step === 'await_settings_tp') {
      const n = Number(text.replace(/%/g, '').replace(',', '.').trim());
      if (!Number.isFinite(n) || n <= 0 || n > 500) {
        await ctx.reply('Enter a TP % between 0 and 500 (e.g. 10).');
        return;
      }
      const cleaned = Math.round(n * 100) / 100;
      setUserPrefs(ctx.from!.id, { tpPercent: cleaned });
      s.step = 'idle';
      await ctx.reply(`Default take-profit set to **+${cleaned}%**.`, { parse_mode: 'Markdown' });
      await replySettings(ctx);
      return;
    }

    // Custom default SL% from /settings
    if (s.step === 'await_settings_sl') {
      const n = Number(text.replace(/%/g, '').replace(',', '.').replace(/^-/, '').trim());
      if (!Number.isFinite(n) || n <= 0 || n > 500) {
        await ctx.reply('Enter an SL % between 0 and 500 (e.g. 15 for -15%).');
        return;
      }
      const cleaned = Math.round(n * 100) / 100;
      setUserPrefs(ctx.from!.id, { slPercent: cleaned });
      s.step = 'idle';
      await ctx.reply(`Default stop-loss set to **-${cleaned}%**.`, { parse_mode: 'Markdown' });
      await replySettings(ctx);
      return;
    }

    // Custom % from /settings
    if (s.step === 'await_settings_percent') {
      const pct = Number(text.replace(/%/g, '').replace(',', '.').trim());
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        await ctx.reply('Enter a percent from 1 to 100 (e.g. 33 or 12.5). /cancel to abort.');
        return;
      }
      // store one decimal max for cleanliness
      const cleaned = Math.round(pct * 100) / 100;
      setUserPrefs(ctx.from!.id, { sizeMode: 'percent', balancePercent: cleaned });
      syncSessionFromPrefs(ctx.from!.id);
      s.step = 'idle';
      await ctx.reply(`Size set to **${cleaned}% of balance**.`, { parse_mode: 'Markdown' });
      await replySettings(ctx);
      return;
    }

    // Custom fixed amount from /settings
    if (s.step === 'await_settings_fixed') {
      const raw = text.replace(/,/g, '.').replace(/[^\d.eE+-]/g, '');
      const amt = Number(raw);
      if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) {
        await ctx.reply(
          'Enter a positive fixed amount (e.g. 0.15 or 1). Max 1,000,000. /cancel to abort.',
        );
        return;
      }
      // keep up to 8 significant fraction digits
      const cleaned = Number(amt.toPrecision(12));
      setUserPrefs(ctx.from!.id, { sizeMode: 'fixed', fixedAmountHuman: cleaned });
      syncSessionFromPrefs(ctx.from!.id);
      s.step = 'idle';
      await ctx.reply(`Size set to **fixed ${cleaned}** (deposit-token units).`, {
        parse_mode: 'Markdown',
      });
      await replySettings(ctx);
      return;
    }

    // Targeted pool paste: v4 poolId (0x+64) always; v3 pool (0x+40) tried before token CA
    if (isV4PoolIdHex(text) || isAddressHex(text)) {
      const isPoolId = isV4PoolIdHex(text);
      try {
        if (isPoolId) {
          await ctx.reply(
            `Resolving v4 pool on ${CHAINS[s.chainId].name}…\n` +
              `(width ${s.widthPercent}% · size ${formatSizePref(s)} · deposit ${s.depositMode})`,
          );
        }
        const resolved = await resolveListedPoolFromPaste(s.chainId, text);
        if (resolved) {
          const { pool, memeToken } = resolved;
          s.tokenCa = memeToken;
          s.pools = [pool];
          s.selectedPool = pool;
          s.depositToken = undefined;
          s.depositSymbol = undefined;
          s.depositUserPicked = false;
          s.createV4Meme = undefined;

          if (!isPoolId) {
            await ctx.reply(
              `Resolved v3 pool on ${CHAINS[s.chainId].name}…\n` +
                `(width ${s.widthPercent}% · size ${formatSizePref(s)} · deposit ${s.depositMode})`,
            );
          }

          try {
            const { resolveDepositForPool } = await import('./quickMint.js');
            const dep = await resolveDepositForPool(
              s.chainId,
              pool,
              s.depositMode ?? 'auto',
              undefined,
              false,
              memeToken,
            );
            s.depositToken = dep.address;
            s.depositSymbol = dep.symbol;
            s.depositUserPicked = false;
            s.step = 'confirm_mint';
            const built = await buildMintConfirmMessage(s);
            let body = built.text;
            if (dep.note) body = `${body}\n\nℹ️ ${dep.note}`;
            const ver =
              pool.protocol === 'v4'
                ? 'v4'
                : pool.dex === 'pancakeswap'
                  ? 'PCS v3'
                  : 'UNI v3';
            await ctx.reply(
              `🎯 Targeted pool · ${ver}\n` +
                `${pool.label}\n` +
                `meme ${memeToken}\n\n` +
                body,
              {
                reply_markup: mintConfirmKeyboard({
                  priceMismatch: built.priceMismatch,
                }),
              },
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            s.step = 'pick_asset';
            const assets = depositAssets(s.chainId);
            const kb = new InlineKeyboard();
            for (const a of assets) {
              kb.text(a.symbol, `asset:${a.address}`).row();
            }
            await ctx.reply(
              `🎯 Pool: ${pool.label}\n\n` +
                `Auto deposit failed: ${msg.slice(0, 200)}\n` +
                `Pick deposit asset:`,
              { reply_markup: kb },
            );
          }
          return;
        }
        // null: 40-hex was not a v3 pool → fall through to token CA path
        if (isPoolId) {
          await ctx.reply('Could not resolve that v4 poolId. Try pasting the token CA instead.');
          return;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isPoolId) {
          await ctx.reply(`Failed to resolve pool: ${msg.slice(0, 400)}`);
          return;
        }
        // 40-hex failed pool probe — fall through to token CA discovery
      }
    }

    // Token CA paste → pick pool first (v3/v4 list)
    if (s.step === 'await_ca' || /^0x[a-fA-F0-9]{40}$/i.test(text)) {
      let ca: Address;
      try {
        ca = assertAddress(text);
      } catch {
        if (s.step === 'await_ca') await ctx.reply('Send a valid 0x contract address.');
        return;
      }
      try {
        await startMintFromCa(ctx, s, ca);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Failed to list pools: ${msg}`);
      }
      return;
    }

    // Percent input (wizard or settings override)
    if (s.step === 'await_percent') {
      const pct = Number(text.replace('%', ''));
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        await ctx.reply('Enter a number from 1 to 100 (e.g. 25).');
        return;
      }
      if (!s.depositToken || !s.selectedPool) {
        await ctx.reply('Session expired. Paste CA again.');
        return;
      }
      s.balancePercent = pct;
      s.sizeMode = 'percent';
      setUserPrefs(ctx.from!.id, { sizeMode: 'percent', balancePercent: pct });
      s.step = 'confirm_mint';
      try {
        const built = await buildMintConfirmMessage(s);
        await ctx.reply(built.text, {
          reply_markup: mintConfirmKeyboard({ priceMismatch: built.priceMismatch }),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Preview failed: ${msg}`);
      }
    }
  });

  bot.catch((err) => {
    console.error('Bot error', err.error ?? err);
    console.error(err);
  });

  return bot;
}

function mark(on: boolean, label: string): string {
  return on ? `✓ ${label}` : label;
}

/** Shared close + optional auto-swap (confirm or instant). */
async function executeClosePosition(
  ctx: Context,
  chainId: SupportedChainId,
  protocol: 'v3' | 'v4',
  tokenId: bigint,
  prefs: ReturnType<typeof getUserPrefs>,
  dex: DexId = 'uniswap',
): Promise<void> {
  try {
    // Snapshot wallet balances of position tokens BEFORE close so auto-swap
    // only spends the delta from THIS exit — never reserved ETH/USDG left in wallet.
    // IMPORTANT: use full balance delta (principal + fees). Never cap to the
    // pre-close estimate — that dropped unclaimed fees from auto-swap.
    const { getTokenBalance } = await import('../chain/tokens.js');
    const { getNativeBalance } = await import('../chain/wrap.js');
    const balBefore = new Map<string, bigint>();
    const snapshotted = new Set<string>();
    const NATIVE_KEY = 'native';
    const snapAddr = async (a: Address) => {
      const key = a.toLowerCase();
      try {
        balBefore.set(key, await getTokenBalance(chainId, a));
      } catch {
        balBefore.set(key, 0n);
      }
      snapshotted.add(key);
    };
    const snapNative = async () => {
      try {
        balBefore.set(NATIVE_KEY, await getNativeBalance(chainId));
      } catch {
        balBefore.set(NATIVE_KEY, 0n);
      }
      snapshotted.add(NATIVE_KEY);
    };

    await snapAddr(CHAINS[chainId].wrapped);
    await snapNative(); // v4 TAKE can deliver native ETH/BNB for native currency pools
    if (CHAINS[chainId].usdg) await snapAddr(CHAINS[chainId].usdg!);
    if (CHAINS[chainId].usdt) await snapAddr(CHAINS[chainId].usdt!);
    if (CHAINS[chainId].usdc) await snapAddr(CHAINS[chainId].usdc!);

    // Prefer direct position lookup (list can miss / race)
    try {
      if (protocol === 'v4') {
        const { getV4Position } = await import('../chain/v4.js');
        const live = await getV4Position(chainId, tokenId);
        if (live) {
          await snapAddr(live.token0);
          await snapAddr(live.token1);
        }
      } else {
        const { getPosition } = await import('../chain/positions.js');
        const live = await getPosition(chainId, tokenId, dex);
        if (live) {
          await snapAddr(live.token0);
          await snapAddr(live.token1);
        }
      }
    } catch {
      try {
        const opens = await listPositionsFast(chainId);
        const live = opens.find(
          (p) =>
            p.tokenId === tokenId &&
            (p.protocol ?? 'v3') === protocol &&
            (protocol === 'v4' || (p.dex ?? 'uniswap') === dex),
        );
        if (live) {
          await snapAddr(live.token0);
          await snapAddr(live.token1);
        }
      } catch {
        /* ok */
      }
    }

    const result = await closePosition(chainId, tokenId, protocol, dex);

    /**
     * Recovered amount for auto-swap = actual wallet increase from this close
     * (principal + fees). Do NOT cap to the pre-close estimate.
     * For WETH/WBNB also add native delta (v4 native currency settlements).
     */
    const recoveredAmt = async (addr: Address, estimate: bigint): Promise<bigint> => {
      const key = addr.toLowerCase();
      const wrapped = CHAINS[chainId].wrapped.toLowerCase();
      let afterErc20 = 0n;
      try {
        afterErc20 = await getTokenBalance(chainId, addr);
      } catch {
        afterErc20 = 0n;
      }
      const beforeErc20 = balBefore.get(key) ?? 0n;
      let delta =
        snapshotted.has(key) && afterErc20 > beforeErc20
          ? afterErc20 - beforeErc20
          : 0n;

      // Native leg (v4): ETH/BNB received for wrapped-side of the pair
      if (key === wrapped && snapshotted.has(NATIVE_KEY)) {
        let afterNat = 0n;
        try {
          afterNat = await getNativeBalance(chainId);
        } catch {
          afterNat = 0n;
        }
        const beforeNat = balBefore.get(NATIVE_KEY) ?? 0n;
        if (afterNat > beforeNat) {
          delta += afterNat - beforeNat;
        }
      }

      if (delta > 0n) {
        // Cap only by what we can spend: ERC20 after + (for WETH) wrappable native
        // already folded into delta for accounting; actual wrap happens at swap time
        return delta;
      }

      // Snapshot miss / zero delta: fall back to estimate capped by current balance
      // (never sweep full wallet when we didn't snapshot this token)
      if (estimate > 0n) {
        const cap = afterErc20 > 0n ? afterErc20 : estimate;
        return estimate < cap ? estimate : cap;
      }
      return 0n;
    };

    let rec0 = await recoveredAmt(result.token0, result.amount0);
    let rec1 = await recoveredAmt(result.token1, result.amount1);

    // If recovered native into "WETH" bucket, wrap native shortfall so swap can spend ERC-20
    const wrapForSwap = async (addr: Address, need: bigint) => {
      if (addr.toLowerCase() !== CHAINS[chainId].wrapped.toLowerCase()) return need;
      if (need <= 0n) return need;
      try {
        const bal = await getTokenBalance(chainId, addr);
        if (bal >= need) return need;
        const short = need - bal;
        const { wrapNative, getWrappableNative } = await import('../chain/wrap.js');
        const wrappable = await getWrappableNative(chainId);
        const toWrap = short < wrappable ? short : wrappable;
        if (toWrap > 0n) {
          const w = await wrapNative(chainId, toWrap);
          console.log(`[close auto-swap] wrapped ${toWrap} native for swap tx=${w.hash}`);
        }
        const after = await getTokenBalance(chainId, addr);
        return after < need ? after : need;
      } catch (e) {
        console.warn('[close auto-swap] wrap for swap', e);
        return need;
      }
    };
    rec0 = await wrapForSwap(result.token0, rec0);
    rec1 = await wrapForSwap(result.token1, rec1);

    console.log(
      `[close auto-swap] #${tokenId} rec0=${rec0} rec1=${rec1} est0=${result.amount0} est1=${result.amount1} ` +
        `(delta-based, fees included)`,
    );

    // Stage accounting metadata in the journal BEFORE recordLedger() so
    // that a crash between this point and the ledger writes below can be
    // recovered automatically on the next startup (Phase 3.5).
    // Both withdrawal and fee_claim are staged atomically in one call.
    const closeMeta: JournalAccountingMeta[] = [
      {
        kind: 'withdrawal',
        tokenId: tokenId.toString(),
        tokenAddress: null,
        amountRaw: null,
        amountHuman: result.amount0Human + result.amount1Human,
        usd: result.withdrawalUsd - result.feesPortionUsd,
      },
    ];
    if (result.feesPortionUsd > 0) {
      closeMeta.push({
        kind: 'fee_claim',
        tokenId: tokenId.toString(),
        tokenAddress: null,
        amountRaw: null,
        amountHuman: null,
        usd: result.feesPortionUsd,
        feeSplitIsEstimated: result.feeSplitIsEstimated,
      });
    }
    setJournalAccountingMeta(chainId, result.hash, closeMeta);

    recordLedger({
      chainId,
      tokenId: tokenId.toString(),
      kind: 'withdrawal',
      usd: result.withdrawalUsd - result.feesPortionUsd,
      amountHuman: result.amount0Human + result.amount1Human,
      txHash: result.hash,
    });
    if (result.feesPortionUsd > 0) {
      recordLedger({
        chainId,
        tokenId: tokenId.toString(),
        kind: 'fee_claim',
        usd: result.feesPortionUsd,
        txHash: result.hash,
      });
    }
    markClosed(chainId, tokenId.toString());
    if (ctx.from) {
      resetFlow(ctx.from.id);
      syncSessionFromPrefs(ctx.from.id);
    }

    await ctx.reply(
      `✅ Closed #${tokenId}\n` +
        `Received ~${result.amount0Human.toFixed(6)} ${result.symbol0} + ${result.amount1Human.toFixed(6)} ${result.symbol1}\n` +
        `Withdrawal value ~${formatUsd(result.withdrawalUsd)}\n` +
        `tx: ${result.txLink}`,
      { link_preview_options: { is_disabled: true } },
    );

    if (prefs.closeSwapTarget !== 'off') {
      const mode = prefs.closeSwapTarget === 'usdg' ? 'usdg' : 'eth';
      const dest =
        mode === 'eth'
          ? CHAINS[chainId].nativeSymbol
          : primaryStableSymbol(chainId);
      try {
        const zapNote =
          mode === 'usdg'
            ? `🔄 Zapout → ${dest}: GMGN meme→${CHAINS[chainId].nativeSymbol}, then Uniswap → ${dest}…\n_(GMGN only exits to native)_`
            : `🔄 Zapout via GMGN → ${dest}…\n_(only this close · needs gmgn-cli + API key)_`;
        await ctx.reply(zapNote);
        const { swapAfterClose } = await import('../chain/swap.js');
        const { lines } = await swapAfterClose(chainId, mode, [
          { address: result.token0, symbol: result.symbol0, amount: rec0 },
          { address: result.token1, symbol: result.symbol1, amount: rec1 },
        ]);
        if (lines.length) {
          await ctx.reply(`Zapout:\n${lines.join('\n')}`, {
            link_preview_options: { is_disabled: true },
          });
        } else {
          await ctx.reply('Zapout: nothing to swap from this position.');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await ctx.reply(
          `⚠️ Position closed OK, but GMGN zapout failed:\n${msg.slice(0, 400)}\n\n` +
            `_Configure gmgn-cli + ~/.config/gmgn API key to sell leftovers._`,
          { parse_mode: 'Markdown' },
        );
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`Close failed:\n${msg.slice(0, 500)}`);
  }
}

async function replySwapPairs(
  ctx: Context,
  s: UserSession,
  edit = false,
): Promise<void> {
  const chainId = s.swapChainId ?? s.chainId;
  s.swapChainId = chainId;
  const { swapPairs, getBridgeableBalance, getBridgeAsset } = await import(
    '../chain/relay.js'
  );
  const { formatUnits } = await import('../chain/tokens.js');
  const { hasTradingApiKey } = await import('../chain/tradingApi.js');
  const pairs = swapPairs(chainId);

  // Balances for native + stable
  const balLines: string[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    for (const sym of [p.fromSymbol, p.toSymbol]) {
      if (seen.has(sym)) continue;
      seen.add(sym);
      try {
        const asset = getBridgeAsset(chainId, sym);
        const bal = await withTimeout(
          getBridgeableBalance(chainId, asset),
          10_000,
          sym,
        );
        balLines.push(
          `  ${sym}: ${formatUnits(bal, asset.decimals, 6)}` +
            (asset.isNative ? ' (gas reserved)' : ''),
        );
      } catch {
        balLines.push(`  ${sym}: ?`);
      }
    }
  }

  const apiNote = hasTradingApiKey()
    ? 'Uniswap API for custom CA (v2/v3/v4 multi-hop)'
    : 'custom CA uses local v3 multi-hop (set UNISWAP_API_KEY for best routes)';

  const text =
    `💱 Swap · ${CHAINS[chainId].name}\n\n` +
    `Balances:\n${balLines.join('\n')}\n\n` +
    `Listed pairs (native ↔ stable · best of Relay + Across):\n` +
    `_or custom token CA · ${apiNote}_`;

  const kb = new InlineKeyboard();
  for (const p of pairs) {
    kb.text(p.label, `rswap:pair:${p.fromSymbol}:${p.toSymbol}`).row();
  }
  kb.text('🛒 Buy custom CA', 'rswap:buyca')
    .text('💸 Sell custom CA', 'rswap:sellca')
    .row()
    // Chain switcher
    .text(mark(chainId === 4663, 'Robinhood'), 'rswap:chain:4663')
    .text(mark(chainId === 56, 'BSC'), 'rswap:chain:56')
    .text(mark(chainId === 8453, 'Base'), 'rswap:chain:8453')
    .row()
    .text('❌ Cancel', 'rswap:cancel');

  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, {
        reply_markup: kb,
        parse_mode: 'Markdown',
      });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { reply_markup: kb, parse_mode: 'Markdown' });
}

/** Pay-with assets when buying a custom CA */
async function replySwapPickPayAsset(
  ctx: Context,
  s: UserSession,
  _mode: 'buy',
): Promise<void> {
  const chainId = s.swapChainId!;
  const c = CHAINS[chainId];
  const stable = primaryStableSymbol(chainId);
  const kb = new InlineKeyboard()
    .text(c.nativeSymbol, `rswap:pay:${c.nativeSymbol}`)
    .text(c.wrappedSymbol, `rswap:pay:${c.wrappedSymbol}`)
    .text(stable, `rswap:pay:${stable}`)
    .row()
    .text('← Back', `rswap:chain:${chainId}`)
    .text('❌ Cancel', 'rswap:cancel');
  const text =
    `🛒 Buy custom CA · ${c.name}\n\n` +
    `Pay with:`;
  try {
    await ctx.editMessageText(text, { reply_markup: kb });
  } catch {
    await ctx.reply(text, { reply_markup: kb });
  }
}

/** Receive assets when selling a custom CA */
async function replySwapPickRecvAsset(ctx: Context, s: UserSession): Promise<void> {
  const chainId = s.swapChainId!;
  const c = CHAINS[chainId];
  const stable = primaryStableSymbol(chainId);
  const kb = new InlineKeyboard()
    .text(c.nativeSymbol, `rswap:recv:${c.nativeSymbol}`)
    .text(c.wrappedSymbol, `rswap:recv:${c.wrappedSymbol}`)
    .text(stable, `rswap:recv:${stable}`)
    .row()
    .text('← Back', `rswap:chain:${chainId}`)
    .text('❌ Cancel', 'rswap:cancel');
  const text =
    `💸 Sell ${s.swapFromSymbol ?? 'token'} · ${c.name}\n` +
    `\`${s.swapFromToken}\`\n\n` +
    `Receive:`;
  try {
    await ctx.editMessageText(text, {
      reply_markup: kb,
      parse_mode: 'Markdown',
    });
  } catch {
    await ctx.reply(text, { reply_markup: kb, parse_mode: 'Markdown' });
  }
}

function applyListedAssetAsFrom(
  s: UserSession,
  chainId: SupportedChainId,
  sym: string,
): void {
  const c = CHAINS[chainId];
  const u = sym.toUpperCase();
  s.swapFromSymbol = u;
  if (u === c.nativeSymbol.toUpperCase()) {
    s.swapFromIsNative = true;
    s.swapFromToken = '0x0000000000000000000000000000000000000000' as Address;
  } else if (u === c.wrappedSymbol.toUpperCase()) {
    s.swapFromIsNative = false;
    s.swapFromToken = c.wrapped;
  } else if (u === 'USDG' && c.usdg) {
    s.swapFromIsNative = false;
    s.swapFromToken = c.usdg;
  } else if (u === 'USDT' && c.usdt) {
    s.swapFromIsNative = false;
    s.swapFromToken = c.usdt;
  } else if (u === 'USDC' && c.usdc) {
    s.swapFromIsNative = false;
    s.swapFromToken = c.usdc;
  } else {
    throw new Error(`Unknown asset ${sym}`);
  }
}

function applyListedAssetAsTo(
  s: UserSession,
  chainId: SupportedChainId,
  sym: string,
): void {
  const c = CHAINS[chainId];
  const u = sym.toUpperCase();
  s.swapToSymbol = u;
  if (u === c.nativeSymbol.toUpperCase()) {
    s.swapToIsNative = true;
    s.swapToToken = '0x0000000000000000000000000000000000000000' as Address;
  } else if (u === c.wrappedSymbol.toUpperCase()) {
    s.swapToIsNative = false;
    s.swapToToken = c.wrapped;
  } else if (u === 'USDG' && c.usdg) {
    s.swapToIsNative = false;
    s.swapToToken = c.usdg;
  } else if (u === 'USDT' && c.usdt) {
    s.swapToIsNative = false;
    s.swapToToken = c.usdt;
  } else if (u === 'USDC' && c.usdc) {
    s.swapToIsNative = false;
    s.swapToToken = c.usdc;
  } else {
    throw new Error(`Unknown asset ${sym}`);
  }
}

async function replySwapAmount(ctx: Context, s: UserSession): Promise<void> {
  const chainId = s.swapChainId!;
  const { formatUnits } = await import('../chain/tokens.js');
  let balStr = '?';
  let gasNote = '';

  if (s.swapKind === 'token') {
    try {
      if (s.swapFromIsNative) {
        const { getWrappableNative } = await import('../chain/wrap.js');
        const bal = await withTimeout(getWrappableNative(chainId), 10_000, 'bal');
        balStr = formatUnits(bal, 18, 6);
        gasNote = ' (gas reserved)';
      } else if (s.swapFromToken) {
        const bal = await withTimeout(
          getTokenBalance(chainId, s.swapFromToken),
          10_000,
          'bal',
        );
        const meta = await getTokenMeta(chainId, s.swapFromToken);
        balStr = formatUnits(bal, meta.decimals, 6);
      }
    } catch {
      /* ok */
    }
  } else {
    const { getBridgeAsset, getBridgeableBalance } = await import('../chain/relay.js');
    try {
      const asset = getBridgeAsset(chainId, s.swapFromSymbol!);
      const bal = await withTimeout(getBridgeableBalance(chainId, asset), 10_000, 'bal');
      balStr = formatUnits(bal, asset.decimals, 6);
      if (asset.isNative) gasNote = ' (gas reserved)';
    } catch {
      /* ok */
    }
  }

  const via =
    s.swapKind === 'token' ? 'Uniswap' : 'best quote';
  const text =
    `💱 ${CHAINS[chainId].name} · ${via}\n` +
    `${s.swapFromSymbol} → ${s.swapToSymbol}\n` +
    (s.swapKind === 'token' && s.swapToToken && !s.swapToIsNative
      ? `To: \`${s.swapToToken}\`\n`
      : '') +
    (s.swapKind === 'token' && s.swapFromToken && !s.swapFromIsNative
      ? `From: \`${s.swapFromToken}\`\n`
      : '') +
    `Available: ${balStr} ${s.swapFromSymbol}${gasNote}` +
    `\n\nPick amount:`;

  const kb = new InlineKeyboard()
    .text('25%', 'rswap:amt:25')
    .text('50%', 'rswap:amt:50')
    .text('100%', 'rswap:amt:100')
    .row()
    .text('Custom…', 'rswap:amt:custom')
    .row()
    .text('← Pairs', `rswap:chain:${chainId}`)
    .text('❌ Cancel', 'rswap:cancel');

  try {
    await ctx.editMessageText(text, {
      reply_markup: kb,
      parse_mode: 'Markdown',
    });
  } catch {
    await ctx.reply(text, { reply_markup: kb, parse_mode: 'Markdown' });
  }
}

async function runSwapQuote(
  ctx: Context,
  s: UserSession,
  amountSpec:
    | { mode: 'percent'; percent: number }
    | { mode: 'fixed'; fixedHuman: number }
    | { mode: 'raw'; amount: bigint },
): Promise<void> {
  if (s.swapChainId == null || !s.swapFromSymbol || !s.swapToSymbol) {
    await ctx.reply('Swap session incomplete — start with /swap');
    return;
  }

  // ── Custom CA via Uniswap ────────────────────────────────────────────
  if (s.swapKind === 'token') {
    try {
      const chainId = s.swapChainId;
      let fromDecimals = 18;
      let bal = 0n;
      if (s.swapFromIsNative) {
        const { getWrappableNative } = await import('../chain/wrap.js');
        bal = await getWrappableNative(chainId);
        fromDecimals = 18;
      } else if (s.swapFromToken) {
        const meta = await getTokenMeta(chainId, s.swapFromToken);
        fromDecimals = meta.decimals;
        bal = await getTokenBalance(chainId, s.swapFromToken);
      } else {
        throw new Error('Missing from token');
      }

      let toDecimals = 18;
      if (s.swapToIsNative) {
        toDecimals = 18;
      } else if (s.swapToToken) {
        toDecimals = (await getTokenMeta(chainId, s.swapToToken)).decimals;
      }

      let amount: bigint;
      if (amountSpec.mode === 'raw') {
        amount = amountSpec.amount;
      } else if (amountSpec.mode === 'percent') {
        amount = parsePercentOfBalance(bal, amountSpec.percent);
      } else {
        amount = humanToRaw(amountSpec.fixedHuman, fromDecimals);
        if (amount > bal) amount = bal;
      }
      if (amount <= 0n) throw new Error('Amount is 0 — check balance');

      s.swapAmount = amount;
      s.step = 'swap_confirm';

      const statusMsg = await ctx.reply('⏳ Fetching Uniswap quote…');
      const { previewFlexibleSwap, NATIVE_TOKEN } = await import('../chain/swap.js');
      const preview = await previewFlexibleSwap({
        chainId,
        tokenIn: s.swapFromIsNative
          ? NATIVE_TOKEN
          : (s.swapFromToken as Address),
        tokenOut: s.swapToIsNative
          ? NATIVE_TOKEN
          : (s.swapToToken as Address),
        amountIn: amount,
        fromIsNative: s.swapFromIsNative === true,
        toIsNative: s.swapToIsNative === true,
        fromSymbol: s.swapFromSymbol,
        toSymbol: s.swapToSymbol,
        fromDecimals,
        toDecimals,
      });
      s.swapTokenQuoteText = preview.text;

      const kb = new InlineKeyboard()
        .text('✅ Confirm swap', 'rswap:confirm')
        .text('🔄 Refresh', 'rswap:refresh')
        .row()
        .text('← Pairs', `rswap:chain:${chainId}`)
        .text('❌ Cancel', 'rswap:cancel');

      try {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, preview.text, {
          reply_markup: kb,
        });
      } catch {
        await ctx.reply(preview.text, { reply_markup: kb });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[token swap quote]', msg);
      await ctx.reply(`Quote failed:\n${msg.slice(0, 500)}`);
    }
    return;
  }

  // ── Listed pairs: best of Relay + Across ─────────────────────────────
  const {
    getBridgeAsset,
    getBridgeableBalance,
    resolveBridgeAmount,
  } = await import('../chain/relay.js');
  const {
    previewAggregatedSwap,
    formatAggregatedSwapPreview,
  } = await import('../chain/aggregate.js');

  try {
    const fromAsset = getBridgeAsset(s.swapChainId, s.swapFromSymbol);
    const bal = await getBridgeableBalance(s.swapChainId, fromAsset);
    let amount: bigint;
    if (amountSpec.mode === 'raw') {
      amount = amountSpec.amount;
    } else if (amountSpec.mode === 'percent') {
      amount = resolveBridgeAmount(bal, {
        mode: 'percent',
        percent: amountSpec.percent,
        decimals: fromAsset.decimals,
      });
    } else {
      amount = resolveBridgeAmount(bal, {
        mode: 'fixed',
        fixedHuman: amountSpec.fixedHuman,
        decimals: fromAsset.decimals,
      });
    }

    s.swapAmount = amount;
    s.step = 'swap_confirm';

    const statusMsg = await ctx.reply('⏳ Comparing Relay + Across quotes…');
    const preview = await previewAggregatedSwap({
      chainId: s.swapChainId,
      fromSymbol: s.swapFromSymbol,
      toSymbol: s.swapToSymbol,
      amount,
    });
    s.swapPreview = preview;

    const kb = new InlineKeyboard()
      .text('✅ Confirm swap', 'rswap:confirm')
      .text('🔄 Refresh', 'rswap:refresh')
      .row()
      .text('← Amount', `rswap:pair:${s.swapFromSymbol}:${s.swapToSymbol}`)
      .text('❌ Cancel', 'rswap:cancel');

    const text = formatAggregatedSwapPreview(preview);
    try {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, text, {
        reply_markup: kb,
      });
    } catch {
      await ctx.reply(text, { reply_markup: kb });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[aggregated swap quote]', msg);
    await ctx.reply(`Quote failed:\n${msg.slice(0, 500)}`);
  }
}

async function replyRevokeMenu(ctx: Context): Promise<void> {
  const text =
    `🔒 Revoke approvals\n\n` +
    `Scans unlimited ERC-20 / Permit2 allowances to Uniswap, Permit2, Relay, and Across.\n` +
    `Sets allowance to 0 so a compromised contract can't pull tokens.\n\n` +
    `Pick chains to scan:`;
  const kb = new InlineKeyboard()
    .text('Robinhood', 'revoke:scan:4663')
    .text('BSC', 'revoke:scan:56')
    .text('Base', 'revoke:scan:8453')
    .row()
    .text('All chains', 'revoke:scan:all')
    .row()
    .text('❌ Cancel', 'revoke:cancel');
  await ctx.reply(text, { reply_markup: kb });
}

async function runRevokeScan(ctx: Context, chainIds: SupportedChainId[]): Promise<void> {
  const s = getSession(ctx.from!.id);
  const names = chainIds.map((id) => CHAINS[id].name).join(' + ');
  let statusMsg: { message_id: number } | undefined;
  try {
    statusMsg = await ctx.reply(`⏳ Scanning approvals on ${names}…`);
  } catch {
    /* ignore */
  }

  try {
    const { scanApprovalsMulti, formatApprovalsList } = await import(
      '../chain/revoke.js'
    );
    const list = await scanApprovalsMulti(chainIds);
    s.revokeApprovals = list;
    s.step = 'revoke_list';

    const text = formatApprovalsList(list);
    const kb = new InlineKeyboard();
    if (list.length) {
      // up to 8 individual buttons, then Revoke all
      const maxBtns = Math.min(list.length, 8);
      for (let i = 0; i < maxBtns; i++) {
        const a = list[i]!;
        const label = `${i + 1}. ${a.tokenSymbol}→${a.spenderLabel}`.slice(0, 48);
        kb.text(label, `revoke:one:${i}`);
        if (i % 2 === 1) kb.row();
      }
      if (maxBtns % 2 === 1) kb.row();
      kb.text(`🚫 Revoke all (${list.length})`, 'revoke:all').row();
    }
    kb.text(
      '🔄 Rescan',
      `revoke:scan:${chainIds.length === SUPPORTED_CHAIN_IDS.length ? 'all' : chainIds[0]}`,
    )
      .text('❌ Cancel', 'revoke:cancel');

    if (statusMsg && ctx.chat) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, text, {
          reply_markup: kb,
        });
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(text, { reply_markup: kb });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`Scan failed:\n${msg.slice(0, 500)}`);
  }
}

async function replyRevokeList(
  ctx: Context,
  list: import('../chain/revoke.js').FoundApproval[],
): Promise<void> {
  const { formatApprovalsList } = await import('../chain/revoke.js');
  const text = formatApprovalsList(list);
  const kb = new InlineKeyboard();
  const maxBtns = Math.min(list.length, 8);
  for (let i = 0; i < maxBtns; i++) {
    const a = list[i]!;
    kb.text(
      `${i + 1}. ${a.tokenSymbol}→${a.spenderLabel}`.slice(0, 48),
      `revoke:one:${i}`,
    );
    if (i % 2 === 1) kb.row();
  }
  if (maxBtns % 2 === 1) kb.row();
  if (list.length) kb.text(`🚫 Revoke all (${list.length})`, 'revoke:all').row();
  kb.text('❌ Done', 'revoke:cancel');
  await ctx.reply(text, { reply_markup: kb });
}

async function replyBridgeDirection(ctx: Context, edit = false): Promise<void> {
  const text =
    `🌉 Bridge (best of Relay + Across)\n\n` +
    `Robinhood (USDG · ETH · WETH)\n` +
    `BSC (USDT · BNB · WBNB)\n` +
    `Base (USDC · ETH · WETH)\n\n` +
    `Quotes race both providers — you get the best output.\n` +
    `Pick direction:`;
  const kb = new InlineKeyboard()
    .text('RH → BSC', 'bridge:dir:4663:56')
    .text('BSC → RH', 'bridge:dir:56:4663')
    .row()
    .text('RH → Base', 'bridge:dir:4663:8453')
    .text('Base → RH', 'bridge:dir:8453:4663')
    .row()
    .text('BSC → Base', 'bridge:dir:56:8453')
    .text('Base → BSC', 'bridge:dir:8453:56')
    .row()
    .text('❌ Cancel', 'bridge:cancel');
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { reply_markup: kb });
}

async function replyBridgeFromToken(ctx: Context, s: UserSession): Promise<void> {
  const from = s.bridgeFromChain!;
  const to = s.bridgeToChain!;
  const { BRIDGE_ASSETS, getBridgeableBalance } = await import('../chain/relay.js');
  const { formatUnits } = await import('../chain/tokens.js');

  const lines = [
    `🌉 ${CHAINS[from].name} → ${CHAINS[to].name}`,
    ``,
    `Pick token to send:`,
  ];
  const kb = new InlineKeyboard();
  for (const asset of BRIDGE_ASSETS[from]) {
    let balStr = '?';
    try {
      const bal = await withTimeout(getBridgeableBalance(from, asset), 10_000, asset.symbol);
      balStr = formatUnits(bal, asset.decimals, 6);
    } catch {
      /* ok */
    }
    lines.push(`  ${asset.symbol}: ${balStr}`);
    kb.text(`${asset.symbol}`, `bridge:from:${asset.symbol}`);
  }
  kb.row().text('← Back', 'bridge:back:dir').text('❌ Cancel', 'bridge:cancel');

  try {
    await ctx.editMessageText(lines.join('\n'), { reply_markup: kb });
  } catch {
    await ctx.reply(lines.join('\n'), { reply_markup: kb });
  }
}

async function replyBridgeToToken(ctx: Context, s: UserSession): Promise<void> {
  const from = s.bridgeFromChain!;
  const to = s.bridgeToChain!;
  const { BRIDGE_ASSETS, suggestedDestSymbol } = await import('../chain/relay.js');
  const suggested = suggestedDestSymbol(from, s.bridgeFromSymbol!, to);

  const lines = [
    `🌉 ${CHAINS[from].name} → ${CHAINS[to].name}`,
    `Send: ${s.bridgeFromSymbol}`,
    ``,
    `Receive as (★ suggested same-kind):`,
  ];
  const kb = new InlineKeyboard();
  for (const asset of BRIDGE_ASSETS[to]) {
    const label =
      asset.symbol.toUpperCase() === suggested.toUpperCase()
        ? `★ ${asset.symbol}`
        : asset.symbol;
    kb.text(label, `bridge:to:${asset.symbol}`);
  }
  kb.row()
    .text('← From token', `bridge:dir:${from}:${to}`)
    .text('❌ Cancel', 'bridge:cancel');

  try {
    await ctx.editMessageText(lines.join('\n'), { reply_markup: kb });
  } catch {
    await ctx.reply(lines.join('\n'), { reply_markup: kb });
  }
}

async function replyBridgeAmount(ctx: Context, s: UserSession): Promise<void> {
  const from = s.bridgeFromChain!;
  const to = s.bridgeToChain!;
  const { getBridgeAsset, getBridgeableBalance } = await import('../chain/relay.js');
  const { formatUnits } = await import('../chain/tokens.js');
  const asset = getBridgeAsset(from, s.bridgeFromSymbol!);
  let balStr = '?';
  try {
    const bal = await withTimeout(getBridgeableBalance(from, asset), 10_000, 'bal');
    balStr = formatUnits(bal, asset.decimals, 6);
  } catch {
    /* ok */
  }

  const text =
    `🌉 ${CHAINS[from].name} → ${CHAINS[to].name}\n` +
    `${s.bridgeFromSymbol} → ${s.bridgeToSymbol}\n` +
    `Available: ${balStr} ${s.bridgeFromSymbol}` +
    (asset.isNative ? ' (gas reserved)' : '') +
    `\n\nPick amount:`;

  const kb = new InlineKeyboard()
    .text('25%', 'bridge:amt:25')
    .text('50%', 'bridge:amt:50')
    .text('100%', 'bridge:amt:100')
    .row()
    .text('Custom…', 'bridge:amt:custom')
    .row()
    .text('← To token', `bridge:from:${s.bridgeFromSymbol}`)
    .text('❌ Cancel', 'bridge:cancel');

  try {
    await ctx.editMessageText(text, { reply_markup: kb });
  } catch {
    await ctx.reply(text, { reply_markup: kb });
  }
}

async function runBridgeQuote(
  ctx: Context,
  s: UserSession,
  amountSpec:
    | { mode: 'percent'; percent: number }
    | { mode: 'fixed'; fixedHuman: number }
    | { mode: 'raw'; amount: bigint },
): Promise<void> {
  if (
    s.bridgeFromChain == null ||
    s.bridgeToChain == null ||
    !s.bridgeFromSymbol ||
    !s.bridgeToSymbol
  ) {
    await ctx.reply('Bridge session incomplete — start with /bridge');
    return;
  }

  const {
    getBridgeAsset,
    getBridgeableBalance,
    resolveBridgeAmount,
  } = await import('../chain/relay.js');
  const {
    previewAggregatedBridge,
    formatAggregatedBridgePreview,
  } = await import('../chain/aggregate.js');

  try {
    const fromAsset = getBridgeAsset(s.bridgeFromChain, s.bridgeFromSymbol);
    const bal = await getBridgeableBalance(s.bridgeFromChain, fromAsset);
    let amount: bigint;
    if (amountSpec.mode === 'raw') {
      amount = amountSpec.amount;
    } else if (amountSpec.mode === 'percent') {
      amount = resolveBridgeAmount(bal, {
        mode: 'percent',
        percent: amountSpec.percent,
        decimals: fromAsset.decimals,
      });
    } else {
      amount = resolveBridgeAmount(bal, {
        mode: 'fixed',
        fixedHuman: amountSpec.fixedHuman,
        decimals: fromAsset.decimals,
      });
    }

    s.bridgeAmount = amount;
    s.step = 'bridge_confirm';

    const statusMsg = await ctx.reply('⏳ Comparing Relay + Across quotes…');
    const preview = await previewAggregatedBridge({
      fromChain: s.bridgeFromChain,
      toChain: s.bridgeToChain,
      fromSymbol: s.bridgeFromSymbol,
      toSymbol: s.bridgeToSymbol,
      amount,
    });
    s.bridgePreview = preview;

    const kb = new InlineKeyboard()
      .text('✅ Confirm bridge', 'bridge:confirm')
      .text('🔄 Refresh', 'bridge:refresh')
      .row()
      .text('← Amount', `bridge:to:${s.bridgeToSymbol}`)
      .text('❌ Cancel', 'bridge:cancel');

    const text = formatAggregatedBridgePreview(preview);
    try {
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, text, {
        reply_markup: kb,
      });
    } catch {
      await ctx.reply(text, { reply_markup: kb });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[bridge quote]', msg);
    await ctx.reply(`Quote failed:\n${msg.slice(0, 500)}`);
  }
}

/** Size line with ~USD (fixed uses deposit mode unit: WETH or USDG/USDC). */
async function formatSizeLineWithUsd(
  prefs: ReturnType<typeof getUserPrefs>,
): Promise<string> {
  if (prefs.sizeMode === 'percent') {
    return `${prefs.balancePercent}% of balance`;
  }
  const chainId = prefs.chainId;
  const c = CHAINS[chainId];
  const amt = prefs.fixedAmountHuman;
  const stableName = primaryStableSymbol(chainId);
  const wrappedSym = c.wrappedSymbol;

  try {
    if (prefs.depositMode === 'stable') {
      // Stables ≈ $1
      return `${amt} ${stableName} (fixed) · ~${formatUsd(amt)}`;
    }
    if (prefs.depositMode === 'wrapped') {
      const usd = await valueUsd(chainId, c.wrapped, amt);
      const usdPart = usd > 0 ? ` · ~${formatUsd(usd)}` : '';
      return `${amt} ${wrappedSym} (fixed)${usdPart}`;
    }
    // Auto: show both units so USDG users see stable $ too
    const wUsd = await valueUsd(chainId, c.wrapped, amt);
    const wPart = wUsd > 0 ? `~${formatUsd(wUsd)} as ${wrappedSym}` : wrappedSym;
    return `${amt} fixed · ${wPart} / ~${formatUsd(amt)} as ${stableName}`;
  } catch {
    return formatSizePref(prefs);
  }
}

// ── Multi-wallet UI helpers ────────────────────────────────────────────

async function replyWalletMenu(ctx: Context, edit = false): Promise<void> {
  const wallets = listWallets();
  const activeId = getActiveWalletId();
  const active = getActiveWallet();
  const lines = [
    `👛 Wallets (${wallets.length})`,
    ``,
    ...wallets.map((w) => formatWalletLine(w, activeId)),
    ``,
    `Active: **${active.label}**`,
    `\`${active.address}\``,
    ``,
    `Mint · swap · bridge · close use the ★ active wallet.`,
  ];
  const kb = new InlineKeyboard()
    .text('💰 Balances', 'wal:balances')
    .text('⭐ Select', 'wal:select')
    .row()
    .text('➕ Generate', 'wal:gen')
    .text('📥 Import PK', 'wal:import')
    .row()
    .text('💸 Transfer', 'wal:xfer')
    .text('✏️ Rename', 'wal:rename')
    .row()
    .text('🔑 Reveal PK', 'wal:pk')
    .text('🗑 Delete', 'wal:del')
    .row()
    .text('🔄 Refresh', 'wal:menu');

  const text = lines.join('\n');
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function replyWalletSelect(ctx: Context, edit = false): Promise<void> {
  const wallets = listWallets();
  const activeId = getActiveWalletId();
  const kb = new InlineKeyboard();
  for (const w of wallets) {
    const star = w.id === activeId ? '★ ' : '';
    kb.text(`${star}${w.label.slice(0, 28)}`, `wal:use:${w.id}`).row();
  }
  kb.text('← Menu', 'wal:menu');
  const text = 'Select **active** wallet (used for all trades):';
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function replyActiveBalances(ctx: Context, edit = false): Promise<void> {
  const s = getSession(ctx.from!.id);
  const active = getActiveWallet();
  // Active settings chain first, then the rest
  const chains: SupportedChainId[] = [
    s.chainId,
    ...SUPPORTED_CHAIN_IDS.filter((id) => id !== s.chainId),
  ];
  const lines: string[] = [
    `💰 Balances · **${active.label}**`,
    `\`${active.address}\``,
  ];

  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(`Fetching balances for ${active.label}…`);
    } catch {
      /* ignore */
    }
  } else {
    await ctx.reply(`Fetching balances for ${active.label}…`);
  }

  for (const chainId of chains) {
    lines.push(`\n${CHAINS[chainId].name} (${chainId})`);
    try {
      const native = await withTimeout(getNativeBalance(chainId), 12_000, 'native');
      const nativeHuman = humanToFloat(native, 18);
      let usdStr = '';
      try {
        const usd = await withTimeout(
          valueUsd(chainId, CHAINS[chainId].wrapped, nativeHuman),
          8_000,
          'native price',
        );
        if (usd > 0) usdStr = ` (~${formatUsd(usd)})`;
      } catch {
        /* price optional */
      }
      lines.push(
        `  ${CHAINS[chainId].nativeSymbol} (native): ${formatUnits(native, 18)}${usdStr}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      lines.push(`  ${CHAINS[chainId].nativeSymbol} (native): ${msg}`);
    }
    for (const asset of depositAssets(chainId)) {
      try {
        const bal = await withTimeout(
          getTokenBalance(chainId, asset.address),
          12_000,
          asset.symbol,
        );
        const meta = await withTimeout(
          getTokenMeta(chainId, asset.address),
          12_000,
          `${asset.symbol} meta`,
        );
        const human = humanToFloat(bal, meta.decimals);
        let usdStr = '';
        try {
          const usd = await withTimeout(valueUsd(chainId, asset.address, human), 8_000, 'price');
          if (usd > 0) usdStr = ` (~${formatUsd(usd)})`;
        } catch {
          /* price optional */
        }
        lines.push(`  ${asset.symbol}: ${formatUnits(bal, meta.decimals)}${usdStr}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'error';
        lines.push(`  ${asset.symbol}: ${msg}`);
      }
    }
  }

  const kb = new InlineKeyboard()
    .text('🔄 Refresh', 'wal:balances')
    .text('← Menu', 'wal:menu');
  const text = lines.join('\n');
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function replyTransferConfirm(
  ctx: Context,
  s: UserSession,
  edit: boolean,
): Promise<void> {
  if (
    !s.transferFromId ||
    !s.transferToId ||
    !s.transferChainId ||
    !s.transferAsset ||
    !s.transferAmount
  ) {
    await ctx.reply('Transfer session incomplete. Start with /wallet → Transfer.');
    return;
  }
  const from = getWalletById(s.transferFromId);
  const to = getWalletById(s.transferToId);
  if (!from || !to) {
    await ctx.reply('Wallet not found. Start with /wallet.');
    return;
  }
  let decimals = 18;
  let symbol = s.transferSymbol ?? CHAINS[s.transferChainId].nativeSymbol;
  if (s.transferAsset !== 'native') {
    try {
      const meta = await getTokenMeta(s.transferChainId, s.transferAsset);
      decimals = meta.decimals;
      symbol = meta.symbol;
    } catch {
      /* keep defaults */
    }
  }
  const text =
    `Confirm transfer\n\n` +
    `Amount: **${formatUnits(s.transferAmount, decimals)} ${symbol}**\n` +
    `Chain: ${CHAINS[s.transferChainId].name}\n` +
    `From: ${from.label} (\`${shortAddress(from.address)}\`)\n` +
    `To: ${to.label} (\`${shortAddress(to.address)}\`)\n\n` +
    `Gas paid by source wallet.`;
  const kb = new InlineKeyboard()
    .text('✅ Send', 'wal:xfer:confirm')
    .text('❌ Cancel', 'wal:xfer:cancel');
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function replySettings(ctx: Context, edit = false): Promise<void> {
  const prefs = getUserPrefs(ctx.from!.id);
  syncSessionFromPrefs(ctx.from!.id);

  const depLabel =
    prefs.depositMode === 'wrapped'
      ? CHAINS[prefs.chainId].wrappedSymbol
      : prefs.depositMode === 'stable'
        ? primaryStableSymbol(prefs.chainId)
        : 'Auto';

  const native = CHAINS[prefs.chainId].nativeSymbol;
  const stableName = primaryStableSymbol(prefs.chainId);
  const closeLabel =
    prefs.closeSwapTarget === 'off'
      ? 'OFF'
      : prefs.closeSwapTarget === 'eth'
        ? `→${native} (meme+stable)`
        : `→${stableName} (meme)`;
  const sizeLine = await formatSizeLineWithUsd(prefs);
  const text =
    `⚙️ Settings (all inline · saved)\n\n` +
    `Chain: ${CHAINS[prefs.chainId].name} (${prefs.chainId})\n` +
    `Range width: ${prefs.widthPercent}%\n` +
    `Size: ${sizeLine}\n` +
    `  (% of balance OR fixed deposit-token amount)\n` +
    `  e.g. 0.1 WETH · ~$X  or  50 USDG/USDT/USDC · ~$50\n` +
    `  Custom: tap Custom width / Custom% / Custom fix, then type a number\n` +
    `Deposit: ${depLabel}\n` +
    `Min pool TVL: ${prefs.minTvlUsd === 0 ? 'all' : `$${prefs.minTvlUsd.toLocaleString()}`}\n` +
    `Close auto-swap (GMGN): ${closeLabel}\n` +
    `Close confirm: ${prefs.closeConfirm ? 'ON (ask first)' : 'OFF (instant)'}\n` +
    `Mint ${native}→${stableName}: ${prefs.autoSwapEthToStable ? 'ON' : 'OFF'}\n` +
    `Screener: ${prefs.screenerInterval} · vol≥$${prefs.screenerMinVolumeUsd.toLocaleString()} · KOL≥${prefs.screenerMinKol} · fees≥${prefs.screenerMinTotalFee} · mc $${prefs.screenerMinMcapUsd.toLocaleString()}–${prefs.screenerMaxMcapUsd > 0 ? '$' + prefs.screenerMaxMcapUsd.toLocaleString() : '∞'}\n` +
    `5m alerts: ${prefs.alertEnabled ? 'ON' : 'OFF'} · vol≥$${prefs.alertMinVolumeUsd.toLocaleString()} · KOL≥${prefs.alertMinKol} · fees≥${prefs.alertMinTotalFee} · mc $${prefs.alertMinMcapUsd.toLocaleString()}–${prefs.alertMaxMcapUsd > 0 ? '$' + prefs.alertMaxMcapUsd.toLocaleString() : '∞'} (60s)\n` +
    `TP/SL watcher: ${prefs.tpSlEnabled ? 'ON' : 'OFF'} (experimental)\n` +
    `  defaults: TP +${prefs.tpPercent}% · SL -${prefs.slPercent}%\n` +
    `  enroll: /tp #id  ·  /tp #id 10 15  ·  /tp list\n\n` +
    `Tap to change · paste a CA or /screener · /alerts`;

  const pctPresets = [10, 25, 50, 100] as const;
  const widthPresets = [20, 30, 50] as const;
  const isCustomWidth = !widthPresets.includes(prefs.widthPercent as (typeof widthPresets)[number]);
  const isCustomPct =
    prefs.sizeMode === 'percent' && !pctPresets.includes(prefs.balancePercent as (typeof pctPresets)[number]);
  const isCustomFix =
    prefs.sizeMode === 'fixed' &&
    !(FIXED_AMOUNT_PRESETS as readonly number[]).includes(prefs.fixedAmountHuman);
  const isCustomMinTvl = !(MIN_TVL_PRESETS as readonly number[]).includes(prefs.minTvlUsd);
  const customWidthLabel = isCustomWidth ? `Custom ${prefs.widthPercent}%` : 'Custom width';
  const customPctLabel = isCustomPct ? `Custom ${prefs.balancePercent}%` : 'Custom %';
  const customFixLabel = isCustomFix ? `Custom ${prefs.fixedAmountHuman}` : 'Custom fix';
  const customMinTvlLabel = isCustomMinTvl
    ? `TVL $${prefs.minTvlUsd.toLocaleString()}`
    : 'Custom TVL';

  const kb = new InlineKeyboard()
    // Chain
    .text(mark(prefs.chainId === 4663, 'Robinhood'), 'set:chain:4663')
    .text(mark(prefs.chainId === 56, 'BSC'), 'set:chain:56')
    .text(mark(prefs.chainId === 8453, 'Base'), 'set:chain:8453')
    .row()
    // Range width
    .text(mark(prefs.widthPercent === 20, 'Width 20%'), 'set:width:20')
    .text(mark(prefs.widthPercent === 30, 'Width 30%'), 'set:width:30')
    .text(mark(prefs.widthPercent === 50, 'Width 50%'), 'set:width:50')
    .row()
    .text(mark(isCustomWidth, customWidthLabel), 'set:width:custom')
    .row()
    // Amount %
    .text(
      mark(prefs.sizeMode === 'percent' && prefs.balancePercent === 10, 'Amt 10%'),
      'set:amt:10',
    )
    .text(
      mark(prefs.sizeMode === 'percent' && prefs.balancePercent === 25, 'Amt 25%'),
      'set:amt:25',
    )
    .text(
      mark(prefs.sizeMode === 'percent' && prefs.balancePercent === 50, 'Amt 50%'),
      'set:amt:50',
    )
    .text(
      mark(prefs.sizeMode === 'percent' && prefs.balancePercent === 100, 'Amt 100%'),
      'set:amt:100',
    )
    .row()
    .text(mark(isCustomPct, customPctLabel), 'set:amt:custom')
    .row()
    // Fixed amounts (deposit token units)
    .text(
      mark(prefs.sizeMode === 'fixed' && prefs.fixedAmountHuman === 0.05, 'Fix 0.05'),
      'set:fix:0.05',
    )
    .text(
      mark(prefs.sizeMode === 'fixed' && prefs.fixedAmountHuman === 0.1, 'Fix 0.1'),
      'set:fix:0.1',
    )
    .text(
      mark(prefs.sizeMode === 'fixed' && prefs.fixedAmountHuman === 0.25, 'Fix 0.25'),
      'set:fix:0.25',
    )
    .text(
      mark(prefs.sizeMode === 'fixed' && prefs.fixedAmountHuman === 0.5, 'Fix 0.5'),
      'set:fix:0.5',
    )
    .row()
    .text(mark(isCustomFix, customFixLabel), 'set:fix:custom')
    .row()
    // Deposit mode
    .text(mark(prefs.depositMode === 'auto', 'Dep Auto'), 'set:dep:auto')
    .text(
      mark(prefs.depositMode === 'wrapped', CHAINS[prefs.chainId].wrappedSymbol),
      'set:dep:wrapped',
    )
    .text(mark(prefs.depositMode === 'stable', 'Stable'), 'set:dep:stable')
    .row()
    // Min pool TVL filter
    .text(mark(prefs.minTvlUsd === 0, 'TVL all'), 'set:mintvl:0')
    .text(mark(prefs.minTvlUsd === 500, 'TVL $500'), 'set:mintvl:500')
    .text(mark(prefs.minTvlUsd === 2_000, 'TVL $2k'), 'set:mintvl:2000')
    .row()
    .text(mark(prefs.minTvlUsd === 5_000, 'TVL $5k'), 'set:mintvl:5000')
    .text(mark(prefs.minTvlUsd === 10_000, 'TVL $10k'), 'set:mintvl:10000')
    .text(mark(isCustomMinTvl, customMinTvlLabel), 'set:mintvl:custom')
    .row()
    // Close auto-swap: off | eth | usdg
    .text(mark(prefs.closeSwapTarget === 'off', 'Close OFF'), 'set:close:off')
    .text(mark(prefs.closeSwapTarget === 'eth', `Close→${native}`), 'set:close:eth')
    .text(mark(prefs.closeSwapTarget === 'usdg', `Close→${stableName}`), 'set:close:usdg')
    .row()
    // Close confirmation (anti fat-finger)
    .text(mark(prefs.closeConfirm, 'Confirm close'), 'set:closeconfirm:on')
    .text(mark(!prefs.closeConfirm, 'Instant close'), 'set:closeconfirm:off')
    .row()
    // Mint ETH→stable
    .text(
      mark(prefs.autoSwapEthToStable, `Mint→${stableName}`),
      `set:autoswap:stable:${prefs.autoSwapEthToStable ? 'off' : 'on'}`,
    )
    .row()
    // Experimental TP/SL
    .text(
      mark(prefs.tpSlEnabled, 'TP/SL ON'),
      `set:tpsl:${prefs.tpSlEnabled ? 'off' : 'on'}`,
    )
    .text(`TP +${prefs.tpPercent}%`, 'set:tpsl:tp')
    .text(`SL -${prefs.slPercent}%`, 'set:tpsl:sl')
    .row()
    .text('📡 Screener', 'scr:run')
    .text('⚙️ Scr filters', 'scr:filters')
    .row()
    .text('🔑 Reveal active PK', 'set:pk')
    .text('👛 Wallets', 'wal:menu')
    .row()
    .text('🔄 Refresh', 'set:refresh')
    .text('✅ Done', 'set:done');

  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
      return;
    } catch {
      /* fall through if message unchanged */
    }
  }
  await ctx.reply(text, { reply_markup: kb });
}

async function handleList(ctx: Context, edit = false): Promise<void> {
  const s = syncSessionFromPrefs(ctx.from!.id);
  const loading = `Loading positions on ${CHAINS[s.chainId].name}…`;

  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(loading);
    } catch {
      /* ignore */
    }
  } else {
    await ctx.reply(loading);
  }

  try {
    const positions = await listPositionsFast(s.chainId);
    if (!positions.length) {
      const empty =
        `No open v3/v4 positions on ${CHAINS[s.chainId].name}.\n` +
        `Paste a CA to mint.`;
      const kbEmpty = new InlineKeyboard().text('🔄 Refresh', 'list:refresh');
      if (edit && ctx.callbackQuery) {
        try {
          await ctx.editMessageText(empty, { reply_markup: kbEmpty });
          return;
        } catch {
          /* fall through */
        }
      }
      await ctx.reply(empty, { reply_markup: kbEmpty });
      return;
    }
    // Format all lines in parallel (price cache is warm after listPositions)
    const chunks = await Promise.all(positions.map((p) => formatPositionLine(p)));
    let live = 0;
    let unclaimed = 0;
    for (const p of positions) {
      live += p.valueUsd;
      unclaimed += p.unclaimedFeesUsd;
    }
    const header = await portfolioSummary(s.chainId, live, unclaimed);
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const headerPrefix = `${header}\nupdated ${ts}\n\n`;
    const MAX_MSG = 4000; // Telegram limit is 4096
    let msg = headerPrefix;
    let shown = 0;
    for (const c of chunks) {
      const candidate = msg + (shown > 0 ? '\n\n' : '') + c;
      if (candidate.length > MAX_MSG) break;
      msg = candidate;
      shown++;
    }
    if (shown < chunks.length) {
      msg += `\n\n(showing ${shown} of ${chunks.length} positions)`;
    }

    const kb = new InlineKeyboard();
    kb.text('🔄 Refresh', 'list:refresh').row();
    for (const p of positions.slice(0, 15)) {
      const name =
        !['WETH', 'WBNB', 'USDC', 'USDG', 'USDT'].includes(p.symbol0.toUpperCase())
          ? p.symbol0
          : !['WETH', 'WBNB', 'USDC', 'USDG', 'USDT'].includes(p.symbol1.toUpperCase())
            ? p.symbol1
            : `#${p.tokenId}`;
      const ver = p.protocol === 'v4' ? 'v4' : 'v3';
      const dCode = dexCode(p.dex);
      const venue =
        p.protocol === 'v4' ? 'v4' : p.dex === 'pancakeswap' ? 'PCS' : 'UNI';
      const hasFees = p.unclaimedFeesUsd > 0.0001 || p.tokensOwed0 > 0n || p.tokensOwed1 > 0n;
      if (hasFees) {
        kb.text(`💰 Claim ${name} #${p.tokenId}`, `claim:${ver}:${dCode}:${p.tokenId}`);
      }
      kb.text(
        `🗑 Close ${name} #${p.tokenId} [${venue}]`,
        `close:${ver}:${dCode}:${p.tokenId}`,
      ).row();
    }

    const opts = {
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    };

    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(msg, opts);
        return;
      } catch (e) {
        // Telegram errors if content identical — still ok
        const m = e instanceof Error ? e.message : String(e);
        if (/message is not modified/i.test(m)) return;
        /* fall through to reply */
      }
    }
    await ctx.reply(msg, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (edit && ctx.callbackQuery) {
      try {
        await ctx.editMessageText(`List failed: ${msg}`);
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.reply(`List failed: ${msg}`);
  }
}

async function handleTokens(ctx: Context): Promise<void> {
  const s = syncSessionFromPrefs(ctx.from!.id);
  await ctx.reply(
    `Scanning non-${CHAINS[s.chainId].nativeSymbol}/WETH/stable tokens on ${CHAINS[s.chainId].name}…`,
  );
  try {
    const { listNonCoreTokens, formatTokenLine } = await import('../chain/tokenBalances.js');
    const tokens = await listNonCoreTokens(s.chainId);
    if (!tokens.length) {
      await ctx.reply(
        `No extra ERC-20 balances found (or RPC can't enumerate tokens).\n` +
          `Alchemy RPC is required for discovery. Core: native/WETH/stables hidden.`,
      );
      return;
    }
    s.walletTokens = tokens.map((t) => ({ address: t.address, symbol: t.symbol }));
    const lines = tokens.map((t, i) => formatTokenLine(t, i));
    let msg = `Tokens (${CHAINS[s.chainId].name}) — tap Swap → ${CHAINS[s.chainId].nativeSymbol}\n\n` + lines.join('\n\n');
    if (msg.length > 3500) msg = msg.slice(0, 3490) + '\n…';

    const kb = new InlineKeyboard();
    for (let i = 0; i < Math.min(tokens.length, 20); i++) {
      const t = tokens[i]!;
      // Address in callback — survives restarts; no "stale list" from index
      kb.text(`🔄 Swap ${t.symbol}`, `swap:${t.address}`).row();
    }
    await ctx.reply(msg, { reply_markup: kb, link_preview_options: { is_disabled: true } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`Tokens failed: ${msg}`);
  }
}

async function handlePnl(ctx: Context): Promise<void> {
  const s = syncSessionFromPrefs(ctx.from!.id);
  try {
    let live = 0;
    let unclaimed = 0;
    const positions = await listPositionsFast(s.chainId);
    // format once to correct valueUsd via price fix path
    for (const p of positions) {
      await formatPositionLine(p);
      live += p.valueUsd;
      unclaimed += p.unclaimedFeesUsd;
    }
    // Aggregate known gas cost across positions — best-effort, never
    // fabricated: a position with no matchable telemetry contributes
    // "unknown" rather than 0, and the portfolio total is marked partial.
    let gasTotalUsd = 0;
    let anyGasKnown = false;
    let allGasComplete = true;
    for (const p of positions) {
      const pnl = await computePositionPnl(s.chainId, p.tokenId, p);
      if (pnl.gasCostUsd != null) {
        gasTotalUsd += pnl.gasCostUsd;
        anyGasKnown = true;
      }
      if (!pnl.gasCostComplete) allGasComplete = false;
    }
    await ctx.reply(
      await portfolioSummary(
        s.chainId,
        live,
        unclaimed,
        anyGasKnown ? gasTotalUsd : null,
        allGasComplete,
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`PnL failed: ${msg}`);
  }
}

/**
 * /tp list
 * /tp #id
 * /tp #id 10 15
 * /tp #id off
 */
async function handleTp(ctx: Context): Promise<void> {
  const s = syncSessionFromPrefs(ctx.from!.id);
  const prefs = getUserPrefs(ctx.from!.id);
  const raw =
    (typeof ctx.match === 'string' ? ctx.match : '') ||
    (ctx.message && 'text' in ctx.message ? ctx.message.text : '') ||
    '';
  const args = raw
    .replace(/^\/tp(?:@\w+)?\s*/i, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!args.length || args[0] === 'help') {
    await ctx.reply(
      `Experimental TP/SL\n\n` +
        `1. /settings → turn **TP/SL ON** · set default TP% / SL%\n` +
        `2. \`/tp #id\` — enroll position (uses defaults TP +${prefs.tpPercent}% / SL -${prefs.slPercent}%)\n` +
        `3. \`/tp #id 10 15\` — enroll with custom TP +10% / SL -15%\n` +
        `4. \`/tp #id off\` — unenroll\n` +
        `5. \`/tp list\` — enrolled positions\n\n` +
        `Watcher: every 30s · on trigger waits 5s · if PnL still past level → auto-close.\n` +
        `Global watcher: ${prefs.tpSlEnabled ? 'ON' : 'OFF'}`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  if (args[0]!.toLowerCase() === 'list') {
    const enrolled = listTpSlEnrolledPositions();
    if (!enrolled.length) {
      await ctx.reply('No positions enrolled. Use `/tp #id` after mint.', {
        parse_mode: 'Markdown',
      });
      return;
    }
    const lines = enrolled.map((p) => {
      const tp = p.tpPercent ?? prefs.tpPercent;
      const sl = p.slPercent ?? prefs.slPercent;
      return (
        `#${p.tokenId} [${p.protocol}] ${p.label ?? ''} · chain ${p.chainId}\n` +
        `  TP +${tp}% · SL -${sl}%`
      );
    });
    await ctx.reply(
      `Enrolled TP/SL (${enrolled.length})\nWatcher global: ${prefs.tpSlEnabled ? 'ON' : 'OFF'}\n\n` +
        lines.join('\n\n'),
    );
    return;
  }

  const idMatch = args[0]!.match(/^#?(\d+)$/);
  if (!idMatch) {
    await ctx.reply('Usage: `/tp #id` · `/tp #id 10 15` · `/tp #id off` · `/tp list`', {
      parse_mode: 'Markdown',
    });
    return;
  }
  const tokenId = idMatch[1]!;

  if (args[1]?.toLowerCase() === 'off') {
    const row = setPositionTpSl(s.chainId, tokenId, { enabled: false });
    if (!row) {
      await ctx.reply(
        `Position #${tokenId} not in ledger on ${CHAINS[s.chainId].name}. Mint via bot first or check chain.`,
      );
      return;
    }
    await ctx.reply(`TP/SL **off** for #${tokenId}.`, { parse_mode: 'Markdown' });
    return;
  }

  let tpPct: number | null | undefined = undefined;
  let slPct: number | null | undefined = undefined;
  if (args[1] != null && args[2] != null) {
    const tp = Number(args[1].replace(/%/g, ''));
    const sl = Number(args[2].replace(/%/g, '').replace(/^-/, ''));
    if (!Number.isFinite(tp) || tp <= 0 || tp > 500 || !Number.isFinite(sl) || sl <= 0 || sl > 500) {
      await ctx.reply('TP and SL must be numbers 0–500 (e.g. `/tp #123 10 15`).', {
        parse_mode: 'Markdown',
      });
      return;
    }
    tpPct = Math.round(tp * 100) / 100;
    slPct = Math.round(sl * 100) / 100;
  } else if (args[1] != null && args[2] == null) {
    await ctx.reply('Provide both TP and SL, e.g. `/tp #123 10 15`, or just `/tp #123`.', {
      parse_mode: 'Markdown',
    });
    return;
  }

  // Prefer tracked position on current chain; else any
  const tracked =
    getTrackedPosition(tokenId, s.chainId) ?? getTrackedPosition(tokenId);
  if (!tracked) {
    await ctx.reply(
      `No tracked position #${tokenId}.\nMint through the bot so it is in the ledger, then /tp again.`,
    );
    return;
  }
  if (tracked.status !== 'open') {
    await ctx.reply(`#${tokenId} is marked closed in the ledger — reopen/mint first.`);
    return;
  }

  const row = setPositionTpSl(tracked.chainId as SupportedChainId, tokenId, {
    enabled: true,
    tpPercent: tpPct === undefined ? null : tpPct,
    slPercent: slPct === undefined ? null : slPct,
  });
  if (!row) {
    await ctx.reply(`Failed to enroll #${tokenId}.`);
    return;
  }

  const tp = row.tpPercent ?? prefs.tpPercent;
  const sl = row.slPercent ?? prefs.slPercent;
  const warn = prefs.tpSlEnabled
    ? ''
    : `\n\n⚠️ Global watcher is **OFF** — turn on **TP/SL** in /settings or nothing will fire.`;

  await ctx.reply(
    `🎯 TP/SL enrolled for **${row.label ?? 'LP'} #${tokenId}** [${row.protocol}]\n` +
      `TP +${tp}% · SL -${sl}%\n` +
      `Poll 30s · confirm 5s before close.${warn}`,
    { parse_mode: 'Markdown' },
  );
}

/** /generate #75386 — shareable PnL card image from ledger (+ live mark if open). */
async function handleGenerate(ctx: Context): Promise<void> {
  const s = syncSessionFromPrefs(ctx.from!.id);
  const raw =
    (typeof ctx.match === 'string' ? ctx.match : '') ||
    (ctx.message && 'text' in ctx.message ? ctx.message.text : '') ||
    '';
  const m = raw.match(/#?(\d{1,20})/);
  if (!m) {
    await ctx.reply(
      'Usage: `/generate #75386`\n' +
        'Position id from /history or /list.',
      { parse_mode: 'Markdown' },
    );
    return;
  }
  const tokenId = m[1]!;
  const pos = getTrackedPosition(tokenId, s.chainId) ?? getTrackedPosition(tokenId);
  if (!pos) {
    await ctx.reply(
      `No tracked position \`#${tokenId}\` in the ledger.\n` +
        `Mint/close through the bot first, or check /history.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const statusMsg = await ctx.reply(`Generating card for #${tokenId}…`);
  try {
    let live: { valueUsd: number; unclaimedFeesUsd: number } | null = null;
    if (pos.status === 'open') {
      try {
        const chainId = pos.chainId as SupportedChainId;
        const opens = await listPositionsFast(chainId);
        const hit = opens.find((p) => p.tokenId.toString() === pos.tokenId);
        if (hit) {
          await formatPositionLine(hit);
          live = { valueUsd: hit.valueUsd, unclaimedFeesUsd: hit.unclaimedFeesUsd };
        }
      } catch (e) {
        console.warn('[generate] live mark failed', e);
      }

      // Fallback: direct position query when listPositions misses it (e.g. v4)
      if (!live) {
        // getPosition/getV4Position now distinguish "confirmed gone" (clean
        // null return) from "ownership/state unknown" (throws on RPC
        // failure) — only the former is safe to treat as closed below.
        let confirmedGone = false;
        try {
          const chainId = pos.chainId as SupportedChainId;
          if (pos.protocol === 'v4') {
            const { getV4Position } = await import('../chain/v4.js');
            const p = await getV4Position(chainId, BigInt(pos.tokenId));
            if (p) {
              await formatPositionLine(p);
              live = { valueUsd: p.valueUsd, unclaimedFeesUsd: p.unclaimedFeesUsd };
            } else {
              confirmedGone = true;
            }
          } else {
            const { getPosition } = await import('../chain/positions.js');
            const p = await getPosition(chainId, BigInt(pos.tokenId));
            if (p) {
              await formatPositionLine(p);
              live = { valueUsd: p.valueUsd, unclaimedFeesUsd: p.unclaimedFeesUsd };
            } else {
              confirmedGone = true;
            }
          }
        } catch (e) {
          console.warn('[generate] direct position fallback failed (state unknown)', e);
        }

        // Only auto-close in the ledger when both lookups CONFIRMED the
        // position is gone. A read failure (RPC/rate-limit) leaves state
        // unknown — never treat that as "closed" (would silently drop TP/SL).
        if (!live && confirmedGone) {
          console.warn(`[generate] #${tokenId} not found on-chain, auto-marking closed`);
          markClosed(pos.chainId as SupportedChainId, pos.tokenId);
          pos.status = 'closed';
        } else if (!live) {
          console.warn(`[generate] #${tokenId} state unknown — leaving ledger status as-is`);
        }
      }
    }

    const pnl = await computePositionPnl(
      pos.chainId as SupportedChainId,
      pos.tokenId,
      live ??
        (pos.status === 'closed'
          ? { valueUsd: 0, unclaimedFeesUsd: 0 }
          : null),
    );

    const png = await renderPnlCard({ pos, pnl });
    const caption =
      `${pos.label ?? 'LP'} #${pos.tokenId} · ${pos.protocol.toUpperCase()}\n` +
      `${pnl.pnlUsd >= 0 ? '+' : ''}${formatUsd(pnl.pnlUsd)}` +
      (pnl.pnlPct != null
        ? ` (${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct.toFixed(2)}%)`
        : '');

    await ctx.replyWithPhoto(new InputFile(png, `pnl-${tokenId}.png`), {
      caption,
    });
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      /* ignore */
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[generate]', msg);
    try {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        `Card failed:\n${msg.slice(0, 400)}`,
      );
    } catch {
      await ctx.reply(`Card failed:\n${msg.slice(0, 400)}`);
    }
  }
}

/** Closed + open per-position PnL from local ledger DB (compact, max 20). */
async function handleHistory(ctx: Context): Promise<void> {
  const s = syncSessionFromPrefs(ctx.from!.id);
  try {
    // Best-effort live marks for open rows
    const liveByTokenId = new Map<
      string,
      { valueUsd: number; unclaimedFeesUsd: number }
    >();
    try {
      const live = await listPositionsFast(s.chainId);
      for (const p of live) {
        await formatPositionLine(p);
        liveByTokenId.set(p.tokenId.toString(), {
          valueUsd: p.valueUsd,
          unclaimedFeesUsd: p.unclaimedFeesUsd,
        });
      }
    } catch (e) {
      console.warn('[history] live positions unavailable', e);
    }

    // Fallback: direct query for v4 positions missed by listPositions
    const trackedOpen = listTrackedPositions(s.chainId, 'open');
    for (const t of trackedOpen) {
      if (liveByTokenId.has(t.tokenId)) continue;
      try {
        if (t.protocol === 'v4') {
          const { getV4Position } = await import('../chain/v4.js');
          const p = await getV4Position(s.chainId, BigInt(t.tokenId));
          if (p) {
            await formatPositionLine(p);
            liveByTokenId.set(t.tokenId, {
              valueUsd: p.valueUsd,
              unclaimedFeesUsd: p.unclaimedFeesUsd,
            });
          }
        } else {
          const { getPosition } = await import('../chain/positions.js');
          const p = await getPosition(s.chainId, BigInt(t.tokenId));
          if (p) {
            await formatPositionLine(p);
            liveByTokenId.set(t.tokenId, {
              valueUsd: p.valueUsd,
              unclaimedFeesUsd: p.unclaimedFeesUsd,
            });
          }
        }
      } catch {
        /* skip */
      }
    }

    const msg = await buildPositionHistory({
      chainId: s.chainId,
      liveByTokenId,
      limit: 20,
    });
    await ctx.reply(msg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`History failed: ${msg}`);
  }
}

async function handleCloseMenu(ctx: Context): Promise<void> {
  const s = syncSessionFromPrefs(ctx.from!.id);
  try {
    const positions = await listPositionsFast(s.chainId);
    if (!positions.length) {
      await ctx.reply('No open positions to close.');
      return;
    }
    s.step = 'pick_close';
    s.closeTokenIds = positions.map((p) => p.tokenId.toString());
    const kb = new InlineKeyboard();
    for (const p of positions.slice(0, 20)) {
      const ver = p.protocol === 'v4' ? 'v4' : 'v3';
      const dCode = dexCode(p.dex);
      const venue =
        p.protocol === 'v4' ? 'v4' : p.dex === 'pancakeswap' ? 'PCS' : 'UNI';
      kb.text(
        `#${p.tokenId} [${venue}] ${p.symbol0}/${p.symbol1} $${p.valueUsd.toFixed(0)}`,
        `close:${ver}:${dCode}:${p.tokenId}`,
      ).row();
    }
    await ctx.reply('Select position to fully close:', { reply_markup: kb });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`Close menu failed: ${msg}`);
  }
}

/** Parse "all" | human number → raw wei, capped at maxAvailable. */
function parseWrapArg(arg: string, maxAvailable: bigint): bigint | null {
  const t = arg.trim().toLowerCase();
  if (t === 'all' || t === 'max' || t === '100%') return maxAvailable;
  const n = Number(t.replace(/,/g, '.').replace(/[^\d.eE+-]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const raw = humanToRaw(n, 18);
  return raw > maxAvailable ? maxAvailable : raw;
}

async function executeWrap(
  ctx: Context,
  chainId: SupportedChainId,
  amount: bigint,
  editProgress = false,
): Promise<void> {
  const c = CHAINS[chainId];
  const msg =
    `⏳ Wrapping ${formatUnits(amount, 18)} ${c.nativeSymbol} → ${c.wrappedSymbol}…`;
  if (editProgress) {
    try {
      await ctx.editMessageText(msg);
    } catch {
      await ctx.reply(msg);
    }
  } else {
    await ctx.reply(msg);
  }
  const r = await wrapNative(chainId, amount);
  clearWrapSession(getSession(ctx.from!.id));
  await ctx.reply(
    `✅ Wrapped ${formatUnits(r.amount, 18)} ${c.nativeSymbol} → ${c.wrappedSymbol}\n` +
      `tx: ${txUrl(chainId, r.hash)}`,
    { link_preview_options: { is_disabled: true } },
  );
}

async function executeUnwrap(
  ctx: Context,
  chainId: SupportedChainId,
  amount: bigint,
  editProgress = false,
): Promise<void> {
  const c = CHAINS[chainId];
  const msg =
    `⏳ Unwrapping ${formatUnits(amount, 18)} ${c.wrappedSymbol} → ${c.nativeSymbol}…`;
  if (editProgress) {
    try {
      await ctx.editMessageText(msg);
    } catch {
      await ctx.reply(msg);
    }
  } else {
    await ctx.reply(msg);
  }
  const r = await unwrapNative(chainId, amount);
  clearWrapSession(getSession(ctx.from!.id));
  await ctx.reply(
    `✅ Unwrapped ${formatUnits(r.amount, 18)} ${c.wrappedSymbol} → ${c.nativeSymbol}\n` +
      `tx: ${txUrl(chainId, r.hash)}`,
    { link_preview_options: { is_disabled: true } },
  );
}

// ── MULTI strategy report + execute ─────────────────────────────────────────

function formatMultiCandidateLine(intent: TradeIntent, candidate?: MultiCandidate): string {
  const label = candidate ? candidate.symbol : intent.token.slice(0, 10);
  const mc = candidate?.marketCapUsd != null ? formatUsd(candidate.marketCapUsd) : 'UNKNOWN';
  const age = candidate?.ageHours != null ? `${candidate.ageHours.toFixed(1)}h` : 'UNKNOWN';
  const vol = candidate?.volume6hUsd != null ? formatUsd(candidate.volume6hUsd) : 'UNKNOWN';
  return (
    `• ${label} — MC ${mc} · age ${age} · vol6h ${vol}\n` +
    `  pool ${String(intent.pool.poolAddress).slice(0, 10)}… fee=${intent.fee}bps · candScore=${intent.candidateScore.toFixed(3)} poolScore=${intent.poolScore.toFixed(3)}\n` +
    `  ${intent.reason}`
  );
}

function formatMultiRejectedLine(r: RejectedCandidate): string {
  const mc = r.marketCapUsd != null ? formatUsd(r.marketCapUsd) : 'UNKNOWN';
  return `• ${r.symbol || r.address.slice(0, 10)} — ${r.rejectedReason} (MC ${mc})`;
}

function formatMultiReport(run: MultiStrategyRun, config: MultiConfig): string {
  const header =
    `📊 MULTI CANDIDATES — ${run.dryRun ? 'DRY RUN (no tx)' : 'LIVE'}\n` +
    `chain=${CHAINS[run.chainId].name} · interval=6h · minMC=$${config.minMarketCapUsd.toLocaleString()} · ` +
    `minAge=${config.minTokenAgeHours}h · topN=${config.topN} · usdg=${config.usdgAddress}`;

  // A candidate-source failure (gmgn-cli not found/timed out/exec failed) is
  // never allowed to look identical to "0 candidates today" — surfaced
  // distinctly so an operator can tell a broken integration from a quiet
  // market.
  if (run.sourceError) {
    return (
      `${header}\n\n` +
      `⚠️ CANDIDATE SOURCE FAILED (${run.sourceError.code})\n` +
      `${run.sourceError.message.slice(0, 300)}\n\n` +
      `This is NOT "no candidates today" — the GMGN source itself could not be reached. ` +
      `No filtering/ranking was performed this run.`
    );
  }

  const passedLines = run.intents.length
    ? run.intents
        .map((intent) =>
          formatMultiCandidateLine(
            intent,
            run.candidates.find((c) => c.address.toLowerCase() === intent.token.toLowerCase()),
          ),
        )
        .join('\n')
    : '(none passed all filters + risk gate)';

  const rejectedTop = run.rejected.slice(0, 15);
  const rejectedLines = rejectedTop.length
    ? rejectedTop.map(formatMultiRejectedLine).join('\n')
    : '(none rejected)';
  const rejectedMore =
    run.rejected.length > rejectedTop.length
      ? `\n…and ${run.rejected.length - rejectedTop.length} more rejected`
      : '';

  return (
    `${header}\n\n` +
    `✅ ELIGIBLE (${run.intents.length}):\n${passedLines}\n\n` +
    `❌ REJECTED (${run.rejected.length}):\n${rejectedLines}${rejectedMore}`
  );
}

function multiKeyboard(run: MultiStrategyRun): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const intent of run.intents) {
    const c = run.candidates.find((x) => x.address.toLowerCase() === intent.token.toLowerCase());
    const label = c ? `🚀 Execute ${c.symbol}` : `🚀 Execute ${intent.token.slice(0, 8)}`;
    // Phase 4.7 audit (F-13): every button embeds THIS scan's own scanId —
    // never regenerated per button, per report, or per refresh — so a
    // callback can only ever resolve against the exact run that produced it.
    kb.text(label.slice(0, 60), buildMultiExecuteCallbackData(run.scanId, intent.token)).row();
  }
  kb.text('🔄 Refresh', 'multi:refresh');
  return kb;
}

/** Runs a MULTI dry-run scan, stashes the result on the user's session (for
 * the Execute buttons), and replies/edits with the candidate report. */
async function runMultiDryRunReport(ctx: Context, edit: boolean): Promise<void> {
  const config = loadMultiConfig();
  const validation = validateMultiConfig(config);
  if (!config.enabled || !validation.valid) {
    const text = `⛔ MULTI DISABLED: ${config.disabledReason ?? validation.reason ?? 'invalid config'}`;
    if (edit) {
      try {
        await ctx.editMessageText(text);
        return;
      } catch {
        /* fall through to reply */
      }
    }
    await ctx.reply(text);
    return;
  }

  try {
    const prefs = getUserPrefs(ctx.from!.id);
    const run = await runMultiStrategy(config, { dryRun: true, prefs });
    getSession(ctx.from!.id).multiRun = run;
    const text = formatMultiReport(run, config);
    const kb = multiKeyboard(run);
    if (edit) {
      try {
        await ctx.editMessageText(text, { reply_markup: kb });
        return;
      } catch {
        /* message unchanged or too old to edit — fall through to reply */
      }
    }
    await ctx.reply(text, { reply_markup: kb });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`MULTI scan failed:\n${msg.slice(0, 400)}`);
  }
}

// ── Screener + mint helpers ────────────────────────────────────────────────

function escapeHtmlBot(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Rows per page in the rich-message table (keep message snappy on mobile). */
const SCREENER_PAGE_SIZE = 8;

/**
 * Shared CA → pool picker path used by paste-CA and /screener 🚀 Mint.
 */
async function startMintFromCa(
  ctx: Context,
  s: UserSession,
  ca: Address,
): Promise<void> {
  const prefs = getUserPrefs(ctx.from!.id);
  await ctx.reply(
    `Fetching Uniswap${s.chainId === 56 ? '/PancakeSwap' : ''} v3/v4 pools on ${CHAINS[s.chainId].name}…\n` +
      `(width ${s.widthPercent}% · size ${formatSizePref(s)} · deposit ${s.depositMode}` +
      ` · min TVL $${prefs.minTvlUsd.toLocaleString()})`,
  );
  const pools = await listPoolsForToken(s.chainId, ca, prefs.minTvlUsd);
  s.tokenCa = ca;
  if (!pools.length) {
    const quote = primaryStableAddress(s.chainId) ?? CHAINS[s.chainId].wrapped;
    const kb = new InlineKeyboard()
      .text('🆕 Create v4 pool + mint', 'createv4:preview')
      .row()
      .text('❌ Cancel', 'createv4:cancel');
    s.createV4Meme = ca;
    s.createV4Quote = quote;
    s.step = 'confirm_create_v4';
    await ctx.reply(
      `No Uniswap${s.chainId === 56 ? '/PancakeSwap' : ''} pools with TVL ≥ $${prefs.minTvlUsd.toLocaleString()} ` +
        `on ${CHAINS[s.chainId].name}.\n\n` +
        `You can <b>create a Uniswap v4 pool</b> (1% fee) initialized <b>1% below</b> DexScreener market, ` +
        `then mint single-sided LP with your deposit settings.`,
      { reply_markup: kb, parse_mode: 'HTML' },
    );
    return;
  }
  s.pools = pools.slice(0, 20);
  s.selectedPool = undefined;
  s.depositToken = undefined;
  s.depositSymbol = undefined;
  s.depositUserPicked = false;
  s.createV4Meme = undefined;
  s.step = 'pick_pool';
  const kb = new InlineKeyboard();
  s.pools.forEach((p, i) => {
    const tvl =
      p.tvlUsd >= 1000 ? `$${(p.tvlUsd / 1000).toFixed(1)}k` : `$${p.tvlUsd.toFixed(0)}`;
    const ver =
      p.protocol === 'v4' ? 'v4' : p.dex === 'pancakeswap' ? 'PCS' : 'UNI';
    kb.text(
      `${i + 1}. [${ver}] ${p.otherSymbol} ${((p.fee ?? 0) / 10000).toFixed(2)}% · ${tvl}`,
      `pool:${i}`,
    ).row();
  });
  kb.text('🆕 Create new v4 pool…', 'createv4:preview').row();
  s.createV4Meme = ca;
  s.createV4Quote = primaryStableAddress(s.chainId) ?? CHAINS[s.chainId].wrapped;
  await ctx.reply(`Found ${s.pools.length} pool(s). Pick one (or create v4):`, {
    reply_markup: kb,
  });
}

/** Send or edit a Telegram Rich Message (tables, headings, details). */
async function sendOrEditRich(
  ctx: Context,
  html: string,
  kb: InlineKeyboard,
  edit: boolean,
): Promise<void> {
  const rich = { html, skip_entity_detection: true as const };
  if (edit && ctx.callbackQuery) {
    try {
      // grammY: pass InputRichMessage as first arg → rich_message path
      await ctx.editMessageText(rich, { reply_markup: kb });
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Can't convert plain text ↔ rich in place, or content unchanged
      if (!/message is not modified/i.test(msg)) {
        console.warn('[screener rich edit]', msg.slice(0, 200));
      }
      // Fall through to a fresh rich message
    }
  }
  try {
    await ctx.replyWithRichMessage(rich, { reply_markup: kb });
  } catch (e) {
    // Older clients / API edge: degrade to plain HTML text
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[screener rich send fallback]', msg.slice(0, 240));
    const plain = html
      .replace(/<\/?(h[1-6]|p|blockquote|footer|hr|table|tr|td|th|caption|details|summary|ol|ul|li)[^>]*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4000);
    await ctx.reply(plain || 'Screener (rich message unsupported on this client).', {
      reply_markup: kb,
    });
  }
}

async function replyScreener(
  ctx: Context,
  page: number,
  edit: boolean,
  forceRefresh = false,
): Promise<void> {
  const s = syncSessionFromPrefs(ctx.from!.id);
  const prefs = getUserPrefs(ctx.from!.id);
  const {
    fetchScreenerTokens,
    formatScreenerRichHtml,
    formatFilterSummary,
    gmgnTokenUrl,
  } = await import('../gmgn/screener.js');

  let tokens = s.screenerTokens;
  if (forceRefresh || !tokens?.length) {
    const status = edit
      ? null
      : await ctx.reply(
          `📡 Screening <b>${escapeHtmlBot(CHAINS[s.chainId].name)}</b>…\n` +
            `<i>${escapeHtmlBot(formatFilterSummary(prefs))}</i>`,
          { parse_mode: 'HTML' },
        );
    try {
      tokens = await fetchScreenerTokens(s.chainId, prefs);
      s.screenerTokens = tokens;
      s.screenerPage = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errHtml =
        `<h3>⚠️ Screener failed</h3>` +
        `<pre>${escapeHtmlBot(msg.slice(0, 450))}</pre>` +
        `<p><i>Needs gmgn-cli + GMGN API key in ~/.config/gmgn/</i></p>`;
      if (status) {
        try {
          await ctx.api.deleteMessage(status.chat.id, status.message_id);
        } catch {
          /* ignore */
        }
      }
      await sendOrEditRich(ctx, errHtml, new InlineKeyboard().text('🔄 Retry', 'scr:refresh'), false);
      return;
    }
    if (status) {
      try {
        await ctx.api.deleteMessage(status.chat.id, status.message_id);
      } catch {
        /* ignore */
      }
    }
  }

  const { html, page: p, totalPages, pageTokens } = formatScreenerRichHtml(
    s.chainId,
    prefs,
    tokens ?? [],
    page,
    SCREENER_PAGE_SIZE,
  );
  s.screenerPage = p;

  const kb = new InlineKeyboard();
  // Compact mint grid: 2 per row
  for (let i = 0; i < pageTokens.length; i++) {
    const t = pageTokens[i]!;
    const label = `🚀 $${t.symbol}`.slice(0, 28);
    kb.text(label, `scr:mint:${t.address}`);
    if (i % 2 === 1 || i === pageTokens.length - 1) kb.row();
  }
  if (totalPages > 1) {
    if (p > 0) kb.text('◀ Prev', `scr:page:${p - 1}`);
    kb.text(`${p + 1}/${totalPages}`, 'scr:refresh');
    if (p < totalPages - 1) kb.text('Next ▶', `scr:page:${p + 1}`);
    kb.row();
  }
  kb.text('🔄 Refresh', 'scr:refresh')
    .text('⚙️ Filters', 'scr:filters')
    .row();

  if (pageTokens[0]) {
    kb.url('🔗 GMGN #1', gmgnTokenUrl(s.chainId, pageTokens[0].address));
    if (pageTokens[1]) kb.url('🔗 #2', gmgnTokenUrl(s.chainId, pageTokens[1].address));
    if (pageTokens[2]) kb.url('🔗 #3', gmgnTokenUrl(s.chainId, pageTokens[2].address));
    kb.row();
  }

  // After refresh, always send a new rich message (cleaner than editing plain→rich)
  await sendOrEditRich(ctx, html, kb, edit && !forceRefresh);
}

async function replyScreenerFilters(ctx: Context, edit: boolean): Promise<void> {
  const prefs = getUserPrefs(ctx.from!.id);
  const s = syncSessionFromPrefs(ctx.from!.id);
  const { formatScreenerFiltersRichHtml, usdCompact } = await import('../gmgn/screener.js');
  const html = formatScreenerFiltersRichHtml(s.chainId, prefs);

  const markIv = (iv: string) =>
    prefs.screenerInterval === iv ? `✓ ${iv}` : iv;
  const maxMc =
    prefs.screenerMaxMcapUsd > 0 ? usdCompact(prefs.screenerMaxMcapUsd) : '∞';
  const aMax =
    prefs.alertMaxMcapUsd > 0 ? usdCompact(prefs.alertMaxMcapUsd) : '∞';

  const kb = new InlineKeyboard()
    // Screener interval
    .text(markIv('1m'), 'scr:iv:1m')
    .text(markIv('5m'), 'scr:iv:5m')
    .text(markIv('1h'), 'scr:iv:1h')
    .text(markIv('6h'), 'scr:iv:6h')
    .text(markIv('24h'), 'scr:iv:24h')
    .row()
    .text(`Vol≥${usdCompact(prefs.screenerMinVolumeUsd)}`, 'scr:edit:vol')
    .text(`KOL≥${prefs.screenerMinKol}`, 'scr:edit:kol')
    .text(`Fee≥${prefs.screenerMinTotalFee}`, 'scr:edit:fees')
    .row()
    .text(`MC≥${usdCompact(prefs.screenerMinMcapUsd)}`, 'scr:edit:mcap')
    .text(`MC≤${maxMc}`, 'scr:edit:maxmcap')
    .text(`Lim ${prefs.screenerLimit}`, 'scr:edit:limit')
    .row()
    // Alerts
    .text(prefs.alertEnabled ? '✓ Alerts ON' : 'Alerts OFF', `alert:${prefs.alertEnabled ? 'off' : 'on'}`)
    .row()
    .text(`A-Vol≥${usdCompact(prefs.alertMinVolumeUsd)}`, 'alert:edit:vol')
    .text(`A-KOL≥${prefs.alertMinKol}`, 'alert:edit:kol')
    .text(`A-Fee≥${prefs.alertMinTotalFee}`, 'alert:edit:fees')
    .row()
    .text(`A-MC≥${usdCompact(prefs.alertMinMcapUsd)}`, 'alert:edit:mcap')
    .text(`A-MC≤${aMax}`, 'alert:edit:maxmcap')
    .row()
    .text('↩ Defaults', 'scr:defaults')
    .text('📡 Run screener', 'scr:run')
    .row();

  await sendOrEditRich(ctx, html, kb, edit);
}

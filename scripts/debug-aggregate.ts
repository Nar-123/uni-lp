/**
 * Smoke-test Relay + Across quote aggregation (no broadcast).
 * Usage: npx tsx scripts/debug-aggregate.ts
 */
import 'dotenv/config';
import { previewAggregatedBridge } from '../src/chain/aggregate.js';
import { hasAcrossCredentials } from '../src/chain/across.js';

async function main() {
  console.log('Across configured:', hasAcrossCredentials());
  console.log('Integrator:', process.env.ACROSS_INTEGRATOR_ID);

  console.log('\n── BSC USDT → RH USDG (1 USDT) ──');
  try {
    const p = await previewAggregatedBridge({
      fromChain: 56,
      toChain: 4663,
      fromSymbol: 'USDT',
      toSymbol: 'USDG',
      amount: 1_000_000_000_000_000_000n,
    });
    console.log('winner:', p.provider);
    console.log('out:', p.amountOutFormatted, p.to.symbol);
    console.log(
      'candidates:',
      p.candidates.map((c) => ({
        p: c.provider,
        out: c.amountOutFormatted,
        err: c.error?.slice(0, 100),
      })),
    );
  } catch (e) {
    console.error('fail:', e instanceof Error ? e.message : e);
  }

  console.log('\n── RH USDG → BSC USDT (1 USDG) ──');
  try {
    const p = await previewAggregatedBridge({
      fromChain: 4663,
      toChain: 56,
      fromSymbol: 'USDG',
      toSymbol: 'USDT',
      amount: 1_000_000n,
    });
    console.log('winner:', p.provider);
    console.log('out:', p.amountOutFormatted, p.to.symbol);
    console.log(
      'candidates:',
      p.candidates.map((c) => ({
        p: c.provider,
        out: c.amountOutFormatted,
        err: c.error?.slice(0, 100),
      })),
    );
  } catch (e) {
    console.error('fail:', e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

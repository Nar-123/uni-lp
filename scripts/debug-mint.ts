import { listPoolsForToken, loadPool } from '../src/chain/pools.js';
import { getEffectiveDepositBalance } from '../src/chain/wrap.js';
import { describeMintPreview, mintSingleSided } from '../src/chain/mint.js';

async function main() {
  const chainId = 4663 as const;
  const ca = '0x473c2d32e28c66d7ef55a9c9f392325007366ddf' as const;
  const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const;

  const pools = await listPoolsForToken(chainId, ca);
  console.log('pools', pools.length);
  for (const [i, p] of pools.slice(0, 5).entries()) {
    console.log(i, p.label, p.poolAddress, 't0', p.token0, 't1', p.token1, 'fee', p.fee);
  }
  const top = pools[0];
  if (!top) {
    console.error('no pools');
    process.exit(1);
  }
  console.log('\nselected pool0', top.poolAddress);
  const pool = await loadPool(chainId, top.poolAddress);
  console.log(
    'pool tokens',
    pool.token0.symbol,
    pool.token1.symbol,
    'tick',
    pool.tick,
    'spacing',
    pool.tickSpacing,
  );
  const eff = await getEffectiveDepositBalance(chainId, weth);
  console.log('effective WETH', {
    erc20: eff.erc20.toString(),
    native: eff.native.toString(),
    wrappable: eff.wrappable.toString(),
    effective: eff.effective.toString(),
  });

  try {
    const preview = await describeMintPreview({
      chainId,
      poolAddress: top.poolAddress,
      depositToken: weth,
      balancePercent: 10,
      widthPercent: 20,
    });
    console.log('PREVIEW\n', preview);
  } catch (e) {
    console.error('preview err', e);
  }

  try {
    const r = await mintSingleSided({
      chainId,
      poolAddress: top.poolAddress,
      depositToken: weth,
      balancePercent: 10,
      widthPercent: 20,
    });
    console.log('MINT OK', r);
  } catch (e: unknown) {
    console.error('MINT ERR raw:', e);
    if (e instanceof Error) {
      console.error('message:', e.message);
      console.error('stack:', e.stack);
    }
    const any = e as Record<string, unknown>;
    for (const k of ['shortMessage', 'details', 'metaMessages', 'walk', 'cause', 'data']) {
      if (any && typeof any === 'object' && k in any) console.error(k, any[k]);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

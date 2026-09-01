import { createRequire } from 'node:module';
import { createPublicClient, http } from 'viem';
import { getConfig } from '../src/config.js';
import { poolAbi } from '../src/chain/abis.js';

const require = createRequire(import.meta.url);
const { Pool, Position } = require('@uniswap/v3-sdk') as typeof import('@uniswap/v3-sdk');
const { Token } = require('@uniswap/sdk-core') as typeof import('@uniswap/sdk-core');

async function main() {
  const cfg = getConfig();
  const client = createPublicClient({ transport: http(cfg.rpc[4663], { timeout: 20000 }) });
  const poolAddr = '0xb95956e052653fd5aB039BABd71F108728859AF5' as const;
  const slot0 = await client.readContract({ address: poolAddr, abi: poolAbi, functionName: 'slot0' });
  const liq = await client.readContract({ address: poolAddr, abi: poolAbi, functionName: 'liquidity' });
  console.log('tick', Number(slot0[1]), 'Lpool', liq.toString());

  const t0 = new Token(4663, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 18, 'WETH');
  const t1 = new Token(4663, '0x473C2D32E28c66d7EF55a9c9f392325007366dDf', 18, 'CashDog');
  const pool = new Pool(t0, t1, 10000, (slot0[0] as bigint).toString(), (liq as bigint).toString(), Number(slot0[1]));

  const amount0 = '1949382410064200';
  for (const [tickLower, tickUpper] of [
    [137800, 140200],
    [138000, 140000],
    [139000, 140000],
    [100000, 120000],
  ] as const) {
    try {
      const pos = Position.fromAmount0({
        pool,
        tickLower,
        tickUpper,
        amount0,
        useFullPrecision: true,
      });
      console.log(
        `range ${tickLower}-${tickUpper} L=${pos.liquidity.toString()} a0=${pos.amount0.quotient.toString()} a1=${pos.amount1.quotient.toString()}`,
      );
    } catch (e) {
      console.log(`range ${tickLower}-${tickUpper} ERR`, (e as Error).message);
    }
  }
}
main();

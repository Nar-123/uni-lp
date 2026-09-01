import { createRequire } from 'node:module';
import { createPublicClient, createWalletClient, http, maxUint256, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getConfig, CHAINS } from '../src/config.js';
import { poolAbi, erc20Abi, npmAbi } from '../src/chain/abis.js';
import { robinhood } from '../src/chain/clients.js';

const require = createRequire(import.meta.url);
const { Pool, Position, nearestUsableTick, NonfungiblePositionManager, Percent } = require('@uniswap/v3-sdk') as any;
const { Token, Percent: CorePercent, CurrencyAmount } = require('@uniswap/sdk-core') as any;

async function main() {
  const cfg = getConfig();
  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = createPublicClient({ chain: robinhood, transport: http(cfg.rpc[4663], { timeout: 30000 }) });
  const walletClient = createWalletClient({ account, chain: robinhood, transport: http(cfg.rpc[4663], { timeout: 30000 }) });

  const poolAddr = '0xb95956e052653fd5aB039BABd71F108728859AF5' as Address;
  const npm = CHAINS[4663].npm;
  const slot0 = await publicClient.readContract({ address: poolAddr, abi: poolAbi, functionName: 'slot0' });
  const liq = await publicClient.readContract({ address: poolAddr, abi: poolAbi, functionName: 'liquidity' });
  const cur = Number(slot0[1]);
  const spacing = 200;
  console.log('cur tick', cur);

  // 1 usable tick below market for token0 (all WETH when price above range)
  let tickUpper = Math.floor((cur - spacing) / spacing) * spacing;
  if (tickUpper >= cur) tickUpper -= spacing;
  // ~20% in tick space: ln(0.8)/ln(1.0001) ≈ 2231
  const width = Math.ceil(2231 / spacing) * spacing;
  let tickLower = tickUpper - width;
  tickLower = Math.floor(tickLower / spacing) * spacing;
  console.log('range', tickLower, tickUpper, 'width ticks', width);

  const t0 = new Token(4663, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 18, 'WETH');
  const t1 = new Token(4663, '0x473C2D32E28c66d7EF55a9c9f392325007366dDf', 18, 'CashDog');
  const pool = new Pool(t0, t1, 10000, (slot0[0] as bigint).toString(), (liq as bigint).toString(), cur);

  const bal = await publicClient.readContract({
    address: t0.address as Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  // use 50% of WETH balance only (no wrap)
  const amount0 = (bal * 50n) / 100n;
  console.log('using amount0', amount0.toString());

  // Build position - for price above range use fromAmount0
  let pos;
  try {
    pos = Position.fromAmount0({
      pool,
      tickLower,
      tickUpper,
      amount0: amount0.toString(),
      useFullPrecision: false,
    });
    console.log('pos L', pos.liquidity.toString());
    console.log('pos a0', pos.amount0.quotient.toString());
    console.log('pos a1', pos.amount1.quotient.toString());
  } catch (e: any) {
    console.error('pos err', e.message);
    return;
  }

  // If L is absurd, try manual: use createCallParameters from NPM sdk
  const { calldata, value } = NonfungiblePositionManager.addCallParameters(pos, {
    slippageTolerance: new Percent(50, 10_000),
    recipient: account.address,
    deadline: Math.floor(Date.now() / 1000) + 1200,
  });
  console.log('calldata len', calldata.length, 'value', value);

  // simulate raw tx
  try {
    await publicClient.call({
      account: account.address,
      to: npm,
      data: calldata as `0x${string}`,
      value: BigInt(value),
    });
    console.log('SDK calldata call OK');
  } catch (e: any) {
    console.error('SDK calldata FAIL', e.shortMessage || e.message);
  }

  // direct mint with a0 from position if sane
  const a0 = BigInt(pos.amount0.quotient.toString());
  const a1 = BigInt(pos.amount1.quotient.toString());
  if (a0 > amount0 * 2n || a1 > 10n ** 30n) {
    console.log('SDK amounts look broken, trying raw mint with amount0 only min0');
  }

  try {
    await publicClient.simulateContract({
      address: npm,
      abi: npmAbi,
      functionName: 'mint',
      args: [{
        token0: t0.address,
        token1: t1.address,
        fee: 10000,
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: 0n,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: account.address,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
      }],
      account: account.address,
    });
    console.log('raw mint sim OK');
  } catch (e: any) {
    console.error('raw mint FAIL', e.shortMessage || e.message);
  }
}
main();

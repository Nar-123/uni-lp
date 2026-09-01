import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGasPadding,
  estimateWriteGas,
  buildGasTelemetry,
  GAS_ESTIMATE_PADDING_BPS,
  type EstimateWriteGasParams,
} from '../src/chain/gas.js';

test('applyGasPadding: adds the configured bps on top of the estimate', () => {
  assert.equal(applyGasPadding(100_000n, 2000), 120_000n); // +20%
  assert.equal(applyGasPadding(100_000n, 0), 100_000n);
});

test('applyGasPadding: zero/negative estimate passes through unchanged (never inflated)', () => {
  assert.equal(applyGasPadding(0n, 2000), 0n);
});

test('applyGasPadding: negative bps clamps to 0 padding, not negative gas', () => {
  assert.equal(applyGasPadding(100_000n, -500), 100_000n);
});

function baseParams(overrides: Partial<EstimateWriteGasParams> = {}): EstimateWriteGasParams {
  return {
    client: { estimateContractGas: async () => 250_000n },
    address: '0x1000000000000000000000000000000000000001',
    abi: [],
    functionName: 'test',
    account: '0x1000000000000000000000000000000000000002',
    fallbackGas: 900_000n,
    context: 'test-op',
    ...overrides,
  };
}

test('gas estimation success: applies default padding to a live estimate', async () => {
  const gas = await estimateWriteGas(baseParams());
  assert.equal(gas, applyGasPadding(250_000n, GAS_ESTIMATE_PADDING_BPS));
  assert.notEqual(gas, 900_000n); // must not silently be the fallback
});

test('gas estimation failure: falls back to the explicit, bounded fallbackGas — never unlimited/huge', async () => {
  const gas = await estimateWriteGas(
    baseParams({
      client: {
        estimateContractGas: async () => {
          throw new Error('transient RPC timeout');
        },
      },
      fallbackGas: 900_000n,
      sleepFn: async () => {},
    }),
  );
  assert.equal(gas, 900_000n);
});

test('gas estimation failure never throws — a gas-estimation hiccup must not itself abort a transaction', async () => {
  await assert.doesNotReject(() =>
    estimateWriteGas(
      baseParams({
        client: {
          estimateContractGas: async () => {
            throw new Error('anything');
          },
        },
        sleepFn: async () => {},
      }),
    ),
  );
});

test('gas estimation retries once before falling back — a single transient blip does not degrade to the fallback', async () => {
  let calls = 0;
  const gas = await estimateWriteGas(
    baseParams({
      client: {
        estimateContractGas: async () => {
          calls++;
          if (calls === 1) throw new Error('transient blip');
          return 300_000n;
        },
      },
      sleepFn: async () => {},
    }),
  );
  assert.equal(calls, 2, 'must have retried exactly once');
  assert.equal(gas, applyGasPadding(300_000n, GAS_ESTIMATE_PADDING_BPS));
});

test('custom padding overrides the default', async () => {
  const gas = await estimateWriteGas(baseParams({ paddingBps: 5000 }));
  assert.equal(gas, applyGasPadding(250_000n, 5000));
});

test('buildGasTelemetry: computes actual gas cost from a mined receipt', async () => {
  const telemetry = await buildGasTelemetry(
    {
      getTransactionReceipt: async () => ({
        gasUsed: 210_000n,
        effectiveGasPrice: 1_000_000_000n, // 1 gwei
      }),
    },
    '0xdead' as `0x${string}`,
    252_000n,
  );
  assert.equal(telemetry.gasLimitSent, '252000');
  assert.equal(telemetry.gasUsed, '210000');
  assert.equal(telemetry.effectiveGasPriceWei, '1000000000');
  assert.equal(telemetry.actualGasCostWei, (210_000n * 1_000_000_000n).toString());
});

test('buildGasTelemetry: falls back to legacy gasPrice when effectiveGasPrice is absent', async () => {
  const telemetry = await buildGasTelemetry(
    {
      getTransactionReceipt: async () => ({ gasUsed: 100_000n, gasPrice: 2_000_000_000n }),
    },
    '0xdead' as `0x${string}`,
  );
  assert.equal(telemetry.effectiveGasPriceWei, '2000000000');
  assert.equal(telemetry.actualGasCostWei, (100_000n * 2_000_000_000n).toString());
});

test('buildGasTelemetry: unmeasurable receipt fields stay null (UNKNOWN), never fabricated zero', async () => {
  const telemetry = await buildGasTelemetry(
    {
      getTransactionReceipt: async () => {
        throw new Error('receipt not found');
      },
    },
    '0xdead' as `0x${string}`,
    300_000n,
  );
  assert.equal(telemetry.gasUsed, null);
  assert.equal(telemetry.effectiveGasPriceWei, null);
  assert.equal(telemetry.actualGasCostWei, null);
  // gasLimitSent was known up front (the padded value we sent) — that part
  // isn't affected by a receipt-lookup failure.
  assert.equal(telemetry.gasLimitSent, '300000');
});

test('buildGasTelemetry: never throws — a telemetry hiccup must not itself fail anything', async () => {
  await assert.doesNotReject(() =>
    buildGasTelemetry(
      {
        getTransactionReceipt: async () => {
          throw new Error('boom');
        },
      },
      '0xdead' as `0x${string}`,
    ),
  );
});

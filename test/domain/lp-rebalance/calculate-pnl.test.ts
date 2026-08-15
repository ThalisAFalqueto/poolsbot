import { describe, expect, it } from "vitest";
import { calculatePnl } from "../../../src/domain/lp-rebalance/calculate-pnl.js";
import { calculateImpermanentLoss } from "../../../src/domain/lp-rebalance/calculate-il.js";
import { Q96, sqrtPriceX96ToPrice, sqrtRatioAtTick } from "../../../src/domain/lp-rebalance/price-math.js";

function sqrtRatioToX96(ratio: number): bigint {
  return BigInt(Math.round(ratio * Q96));
}

function sqrtPriceAtTick(tick: number): bigint {
  return sqrtRatioToX96(sqrtRatioAtTick(tick));
}

const TICK_LOWER = -6931;
const TICK_UPPER = 6931;
const LIQUIDITY = 1_000_000_000n;
const DECIMALS0 = 18;
const DECIMALS1 = 18;
const BASELINE_DATE = new Date("2026-08-01T00:00:00Z");

function makeIl(baselineTick: number, currentTick: number) {
  return calculateImpermanentLoss({
    liquidity: LIQUIDITY,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    decimals0: DECIMALS0,
    decimals1: DECIMALS1,
    baselineSqrtPriceX96: sqrtPriceAtTick(baselineTick),
    baselineRecordedAt: BASELINE_DATE,
    currentSqrtPriceX96: sqrtPriceAtTick(currentTick),
  });
}

function pricesFor(baselineTick: number, currentTick: number) {
  return {
    entryPriceToken1: sqrtPriceX96ToPrice(sqrtPriceAtTick(baselineTick), DECIMALS0, DECIMALS1),
    currentPriceToken1: sqrtPriceX96ToPrice(sqrtPriceAtTick(currentTick), DECIMALS0, DECIMALS1),
  };
}

describe("calculatePnl", () => {
  it("preço subiu com fees positivas: movimento de preço positivo, total > principal", () => {
    const il = makeIl(0, 2000);
    const { entryPriceToken1, currentPriceToken1 } = pricesFor(0, 2000);
    const result = calculatePnl({ il, entryPriceToken1, currentPriceToken1, feesAmount0: 0.01, feesAmount1: 5 });

    expect(result.priceMovementToken1).toBeGreaterThan(0);
    expect(result.feesValueToken1).toBeGreaterThan(0);
    expect(result.totalPnlToken1).toBeGreaterThan(result.principalPnlToken1);
  });

  it("preço caiu: movimento de preço negativo", () => {
    const il = makeIl(0, -2000);
    const { entryPriceToken1, currentPriceToken1 } = pricesFor(0, -2000);
    const result = calculatePnl({ il, entryPriceToken1, currentPriceToken1, feesAmount0: 0, feesAmount1: 0 });

    expect(result.priceMovementToken1).toBeLessThan(0);
  });

  it("fees zeradas: total P&L igual ao principal", () => {
    const il = makeIl(0, 1000);
    const { entryPriceToken1, currentPriceToken1 } = pricesFor(0, 1000);
    const result = calculatePnl({ il, entryPriceToken1, currentPriceToken1, feesAmount0: 0, feesAmount1: 0 });

    expect(result.feesValueToken1).toBe(0);
    expect(result.totalPnlToken1).toBeCloseTo(result.principalPnlToken1, 8);
  });

  it("IL grande mas fees compensam: P&L total positivo mesmo com principal negativo", () => {
    // preço caiu (não subiu): aqui o movimento de preço e o IL têm o MESMO
    // sinal (negativo), então o principal fica negativo de forma confiável —
    // com preço subindo, o movimento de preço pode compensar o IL sozinho.
    const il = makeIl(0, -5000);
    const { entryPriceToken1, currentPriceToken1 } = pricesFor(0, -5000);

    // sem fees, o principal deve ficar negativo (IL supera qualquer ganho de preço residual)
    const withoutFees = calculatePnl({ il, entryPriceToken1, currentPriceToken1, feesAmount0: 0, feesAmount1: 0 });
    expect(withoutFees.principalPnlToken1).toBeLessThan(0);

    // fees grandes o bastante pra compensar
    const bigFees = Math.abs(withoutFees.principalPnlToken1) * 2;
    const withFees = calculatePnl({ il, entryPriceToken1, currentPriceToken1, feesAmount0: 0, feesAmount1: bigFees });
    expect(withFees.totalPnlToken1).toBeGreaterThan(0);
  });

  it("invariantes algébricas: principal = movimento de preço + IL; total = principal + fees", () => {
    const il = makeIl(0, 3000);
    const { entryPriceToken1, currentPriceToken1 } = pricesFor(0, 3000);
    const result = calculatePnl({ il, entryPriceToken1, currentPriceToken1, feesAmount0: 0.02, feesAmount1: 10 });

    expect(result.principalPnlToken1).toBeCloseTo(result.priceMovementToken1 + result.ilToken1, 6);
    expect(result.totalPnlToken1).toBeCloseTo(result.principalPnlToken1 + result.feesValueToken1, 6);
  });

  it("preço de entrada igual ao atual: movimento de preço ~0", () => {
    const il = makeIl(0, 0);
    const { entryPriceToken1, currentPriceToken1 } = pricesFor(0, 0);
    const result = calculatePnl({ il, entryPriceToken1, currentPriceToken1, feesAmount0: 0, feesAmount1: 0 });

    expect(result.priceMovementToken1).toBeCloseTo(0, 6);
  });
});

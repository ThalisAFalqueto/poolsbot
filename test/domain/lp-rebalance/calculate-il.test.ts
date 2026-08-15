import { describe, expect, it } from "vitest";
import { calculateImpermanentLoss } from "../../../src/domain/lp-rebalance/calculate-il.js";
import { Q96, sqrtRatioAtTick } from "../../../src/domain/lp-rebalance/price-math.js";

function sqrtRatioToX96(ratio: number): bigint {
  return BigInt(Math.round(ratio * Q96));
}

function sqrtPriceAtTick(tick: number): bigint {
  return sqrtRatioToX96(sqrtRatioAtTick(tick));
}

const TICK_LOWER = -6931;
const TICK_UPPER = 6931;
const LIQUIDITY = 1_000_000_000n;
const BASELINE_DATE = new Date("2026-08-01T00:00:00Z");

function makeInput(baselineTick: number, currentTick: number) {
  return {
    liquidity: LIQUIDITY,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    decimals0: 18,
    decimals1: 18,
    baselineSqrtPriceX96: sqrtPriceAtTick(baselineTick),
    baselineRecordedAt: BASELINE_DATE,
    currentSqrtPriceX96: sqrtPriceAtTick(currentTick),
  };
}

describe("calculateImpermanentLoss", () => {
  it("preço no mesmo nível do baseline: IL ~0", () => {
    const result = calculateImpermanentLoss(makeInput(0, 0));
    expect(result.ilPct).toBeCloseTo(0, 6);
  });

  it("preço subiu desde o baseline: IL negativo", () => {
    const result = calculateImpermanentLoss(makeInput(0, 3000));
    expect(result.ilPct).toBeLessThan(0);
  });

  it("preço caiu desde o baseline: IL negativo", () => {
    const result = calculateImpermanentLoss(makeInput(0, -3000));
    expect(result.ilPct).toBeLessThan(0);
  });

  it("preço subiu e depois voltou ao mesmo nível: IL ~0 (só os extremos importam, não o caminho)", () => {
    const result = calculateImpermanentLoss(makeInput(0, 0));
    expect(result.ilPct).toBeCloseTo(0, 6);
  });

  it("quanto maior a divergência de preço, maior a magnitude do IL", () => {
    const small = calculateImpermanentLoss(makeInput(0, 500));
    const big = calculateImpermanentLoss(makeInput(0, 5000));
    expect(Math.abs(big.ilPct)).toBeGreaterThan(Math.abs(small.ilPct));
  });

  it("posição atual fora de faixa (preço rompeu o teto): calcula sem lançar erro, IL ainda <= 0", () => {
    const result = calculateImpermanentLoss(makeInput(0, 10000)); // 10000 > TICK_UPPER
    expect(Number.isFinite(result.ilPct)).toBe(true);
    expect(result.ilPct).toBeLessThanOrEqual(0);
  });

  it("baseline registrado com a posição já fora de faixa: calcula sem lançar erro", () => {
    const result = calculateImpermanentLoss(makeInput(-10000, 0)); // baseline abaixo do TICK_LOWER
    expect(Number.isFinite(result.ilPct)).toBe(true);
  });

  it("preserva a data do baseline em 'since'", () => {
    const result = calculateImpermanentLoss(makeInput(0, 1000));
    expect(result.since).toEqual(BASELINE_DATE);
  });
});

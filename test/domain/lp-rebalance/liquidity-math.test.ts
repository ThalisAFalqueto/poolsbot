import { describe, expect, it } from "vitest";
import { getAmountsForLiquidity } from "../../../src/domain/lp-rebalance/liquidity-math.js";
import { Q96, sqrtRatioAtTick } from "../../../src/domain/lp-rebalance/price-math.js";

function sqrtRatioToX96(ratio: number): bigint {
  return BigInt(Math.round(ratio * Q96));
}

const TICK_LOWER = -6931; // ~preço 0.5
const TICK_UPPER = 6931; // ~preço 2
const LIQUIDITY = 1_000_000_000n;

describe("getAmountsForLiquidity", () => {
  it("preço abaixo do range: tudo em token0, amount1 = 0", () => {
    const belowRatio = sqrtRatioAtTick(TICK_LOWER) * 0.9;
    const result = getAmountsForLiquidity({
      liquidity: LIQUIDITY,
      sqrtPriceX96: sqrtRatioToX96(belowRatio),
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      decimals0: 18,
      decimals1: 18,
    });
    expect(result.amount1).toBe(0);
    expect(result.amount0).toBeGreaterThan(0);
  });

  it("preço acima do range: tudo em token1, amount0 = 0", () => {
    const aboveRatio = sqrtRatioAtTick(TICK_UPPER) * 1.1;
    const result = getAmountsForLiquidity({
      liquidity: LIQUIDITY,
      sqrtPriceX96: sqrtRatioToX96(aboveRatio),
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      decimals0: 18,
      decimals1: 18,
    });
    expect(result.amount0).toBe(0);
    expect(result.amount1).toBeGreaterThan(0);
  });

  it("preço dentro do range: mix dos dois tokens", () => {
    const result = getAmountsForLiquidity({
      liquidity: LIQUIDITY,
      sqrtPriceX96: sqrtRatioToX96(sqrtRatioAtTick(0)),
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      decimals0: 18,
      decimals1: 18,
    });
    expect(result.amount0).toBeGreaterThan(0);
    expect(result.amount1).toBeGreaterThan(0);
  });

  it("liquidez 0 dá amounts 0", () => {
    const result = getAmountsForLiquidity({
      liquidity: 0n,
      sqrtPriceX96: sqrtRatioToX96(sqrtRatioAtTick(0)),
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      decimals0: 18,
      decimals1: 18,
    });
    expect(result.amount0).toBe(0);
    expect(result.amount1).toBe(0);
  });

  it("amount0 diminui e amount1 aumenta conforme o preço sobe dentro do range", () => {
    const lowerMid = getAmountsForLiquidity({
      liquidity: LIQUIDITY,
      sqrtPriceX96: sqrtRatioToX96(sqrtRatioAtTick(-2000)),
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      decimals0: 18,
      decimals1: 18,
    });
    const upperMid = getAmountsForLiquidity({
      liquidity: LIQUIDITY,
      sqrtPriceX96: sqrtRatioToX96(sqrtRatioAtTick(2000)),
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      decimals0: 18,
      decimals1: 18,
    });
    expect(upperMid.amount0).toBeLessThan(lowerMid.amount0);
    expect(upperMid.amount1).toBeGreaterThan(lowerMid.amount1);
  });

  it("ajusta pela diferença de decimais entre tokens", () => {
    const ratio = sqrtRatioAtTick(0);
    const sameDecimals = getAmountsForLiquidity({
      liquidity: LIQUIDITY,
      sqrtPriceX96: sqrtRatioToX96(ratio),
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      decimals0: 18,
      decimals1: 18,
    });
    const diffDecimals = getAmountsForLiquidity({
      liquidity: LIQUIDITY,
      sqrtPriceX96: sqrtRatioToX96(ratio),
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      decimals0: 18,
      decimals1: 6,
    });
    expect(diffDecimals.amount1).toBeCloseTo(sameDecimals.amount1 * 10 ** 12, -5);
  });
});

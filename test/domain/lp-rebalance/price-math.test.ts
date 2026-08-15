import { describe, expect, it } from "vitest";
import {
  isFullRangeLower,
  isFullRangeUpper,
  isInRange,
  roundToSpacing,
  sqrtPriceX96ToPrice,
  tickSpacingForFee,
  tickToPrice,
} from "../../../src/domain/lp-rebalance/price-math.js";

const Q96 = 2n ** 96n;

describe("sqrtPriceX96ToPrice", () => {
  it("preço raw = 1 (sqrtPriceX96 = 2^96) com decimais iguais dá price = 1", () => {
    expect(sqrtPriceX96ToPrice(Q96, 0, 0)).toBeCloseTo(1, 10);
  });

  it("preço raw = 4 (sqrtPriceX96 = 2 * 2^96) dá price = 4", () => {
    expect(sqrtPriceX96ToPrice(2n * Q96, 0, 0)).toBeCloseTo(4, 8);
  });

  it("ajusta por diferença de decimais entre token0 e token1", () => {
    // WETH (18 decimais) / USDC (6 decimais): preço raw 1 vira 10^12 em unidades humanas
    expect(sqrtPriceX96ToPrice(Q96, 18, 6)).toBeCloseTo(10 ** 12, -2);
  });
});

describe("tickToPrice", () => {
  it("tick 0 dá price = 10^(decimals0-decimals1)", () => {
    expect(tickToPrice(0, 18, 6)).toBeCloseTo(10 ** 12, -2);
    expect(tickToPrice(0, 0, 0)).toBeCloseTo(1, 10);
  });

  it("é monotonicamente crescente em tick", () => {
    const low = tickToPrice(100, 0, 0);
    const high = tickToPrice(200, 0, 0);
    expect(high).toBeGreaterThan(low);
  });

  it("não estoura pra Infinity no tick máximo válido do Uniswap V3", () => {
    const price = tickToPrice(887272, 0, 0);
    expect(Number.isFinite(price)).toBe(true);
  });
});

describe("tickSpacingForFee", () => {
  it("retorna o spacing correto pros fee tiers conhecidos", () => {
    expect(tickSpacingForFee(100)).toBe(1);
    expect(tickSpacingForFee(500)).toBe(10);
    expect(tickSpacingForFee(3000)).toBe(60);
    expect(tickSpacingForFee(10000)).toBe(200);
  });

  it("lança erro pra fee tier desconhecido", () => {
    expect(() => tickSpacingForFee(1234)).toThrow();
  });
});

describe("roundToSpacing", () => {
  it("arredonda pro múltiplo mais próximo", () => {
    expect(roundToSpacing(105, 60)).toBe(120);
    expect(roundToSpacing(89, 60)).toBe(60);
    expect(roundToSpacing(-105, 60)).toBe(-120);
  });
});

describe("isFullRangeLower / isFullRangeUpper", () => {
  it("detecta ticks full-range arredondados pro spacing de qualquer fee tier", () => {
    // caso real observado em produção: fee 3000 (spacing 60) -> full range = ±887220
    expect(isFullRangeLower(-887220)).toBe(true);
    expect(isFullRangeUpper(887220)).toBe(true);
  });

  it("não marca ticks normais como full-range", () => {
    expect(isFullRangeLower(41280)).toBe(false);
    expect(isFullRangeUpper(55140)).toBe(false);
    expect(isFullRangeLower(0)).toBe(false);
    expect(isFullRangeUpper(0)).toBe(false);
  });
});

describe("isInRange", () => {
  it("dentro do range (limite inferior inclusivo)", () => {
    expect(isInRange(100, 100, 200)).toBe(true);
    expect(isInRange(150, 100, 200)).toBe(true);
  });

  it("limite superior é exclusivo", () => {
    expect(isInRange(200, 100, 200)).toBe(false);
  });

  it("fora do range", () => {
    expect(isInRange(99, 100, 200)).toBe(false);
    expect(isInRange(201, 100, 200)).toBe(false);
  });
});

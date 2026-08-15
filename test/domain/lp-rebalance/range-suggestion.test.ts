import { describe, expect, it } from "vitest";
import { suggestRange } from "../../../src/domain/lp-rebalance/range-suggestion.js";

describe("suggestRange", () => {
  it("mantém a mesma largura, recentralizada no tick atual", () => {
    // faixa original: 0 a 1200 (largura 1200), fee 3000 -> spacing 60
    const result = suggestRange(3000, 0, 1200, 3000);
    const width = result.tickUpper - result.tickLower;
    expect(width).toBe(1200);
    // centralizada em 3000: 2400-3600
    expect(result.tickLower).toBe(2400);
    expect(result.tickUpper).toBe(3600);
  });

  it("arredonda pro tickSpacing do fee tier", () => {
    const result = suggestRange(105, 0, 100, 500); // spacing 10
    expect(result.tickLower % 10).toBe(0);
    expect(result.tickUpper % 10).toBe(0);
  });

  it("garante largura mínima de 1 spacing mesmo se a largura original for degenerada", () => {
    const result = suggestRange(100, 100, 100, 3000); // largura original 0
    expect(result.tickUpper - result.tickLower).toBeGreaterThanOrEqual(60);
  });

  it("respeita os limites MIN_TICK/MAX_TICK", () => {
    const result = suggestRange(-887272, -887272, -887000, 3000);
    expect(result.tickLower).toBeGreaterThanOrEqual(-887272);
  });
});

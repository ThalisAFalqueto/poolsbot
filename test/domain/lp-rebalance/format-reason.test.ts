import { describe, expect, it } from "vitest";
import { formatBoundaryPrice, formatOutOfRangeReason } from "../../../src/domain/lp-rebalance/format-reason.js";
import type { OnchainPosition } from "../../../src/domain/lp-rebalance/types.js";

describe("formatBoundaryPrice", () => {
  it("mostra '0' pro limite inferior full-range em vez de um número astronômico", () => {
    expect(formatBoundaryPrice(-887220, 18, 6)).toBe("0");
  });

  it("mostra '∞' pro limite superior full-range", () => {
    expect(formatBoundaryPrice(887220, 18, 6)).toBe("∞");
  });

  it("mostra o preço formatado normalmente pra ticks não-extremos", () => {
    const result = formatBoundaryPrice(41280, 18, 18);
    expect(result).not.toBe("0");
    expect(Number.isNaN(Number(result))).toBe(false);
  });

  it("mostra '∞' pra um tick alto mas não exatamente no MAX_TICK absoluto (caso do range sugerido pra posição assimétrica)", () => {
    // reproduz o bug real encontrado: suggestRange pode gerar um tick como
    // 686296 (não perto do MAX_TICK=887272) que ainda produz preço absurdo
    // quando a diferença de decimais entre os tokens é grande.
    expect(formatBoundaryPrice(686296, 18, 6)).toBe("∞");
  });
});

describe("formatOutOfRangeReason", () => {
  it("não produz números absurdos mesmo com uma posição full-range (edge case defensivo)", () => {
    const position: OnchainPosition = {
      tokenId: 92n,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fee: 3000,
      tickLower: -887220,
      tickUpper: 887220,
      currentTick: -200924,
      sqrtPriceX96: 2n ** 96n,
      token0: { address: "0x0000000000000000000000000000000000000002", decimals: 18, symbol: "WETH" },
      token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDT" },
    };
    const reason = formatOutOfRangeReason(position);
    expect(reason).toContain("0 –");
    expect(reason).toContain("∞");
    expect(reason).not.toMatch(/e\+\d\d/); // sem notação científica tipo "3.38e+50"
  });

  it("não produz números absurdos numa posição larga e assimétrica (um lado full-range, outro real)", () => {
    const position: OnchainPosition = {
      tokenId: 999n,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fee: 3000,
      tickLower: -887220, // sem piso prático
      tickUpper: 50000, // teto real
      currentTick: 60000, // rompeu o teto
      sqrtPriceX96: 2n ** 96n,
      token0: { address: "0x0000000000000000000000000000000000000002", decimals: 18, symbol: "WETH" },
      token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDT" },
    };
    const reason = formatOutOfRangeReason(position);
    expect(reason).not.toMatch(/e\+\d\d/);
  });
});

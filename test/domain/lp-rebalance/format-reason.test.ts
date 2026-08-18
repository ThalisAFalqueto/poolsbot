import { describe, expect, it } from "vitest";
import { formatBoundaryPrice, formatIlLine, formatOutOfRangeReason } from "../../../src/domain/lp-rebalance/format-reason.js";
import type { ImpermanentLossResult } from "../../../src/domain/lp-rebalance/calculate-il.js";
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
      chain: "arbitrum",
      tokenId: 92n,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fee: 3000,
      tickLower: -887220,
      tickUpper: 887220,
      currentTick: -200924,
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000_000n,
      token0: { address: "0x0000000000000000000000000000000000000002", decimals: 18, symbol: "WETH" },
      token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDT" },
    };
    const reason = formatOutOfRangeReason(position, null);
    expect(reason).toContain("0 –");
    expect(reason).toContain("∞");
    expect(reason).not.toMatch(/e\+\d\d/); // sem notação científica tipo "3.38e+50"
  });

  it("não produz números absurdos numa posição larga e assimétrica (um lado full-range, outro real)", () => {
    const position: OnchainPosition = {
      chain: "arbitrum",
      tokenId: 999n,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fee: 3000,
      tickLower: -887220, // sem piso prático
      tickUpper: 50000, // teto real
      currentTick: 60000, // rompeu o teto
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000_000n,
      token0: { address: "0x0000000000000000000000000000000000000002", decimals: 18, symbol: "WETH" },
      token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDT" },
    };
    const reason = formatOutOfRangeReason(position, null);
    expect(reason).not.toMatch(/e\+\d\d/);
  });

  it("mostra o custo de gas convertido quando fornecido", () => {
    const position: OnchainPosition = {
      chain: "arbitrum",
      walletAddress: "0x0000000000000000000000000000000000000004",
      tokenId: 1n,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fee: 3000,
      tickLower: -6931,
      tickUpper: 6931,
      currentTick: 10000,
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000_000n,
      token0: { address: "0x0000000000000000000000000000000000000002", decimals: 18, symbol: "WETH" },
      token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDC" },
    };
    const reason = formatOutOfRangeReason(position, { costEth: 0.0005, costToken1: 1.23 });
    expect(reason).toContain("Custo estimado de rebalance");
    expect(reason).toContain("1.2300 USDC");
  });

  it("omite a linha de custo de gas quando costToken1 é null (par sem WETH)", () => {
    const position: OnchainPosition = {
      chain: "arbitrum",
      walletAddress: "0x0000000000000000000000000000000000000004",
      tokenId: 1n,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fee: 3000,
      tickLower: -6931,
      tickUpper: 6931,
      currentTick: 10000,
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000_000n,
      token0: { address: "0x0000000000000000000000000000000000000002", decimals: 6, symbol: "USDC" },
      token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDT" },
    };
    const reason = formatOutOfRangeReason(position, { costEth: 0.0005, costToken1: null });
    expect(reason).not.toContain("Custo estimado de rebalance");
  });

  it("omite a linha de custo de gas quando gasCost é null", () => {
    const position: OnchainPosition = {
      chain: "arbitrum",
      walletAddress: "0x0000000000000000000000000000000000000004",
      tokenId: 1n,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fee: 3000,
      tickLower: -6931,
      tickUpper: 6931,
      currentTick: 10000,
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_000_000_000n,
      token0: { address: "0x0000000000000000000000000000000000000002", decimals: 18, symbol: "WETH" },
      token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDC" },
    };
    const reason = formatOutOfRangeReason(position, null);
    expect(reason).not.toContain("Custo estimado de rebalance");
  });
});

describe("formatIlLine", () => {
  function makeIl(overrides: Partial<ImpermanentLossResult> = {}): ImpermanentLossResult {
    return {
      ilPct: -0.0234,
      hodlValueToken1: 1000,
      positionValueToken1: 976.6,
      baselineAmount0: 1,
      baselineAmount1: 500,
      currentAmount0: 1.1,
      currentAmount1: 450,
      since: new Date("2026-08-01T00:00:00Z"),
      ...overrides,
    };
  }

  it("mostra a porcentagem de IL e a data do baseline", () => {
    const line = formatIlLine(makeIl(), false, "USDC");
    expect(line).toContain("-2.34%");
    expect(line).toContain("USDC");
  });

  it("deixa claro que não é a abertura real e não desconta fees", () => {
    const line = formatIlLine(makeIl(), false, "USDC");
    expect(line).toContain("não é a abertura on-chain real");
    expect(line).toContain("não desconta fees");
  });

  it("sinaliza quando o baseline foi resetado", () => {
    const line = formatIlLine(makeIl(), true, "USDC");
    expect(line).toContain("resetado por alteração na liquidez");
  });

  it("não sinaliza reset quando o baseline é o original", () => {
    const line = formatIlLine(makeIl(), false, "USDC");
    expect(line).not.toContain("resetado");
  });
});

import { describe, expect, it } from "vitest";
import { computeRiskAdjustedScore, rankByRiskAdjustedYield } from "../../../src/domain/yield-optimizer/score.js";
import type { RankablePool } from "../../../src/domain/pools/types.js";

function makePool(overrides: Partial<RankablePool> = {}): RankablePool {
  return {
    poolId: "p1",
    chain: "Arbitrum",
    project: "uniswap-v3",
    symbol: "WETH-USDC",
    apy: 10,
    tvlUsd: 1_000_000,
    ilRisk: "no",
    sigma: null,
    apyMean30d: null,
    ...overrides,
  };
}

describe("computeRiskAdjustedScore", () => {
  it("TVL alto o suficiente não penaliza (fator satura em 1.0)", () => {
    const pool = makePool({ apy: 10, tvlUsd: 1_000_000 });
    expect(computeRiskAdjustedScore(pool)).toBeCloseTo(10, 5);
  });

  it("TVL baixo penaliza proporcionalmente", () => {
    const pool = makePool({ apy: 10, tvlUsd: 250_000 }); // metade do limiar de $500k
    expect(computeRiskAdjustedScore(pool)).toBeCloseTo(5, 5);
  });

  it("ilRisk='yes' aplica penalidade fixa de 15%", () => {
    const safe = makePool({ apy: 10, ilRisk: "no" });
    const risky = makePool({ apy: 10, ilRisk: "yes" });
    expect(computeRiskAdjustedScore(risky)).toBeCloseTo(computeRiskAdjustedScore(safe) * 0.85, 5);
  });

  it("sigma maior reduz o score (mais volatilidade = mais penalidade)", () => {
    const stable = makePool({ apy: 10, sigma: 0.5 });
    const volatile = makePool({ apy: 10, sigma: 5 });
    expect(computeRiskAdjustedScore(volatile)).toBeLessThan(computeRiskAdjustedScore(stable));
  });

  it("sigma null é neutro (equivalente a sigma=0, sem penalidade)", () => {
    const nullSigma = makePool({ apy: 10, sigma: null });
    const zeroSigma = makePool({ apy: 10, sigma: 0 });
    expect(computeRiskAdjustedScore(nullSigma)).toBeCloseTo(computeRiskAdjustedScore(zeroSigma), 5);
  });

  it("penaliza forte um APY muito acima da própria média de 30 dias (pico transitório)", () => {
    // caso real observado: WBTC-EVA em uniswap-v3 Arbitrum, apy=461% vs apyMean30d=45%
    const spike = makePool({ apy: 461.04, tvlUsd: 90_594, ilRisk: "yes", sigma: 0.676, apyMean30d: 45.07 });
    const withoutSpike = makePool({ apy: 461.04, tvlUsd: 90_594, ilRisk: "yes", sigma: 0.676, apyMean30d: null });
    // sem o fator de consistência o score bruto seria ~42; com ele, cai bem abaixo disso
    expect(computeRiskAdjustedScore(spike)).toBeLessThan(computeRiskAdjustedScore(withoutSpike) * 0.2);
  });

  it("não penaliza quando o APY atual já está em linha com a média de 30 dias", () => {
    const consistent = makePool({ apy: 10, apyMean30d: 10 });
    expect(computeRiskAdjustedScore(consistent)).toBeCloseTo(10, 5);
  });

  it("não recompensa estar abaixo da própria média (fator nunca passa de 1)", () => {
    const belowMean = makePool({ apy: 5, apyMean30d: 20 });
    expect(computeRiskAdjustedScore(belowMean)).toBeCloseTo(5, 5);
  });

  it("apyMean30d ausente é neutro (sem penalidade)", () => {
    const withMean = makePool({ apy: 10, apyMean30d: 10 });
    const withoutMean = makePool({ apy: 10, apyMean30d: null });
    expect(computeRiskAdjustedScore(withoutMean)).toBeCloseTo(computeRiskAdjustedScore(withMean), 5);
  });
});

describe("rankByRiskAdjustedYield", () => {
  it("ordena por score decrescente, não por APY bruto", () => {
    const highApyRisky = makePool({ poolId: "risky", apy: 50, tvlUsd: 10_000, ilRisk: "yes", sigma: 8 });
    const lowerApySafe = makePool({ poolId: "safe", apy: 12, tvlUsd: 2_000_000, ilRisk: "no", sigma: 0.2 });

    const ranked = rankByRiskAdjustedYield([highApyRisky, lowerApySafe]);

    expect(ranked[0]?.poolId).toBe("safe");
    expect(ranked[1]?.poolId).toBe("risky");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("preserva todos os campos originais do pool no resultado", () => {
    const pool = makePool({ poolId: "abc", symbol: "WBTC-WETH" });
    const [ranked] = rankByRiskAdjustedYield([pool]);
    expect(ranked?.symbol).toBe("WBTC-WETH");
    expect(typeof ranked?.score).toBe("number");
  });
});

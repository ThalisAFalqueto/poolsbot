import { describe, expect, it } from "vitest";
import { isEligiblePool, MAX_APY_VS_MEAN30D_RATIO, MIN_TVL_USD } from "../../../src/domain/yield-optimizer/eligibility.js";
import type { RankablePool } from "../../../src/domain/pools/types.js";

function makePool(overrides: Partial<RankablePool> = {}): RankablePool {
  return {
    poolId: "pool-1",
    chain: "arbitrum",
    project: "uniswap-v3",
    symbol: "WBTC-USDC",
    apy: 10,
    tvlUsd: 5_000_000,
    ilRisk: "no",
    sigma: null,
    apyMean30d: 10,
    ...overrides,
  };
}

describe("isEligiblePool", () => {
  it("exclui pool com TVL abaixo do piso", () => {
    expect(isEligiblePool(makePool({ tvlUsd: MIN_TVL_USD - 1 }))).toBe(false);
  });

  it("inclui pool com TVL exatamente no piso", () => {
    expect(isEligiblePool(makePool({ tvlUsd: MIN_TVL_USD }))).toBe(true);
  });

  it("exclui pool com APY muito acima da própria média de 30d", () => {
    const pool = makePool({ apyMean30d: 10, apy: 10 * MAX_APY_VS_MEAN30D_RATIO + 0.01 });
    expect(isEligiblePool(pool)).toBe(false);
  });

  it("inclui pool com APY dentro do limite vs. média de 30d", () => {
    const pool = makePool({ apyMean30d: 10, apy: 10 * MAX_APY_VS_MEAN30D_RATIO });
    expect(isEligiblePool(pool)).toBe(true);
  });

  it("não exclui por APY quando apyMean30d é null (dado ausente, tratamento neutro)", () => {
    const pool = makePool({ apyMean30d: null, apy: 999 });
    expect(isEligiblePool(pool)).toBe(true);
  });

  it("não exclui por APY quando apyMean30d é 0 (evita divisão/comparação degenerada)", () => {
    const pool = makePool({ apyMean30d: 0, apy: 50 });
    expect(isEligiblePool(pool)).toBe(true);
  });

  it("pool saudável (TVL alto, APY consistente com a média) é elegível", () => {
    expect(isEligiblePool(makePool())).toBe(true);
  });
});

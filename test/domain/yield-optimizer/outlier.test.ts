import { describe, expect, it } from "vitest";
import { shouldDropAsOutlier } from "../../../src/domain/yield-optimizer/outlier.js";

describe("shouldDropAsOutlier", () => {
  it("pool não marcada passa, seja qual for o protocolo", () => {
    for (const project of ["uniswap-v3", "uniswap-v4", "aave-v3", "camelot-v3"]) {
      expect(shouldDropAsOutlier({ project, outlier: false })).toBe(false);
    }
  });

  // O caso que motivou tudo: a maior pool ETH/USDC da Arbitrum (WETH-USDC v3
  // 0.05%, $36,1M) e a maior da Base ($116,7M) estavam sendo descartadas por
  // um flag derivado do apyBase — o mesmo número que já decidimos não usar.
  it("ignora o flag em pool que o bot mede on-chain", () => {
    expect(shouldDropAsOutlier({ project: "uniswap-v3", outlier: true })).toBe(false);
    expect(shouldDropAsOutlier({ project: "uniswap-v4", outlier: true })).toBe(false);
  });

  // Onde o número exibido vem da DefiLlama, o julgamento deles é a única
  // defesa que temos — continua valendo.
  it("respeita o flag em pool que o bot NÃO mede", () => {
    for (const project of ["aave-v3", "curve-dex", "gmx-v2-perps", "pancakeswap-amm", "camelot-v3"]) {
      expect(shouldDropAsOutlier({ project, outlier: true }), project).toBe(true);
    }
  });

  // Reconhecer como concentrada não basta: o que libera o flag é o bot
  // conseguir MEDIR. PancakeSwap e Camelot são concentradas de verdade, mas
  // sem factory conferida o bot depende do número da DefiLlama pra elas.
  it("concentrada mas não medível continua sujeita ao flag", () => {
    expect(shouldDropAsOutlier({ project: "pancakeswap-amm", outlier: true })).toBe(true);
    expect(shouldDropAsOutlier({ project: "sushiswap-v3", outlier: true })).toBe(true);
  });
});

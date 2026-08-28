import { describe, expect, it } from "vitest";
import {
  isConcentrated,
  isMeasurableConcentrated,
  MEASURABLE_CONCENTRATED_PROJECTS,
} from "../../../src/domain/yield-optimizer/concentrated.js";

describe("liquidez concentrada", () => {
  it("reconhece o que o bot sabe medir", () => {
    for (const p of MEASURABLE_CONCENTRATED_PROJECTS) {
      expect(isMeasurableConcentrated(p)).toBe(true);
      expect(isConcentrated(p)).toBe(true);
    }
  });

  // Distinção que importa: reconhecer sem saber medir permite dizer "achei N
  // e não consegui medir" em vez de fingir que não existem.
  it("reconhece concentrado que ainda não sabe medir", () => {
    expect(isConcentrated("pancakeswap-amm")).toBe(true);
    expect(isMeasurableConcentrated("pancakeswap-amm")).toBe(false);
  });

  // Empréstimo, renda fixa tokenizada, perp e AMM de curva inteira ficam fora
  // do /yield: medido na Arbitrum em 28/08/2026, o teto deles era 13,8%/ano.
  // Pra AMM não concentrada o apyBase da DefiLlama já é o número certo — toda
  // a liquidez trabalha, então não há o viés de TVL que motivou tudo isso.
  it("deixa de fora o que não é liquidez concentrada", () => {
    for (const p of ["aave-v3", "compound-v3", "morpho-blue", "gmx-v2-perps", "pendle", "curve-dex", "camelot-v2", "blackrock-buidl"]) {
      expect(isConcentrated(p), p).toBe(false);
    }
  });

  it("não casa por prefixo nem por nome parecido", () => {
    expect(isConcentrated("uniswap-v2")).toBe(false);
    expect(isConcentrated("uniswap")).toBe(false);
    expect(isConcentrated("")).toBe(false);
  });
});

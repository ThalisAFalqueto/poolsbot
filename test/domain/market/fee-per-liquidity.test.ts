import { describe, expect, it } from "vitest";
import {
  DEFAULT_REFERENCE,
  liquidityForValue,
  measureYield,
  type FeeGrowthWindow,
} from "../../../src/domain/market/fee-per-liquidity.js";

// Números reais da posição do usuário (Uniswap V3 #5674258, WBTC/USDC 0.05%
// na Arbitrum, lida on-chain em 28/08/2026) — servem de âncora pra que os
// testes não validem só a consistência interna da fórmula.
const TICK_ATUAL = 66791;
const SQRT_P_RAW = Math.sqrt(1.0001 ** TICK_ATUAL);
const DECIMALS_USDC = 6;

describe("liquidityForValue", () => {
  // Confere contra a forma EXATA das fórmulas canônicas do V3
  // (V = L/10^d1 · (2√p − √pa − p/√pb)), não contra o próprio atalho.
  it("bate com a forma exata das fórmulas do Uniswap V3", () => {
    const p = 1.0001 ** TICK_ATUAL;
    for (const delta of [0.01, 0.03, 0.1]) {
      const pa = p * Math.exp(-delta);
      const pb = p * Math.exp(delta);
      const exato = (1000 * 10 ** DECIMALS_USDC) / (2 * Math.sqrt(p) - Math.sqrt(pa) - p / Math.sqrt(pb));
      expect(liquidityForValue(1000, SQRT_P_RAW, delta, DECIMALS_USDC)).toBeCloseTo(exato, 0);
    }
  });

  // A concentração é o mecanismo central de uma posição V3: mesmo capital,
  // faixa mais estreita, mais liquidez — e por isso mais taxa por dólar.
  it("faixa mais estreita produz mais liquidez com o mesmo capital", () => {
    const estreita = liquidityForValue(1000, SQRT_P_RAW, 0.01, DECIMALS_USDC);
    const larga = liquidityForValue(1000, SQRT_P_RAW, 0.1, DECIMALS_USDC);
    expect(estreita).toBeGreaterThan(larga);
    // ~10x mais estreita ≈ ~10x mais liquidez (relação quase linear em δ pequeno)
    expect(estreita / larga).toBeGreaterThan(8);
  });

  it("liquidez escala com o capital", () => {
    const a = liquidityForValue(1000, SQRT_P_RAW, 0.03, DECIMALS_USDC);
    const b = liquidityForValue(2000, SQRT_P_RAW, 0.03, DECIMALS_USDC);
    expect(b / a).toBeCloseTo(2, 6);
  });

  it("faixa degenerada não estoura", () => {
    expect(liquidityForValue(1000, SQRT_P_RAW, 0, DECIMALS_USDC)).toBe(0);
  });
});

describe("measureYield", () => {
  // Reproduz a medição real de 28/08/2026: a pool V3 0.05% da Arbitrum pagou
  // ~2,3e-9 dólares por unidade de liquidez por dia.
  const janela: FeeGrowthWindow = { perLiquidity0: 4.3e-14, perLiquidity1: 3.5e-9, days: 3 };
  const PRECO = 80_427;

  it("devolve null quando a janela não tem duração", () => {
    expect(measureYield({ ...janela, days: 0 }, SQRT_P_RAW, PRECO, DECIMALS_USDC)).toBeNull();
  });

  it("converte a perna de token0 pelo preço antes de somar", () => {
    const so1 = measureYield({ perLiquidity0: 0, perLiquidity1: 3.5e-9, days: 3 }, SQRT_P_RAW, PRECO, DECIMALS_USDC)!;
    const ambas = measureYield(janela, SQRT_P_RAW, PRECO, DECIMALS_USDC)!;
    expect(ambas.perLiquidityPerDay).toBeCloseTo(so1.perLiquidityPerDay + (4.3e-14 * PRECO) / 3, 15);
  });

  // O ponto do módulo inteiro: o APR não depende do TAMANHO da posição de
  // referência (as unidades se cancelam), só da LARGURA. Se isso quebrar, a
  // comparação entre pools deixa de fazer sentido.
  it("APR independe do tamanho da posição de referência", () => {
    const mil = measureYield(janela, SQRT_P_RAW, PRECO, DECIMALS_USDC, { valueToken1: 1000, halfWidthLog: 0.03 })!;
    const cem_mil = measureYield(janela, SQRT_P_RAW, PRECO, DECIMALS_USDC, { valueToken1: 100_000, halfWidthLog: 0.03 })!;
    expect(cem_mil.aprInRange).toBeCloseTo(mil.aprInRange, 8);
  });

  it("APR sobe quando a faixa de referência aperta", () => {
    const larga = measureYield(janela, SQRT_P_RAW, PRECO, DECIMALS_USDC, { valueToken1: 1000, halfWidthLog: 0.1 })!;
    const estreita = measureYield(janela, SQRT_P_RAW, PRECO, DECIMALS_USDC, { valueToken1: 1000, halfWidthLog: 0.01 })!;
    expect(estreita.aprInRange).toBeGreaterThan(larga.aprInRange);
  });

  // Ancorado na medição real de 28/08/2026: a pool pagava ~2,3e-9 por unidade
  // de liquidez por dia, e as 4 pools medidas do par deram 97%-105% ao ano
  // pra referência de $1.000 em ±3%. Se esse teste quebrar, ou a fórmula
  // mudou ou a unidade de feeGrowth mudou — nos dois casos o /comparar passa
  // a mentir, então o intervalo aqui é apertado de propósito.
  it("reproduz o número medido ao vivo no WBTC/USDC", () => {
    const r = measureYield(janela, SQRT_P_RAW, PRECO, DECIMALS_USDC, DEFAULT_REFERENCE)!;
    expect(r.perLiquidityPerDay).toBeCloseTo(2.32e-9, 10);
    expect(r.aprInRange).toBeGreaterThan(0.9);
    expect(r.aprInRange).toBeLessThan(1.15);
  });
});

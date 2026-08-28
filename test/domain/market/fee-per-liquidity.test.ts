import { describe, expect, it } from "vitest";
import {
  DEFAULT_REFERENCE,
  daysToLeaveRange,
  liquidityForValue,
  lvrAprForWidth,
  lvrPerDay,
  measureYield,
  netYield,
  volatilityFromTicks,
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
  // ~2,3e-9 dólares por unidade de liquidez por dia, com 1,79 trilhão de
  // liquidez ativa no tick corrente (lida do contrato).
  const janela: FeeGrowthWindow = { perLiquidity0: 4.3e-14, perLiquidity1: 3.5e-9, days: 3 };
  const PRECO = 80_427;
  const L_ATIVA_REAL = 1_791_084_760_921;

  const medir = (ref = DEFAULT_REFERENCE, ativa: number | null = L_ATIVA_REAL) =>
    measureYield(janela, SQRT_P_RAW, PRECO, DECIMALS_USDC, ref, ativa);

  it("devolve null quando a janela não tem duração", () => {
    expect(measureYield({ ...janela, days: 0 }, SQRT_P_RAW, PRECO, DECIMALS_USDC, DEFAULT_REFERENCE, L_ATIVA_REAL)).toBeNull();
  });

  // Sem a liquidez ativa não dá pra saber se a entrada dilui o próprio
  // retorno. Assumir que não dilui foi exatamente o erro corrigido — então a
  // ausência do dado tem que virar "não medi", nunca um número otimista.
  it("recusa a medir sem a liquidez ativa", () => {
    expect(medir(DEFAULT_REFERENCE, null)).toBeNull();
    expect(medir(DEFAULT_REFERENCE, 0)).toBeNull();
  });

  it("converte a perna de token0 pelo preço antes de somar", () => {
    const so1 = measureYield({ perLiquidity0: 0, perLiquidity1: 3.5e-9, days: 3 }, SQRT_P_RAW, PRECO, DECIMALS_USDC, DEFAULT_REFERENCE, L_ATIVA_REAL)!;
    expect(medir()!.perLiquidityPerDay).toBeCloseTo(so1.perLiquidityPerDay + (4.3e-14 * PRECO) / 3, 15);
  });

  it("APR sobe quando a faixa de referência aperta", () => {
    const larga = medir({ valueToken1: 1000, halfWidthLog: 0.1 })!;
    const estreita = medir({ valueToken1: 1000, halfWidthLog: 0.01 })!;
    expect(estreita.aprInRange).toBeGreaterThan(larga.aprInRange);
  });

  // Ancorado na medição real: 100%/ano pra $1.000 em ±3% na pool do usuário,
  // com fatia de 0,06% da liquidez ativa. Se isso quebrar, ou a fórmula mudou
  // ou a unidade de feeGrowth mudou — nos dois casos o /yield e o /comparar
  // passam a mentir, então o intervalo é apertado de propósito.
  it("reproduz o número medido ao vivo no WBTC/USDC", () => {
    const r = medir()!;
    expect(r.perLiquidityPerDay).toBeCloseTo(2.32e-9, 10);
    expect(r.referenceShare).toBeCloseTo(0.00066, 4);
    expect(r.aprInRange).toBeGreaterThan(0.9);
    expect(r.aprInRange).toBeLessThan(1.15);
  });

  describe("diluição", () => {
    // Em pool FUNDO a entrada não muda o denominador, e o APR continua sendo
    // uma propriedade do pool — é o que torna a comparação entre pools válida.
    it("em pool fundo, o APR quase não depende do tamanho da posição", () => {
      const mil = medir({ valueToken1: 1000, halfWidthLog: 0.03 })!;
      const dezMil = medir({ valueToken1: 10_000, halfWidthLog: 0.03 })!;
      expect(dezMil.aprInRange / mil.aprInRange).toBeGreaterThan(0.99);
    });

    // Em pool RASO ele depende, e muito. Caso real que motivou a correção: um
    // WETH-GMX com volume ~zero aparecia com 212%/ano porque $1.000 seriam 91%
    // da liquidez ativa — retorno que não sobrevive à própria entrada.
    it("em pool raso, entrar dilui o próprio retorno", () => {
      const L_RASA = 1e8;
      const r = medir(DEFAULT_REFERENCE, L_RASA)!;
      expect(r.referenceShare).toBeGreaterThan(0.9);
      const semDiluir = medir(DEFAULT_REFERENCE, L_ATIVA_REAL)!;
      expect(r.aprInRange).toBeLessThan(semDiluir.aprInRange);
    });

    // O teto físico: por mais liquidez que você ponha, não dá pra ganhar mais
    // do que o pool inteiro arrecadou. A fórmula ingênua estourava isso.
    it("nunca promete mais do que o pool arrecadou no período", () => {
      const L_RASA = 1;
      const r = medir({ valueToken1: 1_000_000, halfWidthLog: 0.03 }, L_RASA)!;
      const totalDoPool = medir()!.perLiquidityPerDay * L_RASA;
      expect(r.dailyFees).toBeLessThanOrEqual(totalDoPool * 1.000001);
    });
  });
});

describe("volatilityFromTicks", () => {
  const serie = (ticks: number[], passoHoras = 8) =>
    ticks.map((tick, i) => ({ tick, seconds: 1_787_000_000 + i * passoHoras * 3600 }));

  it("amostra curta demais devolve null em vez de um número inventado", () => {
    expect(volatilityFromTicks(serie([100, 200]))).toBeNull();
  });

  it("preço parado tem volatilidade zero", () => {
    expect(volatilityFromTicks(serie([100, 100, 100, 100, 100]))).toBeCloseTo(0, 12);
  });

  // Tendência CONSTANTE não é volatilidade: os retornos são todos iguais, e o
  // desvio-padrão deles é zero. Confundir os dois inflaria σ em par com drift.
  it("tendência constante não vira volatilidade", () => {
    expect(volatilityFromTicks(serie([100, 200, 300, 400, 500]))).toBeCloseTo(0, 12);
  });

  it("mais oscilação, mais volatilidade", () => {
    const calmo = volatilityFromTicks(serie([100, 110, 100, 110, 100]))!;
    const agitado = volatilityFromTicks(serie([100, 900, 100, 900, 100]))!;
    expect(agitado).toBeGreaterThan(calmo);
  });

  // Cross-check independente: σ do WBTC/USDC medido por AMOSTRAGEM DE TICKS
  // deu 1,4%/dia, contra 1,67%-2,0% medido pelo histórico de preço do banco
  // (range-from-history.ts). Caminhos separados, mesma ordem de grandeza.
  it("reproduz a ordem de grandeza do WBTC/USDC", () => {
    // ~1,4%/dia em log-preço = ~140 ticks por dia de desvio
    const ticks = [66_700, 66_820, 66_760, 66_900, 66_840, 66_960, 66_890];
    const sigma = volatilityFromTicks(ticks.map((tick, i) => ({ tick, seconds: 1_787_000_000 + i * 12 * 3600 })))!;
    expect(sigma).toBeGreaterThan(0.005);
    expect(sigma).toBeLessThan(0.05);
  });
});

describe("daysToLeaveRange", () => {
  it("é a inversa exata do move = σ√t usado no /range", () => {
    const sigma = 0.0167;
    for (const dias of [1, 3, 7]) {
      const move = sigma * Math.sqrt(dias);
      expect(daysToLeaveRange(sigma, move)).toBeCloseTo(dias, 6);
    }
  });

  it("par mais volátil gasta a faixa mais rápido", () => {
    expect(daysToLeaveRange(0.15, 0.03)!).toBeLessThan(daysToLeaveRange(0.015, 0.03)!);
  });

  // Os dois casos reais lado a lado (28/08): RAIN-USDT com σ 13,9%/dia gasta
  // ±3% em ~1h; WBTC/USDC com σ 1,4%/dia leva dias.
  it("separa 'dura horas' de 'dura dias', que é a distinção que importa", () => {
    expect(daysToLeaveRange(0.139, 0.03)! * 24).toBeLessThan(2);
    expect(daysToLeaveRange(0.014, 0.03)!).toBeGreaterThan(2);
  });

  it("volatilidade zero não vira divisão por zero", () => {
    expect(daysToLeaveRange(0, 0.03)).toBeNull();
  });
});

describe("LVR", () => {
  // A âncora mais forte que existe: pro caso full-range (CPMM) a fórmula do V3
  // TEM que recair no resultado canônico do paper, σ²·V/8. Se este teste
  // quebrar, a derivação está errada e todo número de custo do bot mente.
  it("recai em σ²·V/8 no caso full-range, que é o resultado canônico", () => {
    const k = 1e12;
    const p = 100;
    const L = Math.sqrt(k); // CPMM: L = √k
    const V = 2 * L * Math.sqrt(p); // valor do pool em token1
    for (const sigma of [0.01, 0.05, 0.2]) {
      expect(lvrPerDay(sigma, L, Math.sqrt(p), 0)).toBeCloseTo((sigma ** 2 * V) / 8, 6);
    }
  });

  it("custo cresce com o QUADRADO da volatilidade", () => {
    const base = lvrAprForWidth(0.01, 0.03);
    expect(lvrAprForWidth(0.02, 0.03) / base).toBeCloseTo(4, 6);
    expect(lvrAprForWidth(0.03, 0.03) / base).toBeCloseTo(9, 6);
  });

  it("faixa mais estreita custa mais, na mesma proporção em que rende mais", () => {
    expect(lvrAprForWidth(0.014, 0.01)).toBeGreaterThan(lvrAprForWidth(0.014, 0.1));
  });

  // As duas formas têm que concordar: a fechada (só σ e largura) é a direta
  // com a liquidez da posição de referência substituída, e o preço cancela.
  it("a forma fechada concorda com a direta, e independe do preço", () => {
    const sigma = 0.014;
    const delta = 0.03;
    for (const tick of [66_791, 100_000, 10_000]) {
      const sqrtP = Math.sqrt(1.0001 ** tick);
      const L = liquidityForValue(1000, sqrtP, delta, 6);
      const direto = (lvrPerDay(sigma, L, sqrtP, 6) * 365) / 1000;
      expect(direto).toBeCloseTo(lvrAprForWidth(sigma, delta), 6);
    }
  });

  // Números reais da posição do usuário (28/08): σ 1,4%/dia, faixa ±3%.
  it("reproduz o custo medido na posição do usuário", () => {
    expect(lvrAprForWidth(0.014, 0.03)).toBeCloseTo(0.6, 1);
  });

  it("volatilidade zero não gera custo", () => {
    expect(lvrAprForWidth(0, 0.03)).toBe(0);
    expect(lvrPerDay(0, 1e9, 28, 6)).toBe(0);
  });
});

describe("netYield", () => {
  const medida = {
    perLiquidityPerDay: 2.32e-9,
    dailyFees: 2.74,
    aprInRange: 1.0,
    days: 3,
    referenceShare: 0.00066,
  };

  // Sem σ não dá pra estimar o custo — e mostrar só a receita foi exatamente o
  // erro que este módulo corrige. Devolver null força quem exibe a dizer
  // "não sei" em vez de imprimir um número otimista.
  it("recusa a dar resultado líquido sem volatilidade", () => {
    expect(netYield(medida, null)).toBeNull();
    expect(netYield(medida, 0)).toBeNull();
  });

  // Caso real: WBTC-USDC pagava 100%/ano de taxa e custava ~60%/ano de LVR.
  it("desconta o custo da receita", () => {
    const r = netYield(medida, 0.014)!;
    expect(r.lvrApr).toBeCloseTo(0.6, 1);
    expect(r.netApr).toBeCloseTo(1.0 - r.lvrApr, 10);
  });

  // O achado que motivou tudo: par volátil rende muito e custa mais ainda.
  // RAIN-USDT tinha 1680%/ano de taxa e σ de ~14,7%/dia — líquido MUITO
  // negativo. O líquido precisa poder ser negativo, sem piso em zero.
  it("deixa o líquido ficar negativo quando o custo passa a receita", () => {
    const r = netYield({ ...medida, aprInRange: 16.8 }, 0.147)!;
    expect(r.netApr).toBeLessThan(-10);
  });
});

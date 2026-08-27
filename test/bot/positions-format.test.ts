import { describe, expect, it } from "vitest";
import {
  buildPortfolioSummary,
  buildPositionBlock,
  chunkLines,
  formatAgeLine,
  formatAprLine,
  formatHoldLine,
  formatPoolStatsLine,
  MAX_MESSAGE_CHARS,
  type FeesAmounts,
  type SummaryEntry,
} from "../../src/bot/commands/positions.js";
import type { AprResult } from "../../src/domain/lp-rebalance/calculate-apr.js";
import type { ImpermanentLossResult } from "../../src/domain/lp-rebalance/calculate-il.js";
import type { PnlResult } from "../../src/domain/lp-rebalance/calculate-pnl.js";
import type { OnchainPosition } from "../../src/domain/lp-rebalance/types.js";

// Testes da camada que MONTA O TEXTO das mensagens. Ela não tinha nenhum, e
// foi exatamente onde apareceram os dois bugs que o usuário pegou sozinho
// lendo o Telegram: um alerta dizendo "APY caiu -31%" numa ALTA (corrigido em
// domain/alerts/format-reason.ts, já com teste próprio) e um P&L total que não
// fechava com a soma das parcelas mostradas na mesma tela.
//
// A lógica financeira já é testada em test/domain; aqui o alvo é o que o
// usuário de fato lê.

const POSITION: OnchainPosition = {
  chain: "arbitrum",
  walletAddress: "0x7965325940d61cccbe5614b3f9cc6c3d8b911404",
  tokenId: 198755n,
  protocol: "v4",
  poolAddress: "0x80c735c5a0222241f211b3edb8df2ccefad94553ec18f1c29143f0399c78f500",
  fee: 500,
  tickSpacing: 10,
  tickLower: 66200,
  tickUpper: 66790,
  currentTick: 66497,
  sqrtPriceX96: 2201824748334830636609798454833n,
  liquidity: 56666324n,
  token0: { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, symbol: "WBTC" },
  token1: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, symbol: "USDC" },
};

const IL: ImpermanentLossResult = {
  ilPct: -0.0029,
  hodlValueToken1: 46.543,
  positionValueToken1: 46.408,
  baselineAmount0: 0.00029151,
  baselineAmount1: 23.5994,
  currentAmount0: 0.0001034,
  currentAmount1: 38.2698,
  since: new Date("2026-08-23T18:30:51Z"),
};

// Números REAIS da posição do usuário (26/08/2026) — usar valores de verdade
// aqui é o que faz o teste de reconciliação abaixo significar alguma coisa.
const PNL: PnlResult = {
  entryValueToken1: 46.1236,
  hodlValueToken1: 46.5432,
  positionValueToken1: 46.4078,
  feesValueToken1: 0.3065,
  priceMovementToken1: 0.4195,
  ilToken1: -0.1353,
  principalPnlToken1: 0.2842,
  totalPnlToken1: 0.5907,
};

const FEES: FeesAmounts = { amount0: 0.0000086, amount1: 0.2803 };

function makeApr(overrides: Partial<AprResult> = {}): AprResult {
  return {
    reliable: true,
    unreliableReason: null,
    elapsedDays: 3.2,
    simpleReturnPct: 0.0128,
    monthlyEquivalentPct: 0.12,
    annualizedPct: 1.46,
    ...overrides,
  };
}

function block(overrides: { pnl?: PnlResult | null; fees?: FeesAmounts | null; apr?: AprResult | null } = {}) {
  return buildPositionBlock(
    POSITION,
    IL,
    overrides.pnl === undefined ? PNL : overrides.pnl,
    overrides.fees === undefined ? FEES : overrides.fees,
    false,
    null,
    overrides.apr === undefined ? makeApr() : overrides.apr,
    makeApr(),
    undefined
  );
}

describe("buildPositionBlock", () => {
  // ESTE é o teste que teria pego o bug que o usuário achou fazendo a conta na
  // mão: ele somou IL + fees, não bateu com o P&L total, e o motivo era um
  // terceiro termo (movimento de mercado) que não aparecia em lugar nenhum.
  it("os três termos mostrados somam exatamente o P&L total", () => {
    const line = block()
      .split("\n")
      .find((l) => l.includes("P&L total"));
    expect(line).toBeDefined();

    const match = /\(mercado ([+-][\d.]+) \+ IL ([+-][\d.]+) \+ fees ([+-][\d.]+)\)/.exec(line!);
    expect(match, `linha sem a decomposição: ${line}`).not.toBeNull();

    const [mercado, il, fees] = [Number(match![1]), Number(match![2]), Number(match![3])];
    const totalMatch = /P&L total \(com fees\): ([+-][\d.]+)/.exec(line!);
    const total = Number(totalMatch![1]);

    // Tolerância de 1 centavo: cada parcela é arredondada pra 2 casas antes de
    // virar texto, então a soma do que está NA TELA pode diferir do total no
    // último dígito. O que não pode é divergir de verdade.
    expect(mercado + il + fees).toBeCloseTo(total, 2);
  });

  it("marca posição V4 com a tag [V4] e mostra o tokenId junto do par", () => {
    const header = block().split("\n")[0]!;
    expect(header).toContain("WBTC/USDC #198755");
    expect(header).toContain("[V4]");
  });

  it("posição V3 não recebe tag (V3 é o caso comum)", () => {
    const v3 = buildPositionBlock(
      { ...POSITION, protocol: "v3" },
      IL,
      PNL,
      FEES,
      false,
      null,
      makeApr(),
      makeApr(),
      undefined
    );
    expect(v3.split("\n")[0]).not.toContain("[V4]");
  });

  // "Nunca inventar número" é regra do projeto: sem fees, o texto tem que
  // dizer que não sabe, não cair num valor plausível.
  it("sem fees conhecidas, diz 'indisponível' em vez de exibir zero", () => {
    const text = block({ pnl: null, fees: null });
    expect(text).toContain("indisponível");
    expect(text).not.toMatch(/P&L total \(com fees\): \+0\.00/);
  });

  it("sinaliza fora de faixa com 🚨 e dentro com ✅", () => {
    const dentro = block().split("\n")[0]!;
    expect(dentro.startsWith("✅")).toBe(true);

    const fora = buildPositionBlock(
      { ...POSITION, currentTick: 70000 }, // acima do tickUpper
      IL,
      PNL,
      FEES,
      false,
      null,
      makeApr(),
      makeApr(),
      undefined
    );
    expect(fora.split("\n")[0]!.startsWith("🚨")).toBe(true);
  });
});

describe("formatHoldLine", () => {
  it("vs HOLD é IL + fees (fee que supera o IL vira resultado positivo)", () => {
    const line = formatHoldLine(PNL, "USDC");
    // -0.1353 + 0.3065 = +0.1712
    expect(line).toContain("+0.17");
  });

  it("sem P&L, admite que não sabe", () => {
    expect(formatHoldLine(null, "USDC")).toContain("indisponível");
  });
});

describe("formatAprLine / formatAgeLine", () => {
  it("posição nova demais não recebe um número extrapolado", () => {
    const line = formatAprLine(makeApr({ reliable: false, unreliableReason: "too_new", elapsedDays: 0.5 }), "APR");
    expect(line).toContain("cedo demais");
    expect(line).not.toContain("%/mês");
  });

  it("retorno absurdo é marcado como não confiável em vez de exibido", () => {
    const line = formatAprLine(makeApr({ reliable: false, unreliableReason: "implausible" }), "APR");
    expect(line).toContain("não confiável");
  });

  it("idade abaixo de 1 dia aparece em horas", () => {
    expect(formatAgeLine(makeApr({ elapsedDays: 0.25 }))).toBe("Idade: 6h");
  });
});

describe("formatPoolStatsLine", () => {
  it("pool não encontrado na DefiLlama é declarado, não omitido", () => {
    expect(formatPoolStatsLine(undefined)).toContain("indisponível");
  });
});

describe("buildPortfolioSummary", () => {
  function entry(overrides: Partial<SummaryEntry> = {}): SummaryEntry {
    return {
      token1Address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      token1Symbol: "USDC",
      entryValue: 100,
      currentValue: 103,
      feesValue: 1,
      totalPnl: 4,
      monthlyEquivalentPnl: 4,
      ...overrides,
    };
  }

  // O projeto se recusa a somar moedas diferentes sem oráculo de USD — o
  // resumo agrupa por moeda de cotação em vez de dar um total único.
  it("agrupa por moeda de cotação em vez de somar tudo num número só", () => {
    const lines = buildPortfolioSummary([
      entry(),
      entry({ token1Address: "0xother", token1Symbol: "WETH", entryValue: 2, totalPnl: 0.1, monthlyEquivalentPnl: 0.1 }),
    ]).join("\n");

    expect(lines).toContain("USDC");
    expect(lines).toContain("WETH");
  });

  it("compara contra a meta de 3%/mês", () => {
    const acima = buildPortfolioSummary([entry({ monthlyEquivalentPnl: 10 })]).join("\n");
    expect(acima).toContain("✅");

    const abaixo = buildPortfolioSummary([entry({ monthlyEquivalentPnl: 1 })]).join("\n");
    expect(abaixo).toContain("⚠️");
  });

  it("posição nova demais fica de fora da média, mas é contada à parte", () => {
    const lines = buildPortfolioSummary([entry({ monthlyEquivalentPnl: null })]).join("\n");
    expect(lines).toContain("indisponível");
    expect(lines).toContain("muito nova");
  });

  it("lista vazia não gera cabeçalho órfão", () => {
    expect(buildPortfolioSummary([])).toEqual([]);
  });
});

describe("chunkLines", () => {
  // Bug real de produção (20/08/2026): a mensagem estourou o limite do
  // Telegram. O risco pior não é o erro — é truncar e ESCONDER uma posição
  // fora de faixa sem ninguém perceber.
  it("nenhuma linha some na paginação", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `linha ${i} ${"x".repeat(100)}`);
    const pages = chunkLines(lines, MAX_MESSAGE_CHARS);
    expect(pages.flat()).toEqual(lines);
  });

  it("cada página respeita o teto de caracteres", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `linha ${i} ${"x".repeat(100)}`);
    for (const page of chunkLines(lines, MAX_MESSAGE_CHARS)) {
      expect(page.join("\n").length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    }
  });

  it("uma linha sozinha maior que o teto ainda é entregue (não é descartada)", () => {
    const gigante = "y".repeat(MAX_MESSAGE_CHARS + 500);
    expect(chunkLines([gigante], MAX_MESSAGE_CHARS).flat()).toEqual([gigante]);
  });

  it("poucas linhas cabem numa página só", () => {
    expect(chunkLines(["a", "b", "c"], MAX_MESSAGE_CHARS)).toHaveLength(1);
  });
});

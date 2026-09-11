import { describe, expect, it } from "vitest";
import { buildClosedBlock, formatFeesTotal, formatGasLine } from "../../src/bot/commands/closed.js";
import type { ClosedPositionRow } from "../../src/persistence/repositories/lp-positions.repository.js";

function makeRow(overrides: Partial<ClosedPositionRow> = {}): ClosedPositionRow {
  return {
    chain: "arbitrum",
    tokenId: "5658859",
    protocol: "v3",
    label: null,
    token0Symbol: "WBTC",
    token1Symbol: "USDC",
    token1Address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    openedAt: new Date("2026-08-20T14:00:00Z"),
    closedAt: new Date("2026-08-23T15:00:00Z"),
    entryValueToken1: 47.03,
    finalPositionValueToken1: 46.5,
    finalFeesValueToken1: 0.31,
    hodlValueToken1: 46.9,
    ilToken1: -0.4,
    totalPnlToken1: -0.22,
    mintGasNative: 0.0000077,
    mintGasTxHash: "0xabc",
    closeGasNative: 0.0000123,
    closeGasTxHashes: "0xdef",
    nativeGasSymbol: "ETH",
    receiptSource: "onchain",
    feesAmount0: 0.0000031,
    feesAmount1: 0.11,
    ...overrides,
  };
}

describe("formatGasLine", () => {
  it("soma abertura e fechamento no total", () => {
    const line = formatGasLine(makeRow(), null);
    // 0.0000077 + 0.0000123 = 0.00002
    expect(line).toContain("total 0.000020 ETH");
  });

  // formatPrice usa 2 casas e zeraria valores típicos de gas — por isso o gas
  // tem formatação própria com 6 casas.
  it("não arredonda gas até virar zero", () => {
    const line = formatGasLine(makeRow({ mintGasNative: 0.0000077, closeGasNative: null }), null);
    expect(line).toContain("0.000008");
    expect(line).not.toMatch(/abertura 0\.00 ETH/);
  });

  it("gas desconhecido é declarado, não vira zero", () => {
    const line = formatGasLine(makeRow({ mintGasNative: null, closeGasNative: null }), null);
    expect(line).toContain("abertura não disponível");
    expect(line).toContain("fechamento não disponível");
    expect(line).not.toContain("total");
  });

  it("só mostra o equivalente em token1 quando há preço; nunca inventa", () => {
    expect(formatGasLine(makeRow(), null)).not.toContain("≈");
    expect(formatGasLine(makeRow(), 2400)).toContain("≈");
  });
});

describe("buildClosedBlock", () => {
  it("usa o apelido quando existe, senão o tokenId", () => {
    expect(buildClosedBlock(makeRow({ label: "p1" }), null)).toContain("(p1)");
    expect(buildClosedBlock(makeRow({ label: null }), null)).toContain("(#5658859)");
  });

  it("marca V4 com tag, mesma convenção do /positions", () => {
    expect(buildClosedBlock(makeRow({ protocol: "v4" }), null)).toContain("[V4]");
    expect(buildClosedBlock(makeRow({ protocol: "v3" }), null)).not.toContain("[V4]");
  });

  it("vs HOLD é IL + fees", () => {
    // -0.4 + 0.31 = -0.09
    expect(buildClosedBlock(makeRow(), null)).toContain("vs HOLD: -0.09");
  });

  it("P&L negativo aparece com sinal, positivo com +", () => {
    expect(buildClosedBlock(makeRow({ totalPnlToken1: -0.22 }), null)).toContain("P&L total (com fees): -0.22");
    expect(buildClosedBlock(makeRow({ totalPnlToken1: 1.5 }), null)).toContain("P&L total (com fees): +1.50");
  });

  // A taxa em quantidade de cada token é o que dá pra conferir no explorer
  // (aba de tokens transferidos da tx de fechamento). Só existe quando o
  // recibo veio da chain.
  it("mostra a taxa em quantidade de cada token quando o recibo veio da chain", () => {
    expect(buildClosedBlock(makeRow(), null)).toContain("Fees recebidas: 0.31 USDC (0.00000310 WBTC + 0.110 USDC)");
  });

  // O defeito de 11/09/2026: recibo de snapshot é do último /positions, não do
  // fechamento. Onde ainda é o caso, o texto tem que dizer.
  it("recibo de snapshot avisa que pode estar defasado", () => {
    const bloco = buildClosedBlock(makeRow({ receiptSource: "snapshot", feesAmount0: null, feesAmount1: null }), null);
    expect(bloco).toContain("podem estar defasados");
    expect(bloco).not.toContain("WBTC +");
  });

  it("recibo antigo, sem fonte gravada, também avisa", () => {
    expect(buildClosedBlock(makeRow({ receiptSource: null, feesAmount0: null, feesAmount1: null }), null)).toContain("podem estar defasados");
  });

  // Taxa de WBTC fica abaixo de 1e-6, onde toPrecision vira notação
  // científica — saiu "3.30e-7 WBTC" no /closed real.
  it("taxa minúscula não vira notação científica", () => {
    const bloco = buildClosedBlock(makeRow({ feesAmount0: 3.3e-7, feesAmount1: 0.029 }), null);
    expect(bloco).toContain("0.000000330 WBTC");
    expect(bloco).not.toMatch(/e-\d/);
  });

  it("recibo on-chain não carrega o aviso", () => {
    expect(buildClosedBlock(makeRow(), null)).not.toContain("defasados");
  });
});

describe("formatFeesTotal", () => {
  it("soma as taxas de todas as posições fechadas", () => {
    const total = formatFeesTotal([makeRow({ finalFeesValueToken1: 1.86 }), makeRow({ finalFeesValueToken1: 0.83 })]);
    expect(total).toContain("2.69 USDC em 2 posições");
  });

  // Somar USDC com WETH não quer dizer nada.
  it("separa por token1 em vez de misturar moedas", () => {
    const total = formatFeesTotal([makeRow({ finalFeesValueToken1: 1 }), makeRow({ token1Symbol: "WETH", finalFeesValueToken1: 0.001 })])!;
    expect(total).toContain("1.00 USDC em 1 posição");
    expect(total).toContain("0.00 WETH em 1 posição");
  });

  it("diz quantas parcelas da soma vieram de snapshot", () => {
    const total = formatFeesTotal([makeRow(), makeRow({ receiptSource: "snapshot" })]);
    expect(total).toContain("1 com valor de snapshot");
  });

  it("sem posição fechada não há total", () => {
    expect(formatFeesTotal([])).toBeNull();
  });
});

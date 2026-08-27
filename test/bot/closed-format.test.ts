import { describe, expect, it } from "vitest";
import { buildClosedBlock, formatGasLine } from "../../src/bot/commands/closed.js";
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
});

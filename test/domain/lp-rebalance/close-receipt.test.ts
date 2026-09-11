import { describe, expect, it } from "vitest";
import { calculateCloseReceipt, type LiquidityEvent } from "../../../src/domain/lp-rebalance/close-receipt.js";

// Eventos REAIS da WETH/USDC #5683732 na Arbitrum, lidos da chain em
// 11/09/2026 (tx de mint 0x14c58559…, de fechamento 0xdca58a80…). É o caso
// que expôs o bug: o /closed mostrava final 107,58 e fees 1,57 a partir do
// snapshot do último /positions.
const mint: LiquidityEvent = {
  kind: "increase",
  amount0: 0.014224262638705534,
  amount1: 72.87078,
  price: 2480.42,
  at: new Date("2026-09-05T21:26:51Z"),
  txHash: "0x14c58559",
};
const burn: LiquidityEvent = {
  kind: "decrease",
  amount0: 0.009446870799313524,
  amount1: 84.760112,
  price: 2496.94,
  at: new Date("2026-09-11T13:13:05Z"),
  txHash: "0xdca58a80",
};
const collect: LiquidityEvent = { ...burn, kind: "collect", amount0: 0.009819900590561593, amount1: 85.689171 };

describe("calculateCloseReceipt", () => {
  it("reproduz o recibo real da #5683732", () => {
    const r = calculateCloseReceipt([mint, burn, collect])!;
    expect(r.entryValueToken1).toBeCloseTo(108.15, 2);
    expect(r.finalPositionValueToken1).toBeCloseTo(108.35, 2);
    expect(r.finalFeesValueToken1).toBeCloseTo(1.86, 2);
    expect(r.hodlValueToken1).toBeCloseTo(108.39, 2);
    expect(r.totalPnlToken1).toBeCloseTo(2.06, 2);
    expect(r.openedAt.toISOString()).toBe("2026-09-05T21:26:51.000Z");
    expect(r.closedAt.toISOString()).toBe("2026-09-11T13:13:05.000Z");
  });

  // A taxa é a DIFERENÇA entre o que saiu no total e o principal. Collect
  // sozinho superestima (inclui o principal); o snapshot subestimava porque
  // era de antes do fechamento.
  it("taxa é collect menos decrease, em quantidade de cada token", () => {
    const r = calculateCloseReceipt([mint, burn, collect])!;
    expect(r.feesAmount0).toBeCloseTo(0.000373029791248069, 15);
    expect(r.feesAmount1).toBeCloseTo(0.929059, 6);
  });

  it("IL é o principal retirado contra segurar as moedas depositadas", () => {
    const r = calculateCloseReceipt([mint, burn, collect])!;
    expect(r.ilToken1).toBeCloseTo(r.finalPositionValueToken1 - r.hodlValueToken1, 10);
    expect(r.ilToken1).toBeLessThan(0);
  });

  // Aporte no meio da vida da posição: cada depósito vale o preço do SEU
  // bloco. Valorar tudo no preço do mint inflaria ou esconderia o aporte.
  it("soma cada depósito no preço do seu próprio bloco", () => {
    const aporte: LiquidityEvent = { ...mint, amount0: 0.01, amount1: 25, price: 2600, at: new Date("2026-09-08T00:00:00Z") };
    const r = calculateCloseReceipt([mint, aporte, burn, collect])!;
    expect(r.entryValueToken1).toBeCloseTo(mint.amount0 * 2480.42 + mint.amount1 + 0.01 * 2600 + 25, 8);
  });

  it("coleta intermediária entra como taxa", () => {
    const coletaNoMeio: LiquidityEvent = { ...collect, amount0: 0.0001, amount1: 0.5, at: new Date("2026-09-08T00:00:00Z") };
    const r = calculateCloseReceipt([mint, coletaNoMeio, burn, collect])!;
    expect(r.feesAmount1).toBeCloseTo(0.929059 + 0.5, 6);
  });

  // Principal retirado e ainda não coletado: o dinheiro está no contrato, não
  // na carteira. Emitir recibo aqui mostraria taxa negativa.
  it("recusa quando falta coletar principal", () => {
    const coletaParcial: LiquidityEvent = { ...collect, amount1: 50 };
    expect(calculateCloseReceipt([mint, burn, coletaParcial])).toBeNull();
  });

  it("arredondamento de 1 unidade não vira recibo recusado", () => {
    const quase: LiquidityEvent = { ...collect, amount0: burn.amount0 - 1e-18, amount1: burn.amount1 };
    expect(calculateCloseReceipt([mint, burn, quase])?.feesAmount0).toBe(0);
  });

  it("sem depósito, sem retirada ou sem coleta não há recibo", () => {
    expect(calculateCloseReceipt([burn, collect])).toBeNull();
    expect(calculateCloseReceipt([mint, collect])).toBeNull();
    expect(calculateCloseReceipt([mint, burn])).toBeNull();
    expect(calculateCloseReceipt([])).toBeNull();
  });
});

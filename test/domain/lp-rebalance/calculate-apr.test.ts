import { describe, expect, it } from "vitest";
import { calculateRealizedApr } from "../../../src/domain/lp-rebalance/calculate-apr.js";

const DAY_MS = 1000 * 60 * 60 * 24;

describe("calculateRealizedApr", () => {
  it("retorno positivo simples: +10% em 15 dias -> 20%/mês", () => {
    const now = new Date("2026-08-17T00:00:00Z");
    const since = new Date(now.getTime() - 15 * DAY_MS);
    const result = calculateRealizedApr({ entryValueToken1: 1000, totalPnlToken1: 100, since, now });

    expect(result.reliable).toBe(true);
    expect(result.simpleReturnPct).toBeCloseTo(0.1, 5);
    expect(result.monthlyEquivalentPct).toBeCloseTo(0.2, 5);
    expect(result.annualizedPct).toBeCloseTo(0.1 * (365 / 15), 5);
  });

  it("retorno negativo", () => {
    const now = new Date("2026-08-17T00:00:00Z");
    const since = new Date(now.getTime() - 10 * DAY_MS);
    const result = calculateRealizedApr({ entryValueToken1: 1000, totalPnlToken1: -50, since, now });

    expect(result.reliable).toBe(true);
    expect(result.simpleReturnPct).toBeLessThan(0);
    expect(result.monthlyEquivalentPct).toBeLessThan(0);
  });

  it("elapsedDays abaixo do mínimo -> reliable false, reason too_new", () => {
    const now = new Date("2026-08-17T12:00:00Z");
    const since = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3h atrás
    const result = calculateRealizedApr({ entryValueToken1: 1000, totalPnlToken1: 5, since, now });

    expect(result.reliable).toBe(false);
    expect(result.unreliableReason).toBe("too_new");
    expect(result.monthlyEquivalentPct).toBe(0);
  });

  it("entryValueToken1 <= 0 -> reliable false, reason too_new (evita divisão por zero/NaN)", () => {
    const now = new Date("2026-08-17T00:00:00Z");
    const since = new Date(now.getTime() - 10 * DAY_MS);
    const result = calculateRealizedApr({ entryValueToken1: 0, totalPnlToken1: 5, since, now });

    expect(result.reliable).toBe(false);
    expect(result.unreliableReason).toBe("too_new");
    expect(Number.isNaN(result.monthlyEquivalentPct)).toBe(false);
  });

  it("posição-poeira (fees ínfimas sobre entrada quase-zero) -> reliable false, reason implausible", () => {
    // Caso real encontrado em produção: posição #436 (WETH/LINK) com
    // entryValue ~0.0019 LINK — qualquer fee residual vira um % absurdo.
    const now = new Date("2026-08-17T00:00:00Z");
    const since = new Date(now.getTime() - 2 * DAY_MS);
    const result = calculateRealizedApr({ entryValueToken1: 0.0019, totalPnlToken1: 0.0007, since, now });

    expect(result.reliable).toBe(false);
    expect(result.unreliableReason).toBe("implausible");
  });

  it("retorno anualizado plausível (dentro do limite) continua reliable", () => {
    const now = new Date("2026-08-17T00:00:00Z");
    const since = new Date(now.getTime() - 30 * DAY_MS);
    const result = calculateRealizedApr({ entryValueToken1: 1000, totalPnlToken1: 50, since, now }); // 5% bruto em 30 dias ≈ 60.8%/ano

    expect(result.reliable).toBe(true);
    expect(result.unreliableReason).toBeNull();
  });

  it("janela curta com retorno bruto moderado ainda vira implausível ao anualizar (sem precisar de retorno bruto exagerado)", () => {
    const now = new Date("2026-08-17T00:00:00Z");
    const since = new Date(now.getTime() - 2 * DAY_MS);
    // 37% bruto em 2 dias não é um número absurdo isoladamente, mas
    // anualizado (~6750%) não é mais um sinal útil.
    const result = calculateRealizedApr({ entryValueToken1: 1000, totalPnlToken1: 370, since, now });

    expect(result.reliable).toBe(false);
    expect(result.unreliableReason).toBe("implausible");
  });

  it("invariante: annualizedPct / monthlyEquivalentPct ≈ 365/30 quando reliable", () => {
    const now = new Date("2026-08-17T00:00:00Z");
    const since = new Date(now.getTime() - 7 * DAY_MS);
    const result = calculateRealizedApr({ entryValueToken1: 500, totalPnlToken1: 25, since, now });

    expect(result.reliable).toBe(true);
    expect(result.annualizedPct / result.monthlyEquivalentPct).toBeCloseTo(365 / 30, 5);
  });
});

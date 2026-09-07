import { describe, expect, it } from "vitest";
import { calculatePeriodReport, type CashFlow } from "../../../src/domain/portfolio/period-report.js";

const START = new Date("2026-09-01T00:00:00Z");
const END = new Date("2026-10-01T00:00:00Z");

function report(navStart: number, navEnd: number, flows: CashFlow[] = []) {
  return calculatePeriodReport({ navStartUsdc: navStart, navEndUsdc: navEnd, flows, periodStart: START, periodEnd: END });
}

describe("calculatePeriodReport", () => {
  it("sem fluxos, o P&L é a diferença pura de patrimônio", () => {
    const r = report(100, 103);
    expect(r.pnlUsdc).toBeCloseTo(3, 10);
    expect(r.returnPct).toBeCloseTo(0.03, 10);
  });

  it("perda aparece como P&L negativo", () => {
    const r = report(100, 95);
    expect(r.pnlUsdc).toBeCloseTo(-5, 10);
    expect(r.returnPct).toBeCloseTo(-0.05, 10);
  });

  // O ponto central do método: um aporte NÃO pode virar lucro. Sem descontar
  // depósitos, este caso mostraria +50 de "lucro" quando o resultado foi zero.
  it("depósito no meio do mês não é confundido com lucro", () => {
    const flows: CashFlow[] = [{ direction: "deposit", valueUsdc: 50, occurredAt: new Date("2026-09-16T00:00:00Z") }];
    const r = report(100, 150, flows);
    expect(r.pnlUsdc).toBeCloseTo(0, 10);
    expect(r.depositsUsdc).toBe(50);
  });

  it("saque não é confundido com prejuízo", () => {
    const flows: CashFlow[] = [{ direction: "withdrawal", valueUsdc: 30, occurredAt: new Date("2026-09-10T00:00:00Z") }];
    const r = report(100, 70, flows);
    expect(r.pnlUsdc).toBeCloseTo(0, 10);
    expect(r.withdrawalsUsdc).toBe(30);
  });

  // Dinheiro que entrou faltando pouco pro mês acabar quase não teve tempo de
  // render — se entrasse inteiro no denominador, o retorno sairia diluído.
  it("aporte é ponderado pelo tempo que ficou aplicado", () => {
    const noFim: CashFlow[] = [{ direction: "deposit", valueUsdc: 100, occurredAt: new Date("2026-09-30T00:00:00Z") }];
    const noInicio: CashFlow[] = [{ direction: "deposit", valueUsdc: 100, occurredAt: new Date("2026-09-01T00:00:00Z") }];

    const tardio = report(100, 206, noFim);
    const cedo = report(100, 206, noInicio);

    // Mesmo P&L absoluto nos dois casos...
    expect(tardio.pnlUsdc).toBeCloseTo(6, 10);
    expect(cedo.pnlUsdc).toBeCloseTo(6, 10);
    // ...mas o aporte tardio mal conta como capital empregado: entrou faltando
    // 1 dos 30 dias, então pesa 1/30 (100 × 0,0333 ≈ 3,33 somado à base).
    expect(tardio.averageCapitalUsdc).toBeCloseTo(103.33, 1);
    // O aporte do 1º dia trabalhou o mês inteiro: pesa 1, entra integral.
    expect(cedo.averageCapitalUsdc).toBeCloseTo(200, 1);
    expect(tardio.returnPct).toBeGreaterThan(cedo.returnPct);
  });

  it("não divide por zero quando não havia capital empregado", () => {
    const r = report(0, 0);
    expect(r.returnPct).toBe(0);
    expect(Number.isFinite(r.returnPct)).toBe(true);
  });

  it("carteira que começou do zero com aporte no 1º dia tem retorno finito", () => {
    const flows: CashFlow[] = [{ direction: "deposit", valueUsdc: 100, occurredAt: START }];
    const r = report(0, 105, flows);
    expect(r.pnlUsdc).toBeCloseTo(5, 10);
    expect(r.returnPct).toBeCloseTo(0.05, 2);
  });
});

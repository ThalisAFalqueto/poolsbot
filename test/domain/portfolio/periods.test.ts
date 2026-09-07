import { describe, expect, it } from "vitest";
import { boundsFor, dayBounds, isoDate, monthBounds, targetForDays, weekBounds } from "../../../src/domain/portfolio/periods.js";
import { TARGET_MONTHLY_PCT } from "../../../src/domain/portfolio/target.js";

describe("dayBounds", () => {
  it("vai da meia-noite UTC à seguinte", () => {
    const b = dayBounds(new Date("2026-09-07T18:42:00Z"));
    expect(b.start.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    expect(b.days).toBe(1);
  });

  // As fotos de NAV são chaveadas por data UTC. Se o "dia" do relatório usasse
  // fuso local, ele compararia fotos de dias diferentes dos que diz comparar.
  it("usa UTC, não o fuso local", () => {
    // 21h em Brasília (UTC-3) ainda é dia 7 em UTC (00h do dia 8).
    expect(dayBounds(new Date("2026-09-08T00:30:00Z")).label).toBe("2026-09-08");
  });
});

describe("weekBounds", () => {
  it("começa na segunda", () => {
    // 2026-09-09 é uma quarta.
    const b = weekBounds(new Date("2026-09-09T12:00:00Z"));
    expect(b.start.getUTCDay()).toBe(1);
    expect(isoDate(b.start)).toBe("2026-09-07");
    expect(b.label).toBe("07/09 a 13/09");
    expect(b.days).toBe(7);
  });

  // O caso que quebra em quase toda implementação: getUTCDay() devolve 0 pra
  // domingo, e domingo pertence à semana que COMEÇOU, não à que vai começar.
  it("domingo pertence à semana que já estava correndo", () => {
    const domingo = new Date("2026-09-13T23:00:00Z");
    expect(domingo.getUTCDay()).toBe(0);
    expect(isoDate(weekBounds(domingo).start)).toBe("2026-09-07");
  });

  it("segunda é o primeiro dia da própria semana", () => {
    expect(isoDate(weekBounds(new Date("2026-09-07T00:00:00Z")).start)).toBe("2026-09-07");
  });

  it("atravessa a virada de mês", () => {
    // 2026-10-01 é uma quinta; a semana dela começa em 28/09.
    expect(isoDate(weekBounds(new Date("2026-10-01T10:00:00Z")).start)).toBe("2026-09-28");
  });
});

describe("monthBounds", () => {
  it("vai do dia 1º ao 1º do mês seguinte", () => {
    const b = monthBounds(new Date("2026-09-18T12:00:00Z"));
    expect(b.start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(b.label).toBe("09/2026");
    expect(b.days).toBe(30);
  });

  it("atravessa a virada de ano", () => {
    const b = monthBounds(new Date("2026-12-15T00:00:00Z"));
    expect(b.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(b.label).toBe("12/2026");
  });

  it("conta os dias certos em fevereiro bissexto", () => {
    expect(monthBounds(new Date("2028-02-10T00:00:00Z")).days).toBe(29);
  });
});

describe("targetForDays", () => {
  it("em 30 dias é exatamente a meta mensal", () => {
    expect(targetForDays(30)).toBeCloseTo(TARGET_MONTHLY_PCT, 12);
  });

  // Linear estaria errado e sempre pra cima: 3%/30 = 0,100%/dia, e isso
  // composto dá 3,05% no mês. Pequeno num dia, meia meta num ano.
  it("é composto, não linear", () => {
    const diario = targetForDays(1);
    expect(diario).toBeLessThan(TARGET_MONTHLY_PCT / 30);
    expect((1 + diario) ** 30 - 1).toBeCloseTo(TARGET_MONTHLY_PCT, 12);
  });

  it("uma semana fica entre a meta diária e a mensal", () => {
    const semanal = targetForDays(7);
    expect(semanal).toBeGreaterThan(targetForDays(1));
    expect(semanal).toBeLessThan(TARGET_MONTHLY_PCT);
  });
});

describe("boundsFor", () => {
  it("despacha pro período certo", () => {
    const ref = new Date("2026-09-09T12:00:00Z");
    expect(boundsFor("dia", ref).days).toBe(1);
    expect(boundsFor("semana", ref).days).toBe(7);
    expect(boundsFor("mes", ref).days).toBe(30);
  });
});

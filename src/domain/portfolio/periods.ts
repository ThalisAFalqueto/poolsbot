import { TARGET_MONTHLY_PCT } from "./target.js";

// Limites de período pro relatório de resultado, e a meta escalada pra cada um.
//
// Tudo em UTC, como o resto do projeto (as fotos de NAV são chaveadas por data
// UTC — ver snapshot-nav.job.ts). Usar fuso local aqui faria o "dia" do
// relatório não bater com o dia das fotos que ele compara.

export type PeriodKind = "dia" | "semana" | "mes";
export type PeriodBounds = { start: Date; end: Date; label: string; days: number };

const DIA_MS = 86_400_000;

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dayBounds(ref: Date): PeriodBounds {
  const start = utcMidnight(ref);
  return { start, end: new Date(start.getTime() + DIA_MS), label: isoDate(start), days: 1 };
}

/**
 * Semana de SEGUNDA a domingo (padrão ISO).
 *
 * `getUTCDay()` devolve 0 pra domingo, então o deslocamento até a segunda
 * anterior é `(dia + 6) % 7` — com domingo isso dá 6, que é o certo: domingo
 * pertence à semana que começou 6 dias antes, não à que começa amanhã.
 */
export function weekBounds(ref: Date): PeriodBounds {
  const meiaNoite = utcMidnight(ref);
  const start = new Date(meiaNoite.getTime() - ((meiaNoite.getUTCDay() + 6) % 7) * DIA_MS);
  const end = new Date(start.getTime() + 7 * DIA_MS);
  const fim = new Date(end.getTime() - DIA_MS);
  const br = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start, end, label: `${br(start)} a ${br(fim)}`, days: 7 };
}

export function monthBounds(ref: Date): PeriodBounds {
  const ano = ref.getUTCFullYear();
  const mes = ref.getUTCMonth();
  const start = new Date(Date.UTC(ano, mes, 1));
  const end = new Date(Date.UTC(ano, mes + 1, 1));
  return {
    start,
    end,
    label: `${String(mes + 1).padStart(2, "0")}/${ano}`,
    days: Math.round((end.getTime() - start.getTime()) / DIA_MS),
  };
}

export function boundsFor(kind: PeriodKind, ref: Date): PeriodBounds {
  if (kind === "dia") return dayBounds(ref);
  if (kind === "semana") return weekBounds(ref);
  return monthBounds(ref);
}

/**
 * A meta de 3%/mês convertida pro período, com JUROS COMPOSTOS.
 *
 *     meta = (1 + 0,03)^(dias/30) − 1
 *
 * Linear estaria errado e sempre pra cima: 3%/30 daria 0,100%/dia, e 0,100% ao
 * dia composto dá 3,05% no mês. A diferença é pequena num dia e vira meia meta
 * de diferença num ano — e o ponto inteiro do /mes é ser auditável.
 */
export function targetForDays(days: number): number {
  return (1 + TARGET_MONTHLY_PCT) ** (days / 30) - 1;
}

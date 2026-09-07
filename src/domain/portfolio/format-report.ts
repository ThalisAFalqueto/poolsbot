import type { PeriodReport } from "./period-report.js";
import { targetForDays, type PeriodBounds } from "./periods.js";

// Texto curto do resultado de um período — o bloco que o resumo de segunda
// manda sem o usuário pedir.
//
// É deliberadamente MENOR que o do comando: quem pediu /semana quer o detalhe,
// quem recebeu sem pedir quer saber se foi bom ou ruim e segue a vida. O
// detalhe fica a um /semana de distância, e o texto diz isso.

function usdc(v: number): string {
  return v.toFixed(2);
}

function signed(v: number): string {
  return `${v >= 0 ? "+" : ""}${usdc(v)}`;
}

export function formatWeeklySummary(periodo: PeriodBounds, report: PeriodReport, navFinal: number): string {
  const meta = targetForDays(periodo.days);
  const bateu = report.returnPct >= meta;

  const movimento =
    report.depositsUsdc > 0 || report.withdrawalsUsdc > 0
      ? [
          `Movimentações: ${[
            report.depositsUsdc > 0 ? `aportes ${usdc(report.depositsUsdc)}` : null,
            report.withdrawalsUsdc > 0 ? `saques ${usdc(report.withdrawalsUsdc)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")} USDC — o P&L já desconta isso`,
        ]
      : [];

  return [
    `📆 Semana fechada (${periodo.label})`,
    "",
    `P&L: ${signed(report.pnlUsdc)} USDC (${signed(report.returnPct * 100)}%)`,
    `${bateu ? "✅ acima" : "⚠️ abaixo"} da meta de ${(meta * 100).toFixed(2)}%/semana (3%/mês)`,
    ...movimento,
    `Patrimônio agora: ${usdc(navFinal)} USDC`,
    "",
    "Detalhe em /semana.",
  ].join("\n");
}

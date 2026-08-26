import type { CommandContext, Context } from "grammy";
import { TARGET_MONTHLY_PCT } from "../../domain/portfolio/target.js";
import { calculateMonthlyReport, type CashFlow } from "../../domain/portfolio/monthly-report.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import {
  findLatestNavSnapshotUpTo,
  listCashFlowsBetween,
  listNavSnapshotsBetween,
} from "../../persistence/repositories/wallet-nav.repository.js";

// Resultado do mês pelo método de diferença de patrimônio — ver
// domain/portfolio/monthly-report.ts pro porquê, e o comentário das tabelas em
// persistence/schema/index.ts pro desenho do dado.

function formatUsdc(value: number): string {
  return value.toFixed(2);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatUsdc(value)}`;
}

/** "2026-09" -> { start: 01/09 00:00 UTC, end: 01/10 00:00 UTC } */
function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

function parseMonthArg(arg: string | undefined, now: Date): { year: number; month: number } | null {
  if (!arg) return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const match = /^(\d{4})-(\d{2})$/.exec(arg.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function mesCommand(ctx: CommandContext<Context>) {
  const now = new Date();
  const parsed = parseMonthArg(ctx.match?.toString(), now);
  if (!parsed) {
    await ctx.reply("Uso: /mes  (mês atual) ou /mes 2026-09  (mês específico).");
    return;
  }

  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const { start, end } = monthBounds(parsed.year, parsed.month);
  const label = `${String(parsed.month).padStart(2, "0")}/${parsed.year}`;

  // Fim do período = último dia do mês, ou hoje se o mês ainda está correndo.
  const isCurrentMonth = now >= start && now < end;
  const lastDay = isCurrentMonth ? isoDate(now) : isoDate(new Date(end.getTime() - 86400000));
  // Abertura = ÚLTIMA foto ANTES do mês começar. Não exige foto no dia 1º: se
  // o bot ficou fora do ar, a anterior serve — e o texto diz de que dia é, em
  // vez de fingir precisão.
  const dayBeforeStart = isoDate(new Date(start.getTime() - 86400000));

  const [openingSnapshot, snapshotsInMonth, flows] = await Promise.all([
    findLatestNavSnapshotUpTo(user.id, dayBeforeStart),
    listNavSnapshotsBetween(user.id, isoDate(start), lastDay),
    listCashFlowsBetween(user.id, start, isCurrentMonth ? now : end),
  ]);

  const closingSnapshot = snapshotsInMonth.at(-1) ?? null;

  if (!closingSnapshot) {
    await ctx.reply(
      [
        `📅 ${label} — sem dados ainda.`,
        "",
        "O resultado do mês é medido comparando fotos diárias do patrimônio, e ainda não há nenhuma foto neste mês.",
        "As fotos começaram a ser tiradas agora — o primeiro mês fechado completo será o próximo.",
      ].join("\n")
    );
    return;
  }

  if (!openingSnapshot) {
    // Sem abertura não existe diferença a calcular. Mostra o que dá (o retrato
    // atual) e diz exatamente o que falta, em vez de inventar um ponto de
    // partida — usar a primeira foto DO mês como abertura zeraria justamente o
    // resultado dos dias já decorridos.
    await ctx.reply(
      [
        `📅 ${label} — resultado indisponível (sem foto de abertura).`,
        "",
        `Patrimônio hoje: ${formatUsdc(closingSnapshot.navUsdc)} USDC`,
        `   em pool ${formatUsdc(closingSnapshot.positionsUsdc)} · parado ${formatUsdc(closingSnapshot.idleUsdc)} · fees a coletar ${formatUsdc(closingSnapshot.feesUsdc)}`,
        "",
        `Pra calcular o resultado de ${label} eu precisaria de uma foto de antes de ${isoDate(start)}, e a primeira só foi tirada depois. Vale a partir do mês seguinte.`,
      ].join("\n")
    );
    return;
  }

  const report = calculateMonthlyReport({
    navStartUsdc: openingSnapshot.navUsdc,
    navEndUsdc: closingSnapshot.navUsdc,
    flows: flows.map((f): CashFlow => ({ direction: f.direction, valueUsdc: f.valueUsdc, occurredAt: f.occurredAt })),
    periodStart: start,
    periodEnd: isCurrentMonth ? now : end,
  });

  const hitTarget = report.returnPct >= TARGET_MONTHLY_PCT;
  const targetLine = hitTarget
    ? `✅ acima da meta de ${(TARGET_MONTHLY_PCT * 100).toFixed(0)}%/mês`
    : `⚠️ abaixo da meta de ${(TARGET_MONTHLY_PCT * 100).toFixed(0)}%/mês`;

  const flowLines: string[] = [];
  if (report.depositsUsdc > 0) flowLines.push(`aportes ${formatUsdc(report.depositsUsdc)}`);
  if (report.withdrawalsUsdc > 0) flowLines.push(`saques ${formatUsdc(report.withdrawalsUsdc)}`);

  const idlePct = closingSnapshot.navUsdc > 0 ? (closingSnapshot.idleUsdc / closingSnapshot.navUsdc) * 100 : 0;

  // A linha do capital médio só aparece quando houve movimentação: sem
  // aporte/saque ele é igual ao patrimônio de abertura, e repetir o número
  // seria ruído. COM movimentação ela é essencial — senão o denominador
  // parece arbitrário ("mas eu tenho 59, não 13"). O que ela diz é que
  // dinheiro que entrou no fim do mês quase não teve tempo de render, então
  // conta proporcionalmente.
  const capitalLine =
    flowLines.length > 0
      ? [`   sobre ${formatUsdc(report.averageCapitalUsdc)} USDC de capital médio — cada aporte conta proporcionalmente aos dias que ficou aplicado`]
      : [];

  await ctx.reply(
    [
      `📅 Resultado de ${label}${isCurrentMonth ? " (mês em andamento)" : ""}`,
      "",
      `Patrimônio: ${formatUsdc(openingSnapshot.navUsdc)} → ${formatUsdc(closingSnapshot.navUsdc)} USDC`,
      flowLines.length > 0 ? `Movimentações: ${flowLines.join(" · ")} USDC` : "Movimentações: nenhuma (nem aporte nem saque)",
      "",
      `P&L: ${signed(report.pnlUsdc)} USDC (${signed(report.returnPct * 100)}%) ${targetLine}`,
      ...capitalLine,
      "",
      `Composição hoje: em pool ${formatUsdc(closingSnapshot.positionsUsdc)} · parado ${formatUsdc(closingSnapshot.idleUsdc)} (${idlePct.toFixed(0)}%) · fees a coletar ${formatUsdc(closingSnapshot.feesUsdc)}`,
      "",
      `* Mede a variação do patrimônio TOTAL da carteira, então já desconta gas, slippage e taxa de swap — nada precisa ser somado à parte. Diferente do /positions, o capital parado entra na conta e puxa o retorno pra baixo. Valores convertidos pra USDC a preço de pool on-chain (aproximado, não é cotação em dólar). Abertura medida em ${openingSnapshot.date}, fechamento em ${closingSnapshot.date}, datas em UTC.`,
    ].join("\n")
  );
}

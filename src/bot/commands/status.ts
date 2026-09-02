import type { CommandContext, Context } from "grammy";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { listWallets } from "../../persistence/repositories/user-wallets.repository.js";
import { listRulesForUser } from "../../persistence/repositories/alert-rules.repository.js";
import { listJobStatuses, type JobStatusRow } from "../../persistence/repositories/job-status.repository.js";

const JOB_LABELS: Record<string, string> = {
  "ingest-pools": "Ingestão de pools",
  "evaluate-alerts": "Avaliação de alertas",
  "check-positions": "Checagem de posições de LP",
  "check-close-triggers": "Gatilhos de fechamento",
  "snapshot-nav": "Foto do patrimônio (diária)",
  "daily-digest": "Resumo diário de mercado",
};

// Ordem fixa (não a ordem de retorno do banco) pra sempre aparecer na mesma
// sequência em que os jobs rodam no ciclo — mais fácil de acompanhar.
const JOB_ORDER = ["ingest-pools", "evaluate-alerts", "check-positions", "check-close-triggers", "snapshot-nav", "daily-digest"];

function formatRelativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "agora mesmo";
  if (minutes < 60) return `há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

function formatJobLine(jobName: string, row: JobStatusRow | undefined, now: Date): string {
  const label = JOB_LABELS[jobName] ?? jobName;
  if (!row) return `❔ ${label} — nunca rodou ainda.`;

  const when = formatRelativeTime(row.lastRunAt, now);
  if (row.lastSuccess) {
    return `✅ ${label} — ${when}: ${row.lastSummary ?? "ok"}`;
  }
  return `🚨 ${label} — ${when}: falhou (${row.lastErrorMessage ?? "erro desconhecido"})`;
}

export async function statusCommand(ctx: CommandContext<Context>) {
  const now = new Date();
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));

  const [jobRows, wallets, rules] = await Promise.all([
    listJobStatuses(),
    listWallets(user.id),
    listRulesForUser(user.id),
  ]);
  const jobByName = new Map(jobRows.map((r) => [r.jobName, r]));
  const watchedPoolCount = new Set(rules.map((r) => r.poolId)).size;

  const jobLines = JOB_ORDER.map((jobName) => formatJobLine(jobName, jobByName.get(jobName), now));

  await ctx.reply(
    [
      "📡 Status do poolsbot",
      "",
      "Jobs (ciclo automático a cada 15min):",
      ...jobLines,
      "",
      "Sua conta:",
      `${wallets.length} wallet${wallets.length === 1 ? "" : "s"} vinculada${wallets.length === 1 ? "" : "s"} · ${watchedPoolCount} pool${watchedPoolCount === 1 ? "" : "s"} observado${watchedPoolCount === 1 ? "" : "s"}`,
    ].join("\n")
  );
}

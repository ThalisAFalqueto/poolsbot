import type { CommandContext, Context } from "grammy";
import { getPoolById } from "../../data/defillama/client.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { listRulesForUser } from "../../persistence/repositories/alert-rules.repository.js";
import type { AlertMetric } from "../../domain/alerts/types.js";

const METRIC_LABEL: Record<AlertMetric, string> = {
  apy_drop_relative: "Queda de APY (relativa)",
  apy_below_absolute: "APY abaixo de",
  tvl_drop_relative: "Queda de TVL (relativa)",
  tvl_below_absolute: "TVL abaixo de",
  reward_apy_ending: "Fim de incentivo (reward APY)",
  il_risk_proxy: "Risco de impermanent loss",
};

function formatThreshold(metric: AlertMetric, thresholdValue: number): string {
  if (metric === "apy_below_absolute" || metric === "tvl_below_absolute") {
    return String(thresholdValue);
  }
  return `${(thresholdValue * 100).toFixed(0)}%`;
}

export async function alertsCommand(ctx: CommandContext<Context>) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const rules = await listRulesForUser(user.id);

  if (rules.length === 0) {
    await ctx.reply("Nenhum alerta configurado. Use /watch <poolId> para começar a observar um pool.");
    return;
  }

  const poolIds = [...new Set(rules.map((r) => r.poolId))];
  const pools = await Promise.all(poolIds.map((id) => getPoolById(id)));
  const poolById = new Map(poolIds.map((id, i) => [id, pools[i]]));

  const lines = rules.map((r) => {
    const pool = poolById.get(r.poolId);
    const label = pool ? `${pool.project} ${pool.symbol} (${pool.chain})` : r.poolId;
    const statusIcon = r.status === "triggered" ? "🚨 triggered" : "✅ ok";
    return `#${r.ruleId} ${label} — ${METRIC_LABEL[r.metric]} ${formatThreshold(r.metric, r.thresholdValue)} — ${statusIcon}`;
  });

  await ctx.reply(["Seus alertas:", ...lines, "", "Use /unalert <id> para remover."].join("\n"));
}

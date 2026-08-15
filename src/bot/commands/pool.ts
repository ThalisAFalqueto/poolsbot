import type { CommandContext, Context } from "grammy";
import { getPoolById } from "../../data/defillama/client.js";

function formatPct(value: number | null): string {
  return value === null ? "n/d" : `${value.toFixed(2)}%`;
}

export async function poolCommand(ctx: CommandContext<Context>) {
  const poolId = ctx.match?.toString().trim();
  if (!poolId) {
    await ctx.reply("Uso: /pool <id>\nUse /find <chain> <symbol> para descobrir ids.");
    return;
  }

  const pool = await getPoolById(poolId);
  if (!pool) {
    await ctx.reply(`Pool "${poolId}" não encontrado na DefiLlama.`);
    return;
  }

  await ctx.reply(
    [
      `${pool.project} — ${pool.symbol} (${pool.chain})`,
      `APY total: ${formatPct(pool.apy)}`,
      `  ├ base: ${formatPct(pool.apyBase)}`,
      `  └ reward: ${formatPct(pool.apyReward)}`,
      `TVL: $${pool.tvlUsd.toLocaleString("pt-BR")}`,
      `Risco de IL: ${pool.ilRisk}`,
    ].join("\n")
  );
}

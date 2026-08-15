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

  const lines = [
    `${pool.project} — ${pool.symbol} (${pool.chain})`,
    `APY total: ${formatPct(pool.apy)}`,
    `  ├ base: ${formatPct(pool.apyBase)}`,
    `  └ reward: ${formatPct(pool.apyReward)}`,
    `APY médio (30d): ${formatPct(pool.apyMean30d)}`,
  ];

  const isSpike = pool.apyMean30d !== null && pool.apy > pool.apyMean30d * 1.5;
  if (isSpike) {
    lines.push(
      `⚠️ APY atual ${(pool.apy / pool.apyMean30d!).toFixed(1)}x acima da própria média de 30d — provável pico transitório, não retorno sustentável.`
    );
  }

  lines.push(
    `TVL: $${pool.tvlUsd.toLocaleString("pt-BR")}`,
    `Volatilidade histórica do APY (sigma): ${pool.sigma === null ? "n/d" : pool.sigma.toFixed(2)}`,
    `Risco de IL (categórico, DefiLlama): ${pool.ilRisk}`
  );

  if (pool.il7d !== null) {
    lines.push(`IL estimado (7d, DefiLlama): ${formatPct(Math.abs(pool.il7d))}`);
  }

  if (pool.outlier) {
    lines.push("🚨 Este pool é sinalizado pela própria DefiLlama como outlier estatístico — trate os números com desconfiança extra.");
  }

  await ctx.reply(lines.join("\n"));
}

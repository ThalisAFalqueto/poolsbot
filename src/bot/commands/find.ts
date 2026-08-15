import type { CommandContext, Context } from "grammy";
import { searchPools } from "../../data/defillama/client.js";

export async function findCommand(ctx: CommandContext<Context>) {
  const args = ctx.match?.toString().trim().split(/\s+/).filter(Boolean) ?? [];
  const [chain, ...symbolParts] = args;

  if (!chain) {
    await ctx.reply("Uso: /find <chain> [symbol]\nEx: /find arbitrum USDC-ETH");
    return;
  }

  const symbol = symbolParts.join(" ") || undefined;
  const pools = await searchPools({ chain, symbol, limit: 5 });

  if (pools.length === 0) {
    await ctx.reply("Nenhum pool encontrado com esses filtros.");
    return;
  }

  const lines = pools.map(
    (p) =>
      `• ${p.symbol} (${p.project}) — APY ${p.apy.toFixed(2)}% — TVL $${p.tvlUsd.toLocaleString("pt-BR")} — id: ${p.pool}`
  );
  await ctx.reply(["Top pools encontrados:", ...lines, "", "Use /pool <id> para detalhes."].join("\n"));
}

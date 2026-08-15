import type { CommandContext, Context } from "grammy";
import { fetchAllPools } from "../../data/defillama/client.js";
import { rankByRiskAdjustedYield } from "../../domain/yield-optimizer/score.js";

export async function yieldCommand(ctx: CommandContext<Context>) {
  const args = ctx.match?.toString().trim().split(/\s+/).filter(Boolean) ?? [];
  const [chain, ...symbolParts] = args;

  if (!chain) {
    await ctx.reply("Uso: /yield <chain> [symbol]\nEx: /yield arbitrum USDC");
    return;
  }

  const symbol = symbolParts.join(" ") || undefined;
  const pools = await fetchAllPools();

  const filtered = pools
    .filter((p) => p.chain.toLowerCase() === chain.toLowerCase())
    .filter((p) => !symbol || p.symbol.toLowerCase().includes(symbol.toLowerCase()))
    .filter((p) => !p.outlier);

  if (filtered.length === 0) {
    await ctx.reply("Nenhum pool encontrado com esses filtros.");
    return;
  }

  const ranked = rankByRiskAdjustedYield(
    filtered.map((p) => ({
      poolId: p.pool,
      chain: p.chain,
      project: p.project,
      symbol: p.symbol,
      apy: p.apy,
      tvlUsd: p.tvlUsd,
      ilRisk: p.ilRisk,
      sigma: p.sigma,
      apyMean30d: p.apyMean30d,
    }))
  ).slice(0, 5);

  const lines = ranked.map(
    (p, i) =>
      `${i + 1}. ${p.symbol} (${p.project}) — score ${p.score.toFixed(2)} | APY ${p.apy.toFixed(2)}% | TVL $${p.tvlUsd.toLocaleString("pt-BR")} | IL risk: ${p.ilRisk} — id: ${p.poolId}`
  );

  await ctx.reply(
    [
      `Melhores pools em ${chain} por retorno ajustado a risco:`,
      ...lines,
      "",
      "Score = APY × liquidez (TVL) × risco de IL × estabilidade (volatilidade) × consistência (vs. média de 30d). Use /pool <id> para o detalhamento de cada pool.",
    ].join("\n")
  );
}

import type { CommandContext, Context } from "grammy";
import { fetchAllPools } from "../../data/defillama/client.js";
import { isEligiblePool, MAX_APY_VS_MEAN30D_RATIO, MIN_TVL_USD } from "../../domain/yield-optimizer/eligibility.js";
import { rankByRiskAdjustedYield } from "../../domain/yield-optimizer/score.js";

// ~3%/mês (juros compostos ao longo de um ano) é a meta declarada — usado
// como piso padrão pra não misturar pools "seguros" de baixo retorno com o
// que realmente interessa pra esse objetivo. Ajustável via --min.
const DEFAULT_MIN_APY_PCT = 36;

function parseArgs(raw: string) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let minApyPct = DEFAULT_MIN_APY_PCT;
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--min" && tokens[i + 1] !== undefined) {
      const parsed = Number(tokens[i + 1]);
      if (!Number.isNaN(parsed)) minApyPct = parsed;
      i++; // pula o valor já consumido
      continue;
    }
    rest.push(tokens[i]!);
  }

  const [chain, ...symbolParts] = rest;
  return { chain, symbol: symbolParts.join(" ") || undefined, minApyPct };
}

export async function yieldCommand(ctx: CommandContext<Context>) {
  const { chain, symbol, minApyPct } = parseArgs(ctx.match?.toString() ?? "");

  if (!chain) {
    await ctx.reply(
      [
        "Uso: /yield <chain> [symbol] [--min <apy%>]",
        `Ex: /yield arbitrum USDC (usa piso padrão de ${DEFAULT_MIN_APY_PCT}% ao ano)`,
        "Ex: /yield arbitrum --min 10 (piso customizado)",
      ].join("\n")
    );
    return;
  }

  const pools = await fetchAllPools();

  const filtered = pools
    .filter((p) => p.chain.toLowerCase() === chain.toLowerCase())
    .filter((p) => !symbol || p.symbol.toLowerCase().includes(symbol.toLowerCase()))
    .filter((p) => !p.outlier)
    .filter((p) => p.apy >= minApyPct);

  if (filtered.length === 0) {
    await ctx.reply(
      `Nenhum pool encontrado com esses filtros e APY ≥ ${minApyPct}%. Tente um piso menor: /yield ${chain}${symbol ? ` ${symbol}` : ""} --min 10`
    );
    return;
  }

  const eligible = filtered
    .map((p) => ({
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
    .filter(isEligiblePool);

  if (eligible.length === 0) {
    await ctx.reply(
      [
        `Nenhum pool passou nos filtros de segurança (TVL ≥ $${MIN_TVL_USD.toLocaleString("pt-BR")} e APY não mais que ${MAX_APY_VS_MEAN30D_RATIO}x a própria média de 30 dias).`,
        "Esses filtros protegem contra pools fáceis de manipular e picos de APY inflados — não são ajustáveis via --min (que só controla o piso de retorno).",
      ].join("\n")
    );
    return;
  }

  const ranked = rankByRiskAdjustedYield(eligible).slice(0, 5);

  const lines = ranked.map(
    (p, i) =>
      `${i + 1}. ${p.symbol} (${p.project}) — score ${p.score.toFixed(2)} | APY ${p.apy.toFixed(2)}% | TVL $${p.tvlUsd.toLocaleString("pt-BR")} | IL risk: ${p.ilRisk} — id: ${p.poolId}`
  );

  await ctx.reply(
    [
      `Melhores pools em ${chain} com APY ≥ ${minApyPct}%, por retorno ajustado a risco:`,
      ...lines,
      "",
      "Score = APY × liquidez (TVL) × risco de IL × estabilidade (volatilidade) × consistência (vs. média de 30d). Use /pool <id> para o detalhamento de cada pool.",
      `Piso de APY ajustável com --min <valor> (ex: /yield ${chain} --min 10).`,
      `Filtros de segurança fixos (não ajustáveis): TVL ≥ $${MIN_TVL_USD.toLocaleString("pt-BR")} e APY ≤ ${MAX_APY_VS_MEAN30D_RATIO}x a média de 30d.`,
    ].join("\n")
  );
}

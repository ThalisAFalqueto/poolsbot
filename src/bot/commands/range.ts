import type { CommandContext, Context } from "grammy";
import type { Address } from "viem";
import { chainKeyFromDefillamaName, getActiveChains } from "../../config/chains.js";
import { getPoolById, parseFeeTierLabel } from "../../data/defillama/client.js";
import { fetchTickCumulatives, getPoolInfo } from "../../data/onchain/client.js";
import { formatBoundaryPrice, formatPrice, formatWindowDuration } from "../../domain/lp-rebalance/format-reason.js";
import { sqrtPriceX96ToPrice, tickSpacingForFee } from "../../domain/lp-rebalance/price-math.js";
import { buildSecondsAgos, intervalAverageTicks, suggestVolatilityRange, VOLATILITY_WINDOWS } from "../../domain/lp-rebalance/volatility-range.js";

// Sugestão de faixa ANTES de abrir uma posição — reaproveita a mesma
// calibração por volatilidade real (oráculo TWAP) usada no job automático
// pra reposicionar posições existentes, mas aqui não existe posição nenhuma
// ainda, então: (a) não há heurístico de fallback (esse espelha a largura
// de uma posição já existente, que não existe aqui) — sem histórico
// suficiente, a resposta é honesta sobre não ter o que sugerir; (b) o custo
// de gas usado na margem (ver computeMarginFraction em volatility-range.ts)
// é o valor de REFERÊNCIA, não o seu real — ele depende do tamanho da
// posição, que ainda não existe.
export async function rangeCommand(ctx: CommandContext<Context>) {
  const poolId = ctx.match?.toString().trim();
  if (!poolId) {
    await ctx.reply("Uso: /range <poolId>\nPegue o poolId em /find ou /yield (a última coluna de cada linha).");
    return;
  }

  const pool = await getPoolById(poolId);
  if (!pool) {
    await ctx.reply(`Pool "${poolId}" não encontrado na DefiLlama.`);
    return;
  }

  const chainKey = chainKeyFromDefillamaName(pool.chain);
  const activeChains = getActiveChains();
  if (!chainKey || !activeChains.includes(chainKey)) {
    await ctx.reply(
      `Chain "${pool.chain}" não suportada pra leitura on-chain agora (só ${activeChains.map((c) => c).join(", ") || "nenhuma configurada"}).`
    );
    return;
  }

  if (pool.project !== "uniswap-v3") {
    await ctx.reply(`/range só sabe calcular faixa de posições Uniswap V3 — esse pool é do protocolo "${pool.project}".`);
    return;
  }

  const fee = parseFeeTierLabel(pool.poolMeta);
  if (fee === null || !pool.underlyingTokens || pool.underlyingTokens.length < 2) {
    await ctx.reply("Não consegui identificar o fee tier ou os tokens desse pool a partir dos dados da DefiLlama.");
    return;
  }

  const [tokenA, tokenB] = pool.underlyingTokens as [Address, Address];
  const info = await getPoolInfo(chainKey, tokenA, tokenB, fee);
  if (!info) {
    await ctx.reply(`Não encontrei esse pool on-chain em ${pool.chain} (par/fee pode não ter um pool Uniswap V3 criado).`);
    return;
  }

  const currentPrice = sqrtPriceX96ToPrice(info.sqrtPriceX96, info.token0.decimals, info.token1.decimals);
  const header = `${info.token0.symbol}/${info.token1.symbol} ${(fee / 10000).toFixed(2)}% (Uniswap V3, ${pool.chain})`;
  const priceLine = `Preço atual: ${formatPrice(currentPrice)} ${info.token1.symbol} por ${info.token0.symbol}`;
  const disclaimer =
    "Isso NÃO considera o tamanho da posição que você vai abrir (a margem usa um custo de gas de referência, não o seu real, que só existe depois que a posição é criada) — é um ponto de partida, não a palavra final. Depois de abrir, use /addwallet e /positions pra monitorar de verdade.";

  for (const { windowSeconds, checkpointCount } of VOLATILITY_WINDOWS) {
    const secondsAgos = buildSecondsAgos(windowSeconds, checkpointCount);
    const tickCumulatives = await fetchTickCumulatives(chainKey, info.poolAddress, secondsAgos);
    if (!tickCumulatives) continue;

    const intervalTicks = intervalAverageTicks(tickCumulatives, secondsAgos);
    const range = suggestVolatilityRange(intervalTicks, info.currentTick, fee, tickSpacingForFee(fee), null);
    const low = formatBoundaryPrice(range.tickLower, info.token0.decimals, info.token1.decimals);
    const high = formatBoundaryPrice(range.tickUpper, info.token0.decimals, info.token1.decimals);

    await ctx.reply(
      [
        header,
        priceLine,
        `Faixa sugerida (calibrada por volatilidade real, últimos ${formatWindowDuration(windowSeconds)}): ${low} – ${high} ${info.token1.symbol} por ${info.token0.symbol}`,
        "",
        disclaimer,
      ].join("\n")
    );
    return;
  }

  await ctx.reply(
    [
      header,
      priceLine,
      "Não achei histórico de preço suficiente pra calibrar (nenhuma janela de 7d/24h/6h tinha dado no oráculo do pool).",
      "Considere olhar a distribuição de liquidez direto no app do Uniswap antes de decidir a faixa.",
    ].join("\n")
  );
}

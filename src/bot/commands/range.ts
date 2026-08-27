import type { CommandContext, Context } from "grammy";
import type { Address } from "viem";
import { chainKeyFromDefillamaName, getActiveChains } from "../../config/chains.js";
import { getPoolById, parseFeeTierLabel } from "../../data/defillama/client.js";
import { fetchTickCumulatives, getPoolInfo } from "../../data/onchain/client.js";
import { getV4PoolInfo } from "../../data/onchain/client-v4.js";
import { formatBoundaryPrice, formatPrice, formatWindowDuration } from "../../domain/lp-rebalance/format-reason.js";
import { sqrtPriceX96ToPrice, tickSpacingForFee, tickToPrice } from "../../domain/lp-rebalance/price-math.js";
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

  const isV4 = pool.project === "uniswap-v4";
  if (!isV4 && pool.project !== "uniswap-v3") {
    await ctx.reply(`/range só sabe calcular faixa de posições Uniswap V3/V4 — esse pool é do protocolo "${pool.project}".`);
    return;
  }

  const fee = parseFeeTierLabel(pool.poolMeta);
  if (fee === null || !pool.underlyingTokens || pool.underlyingTokens.length < 2) {
    await ctx.reply("Não consegui identificar o fee tier ou os tokens desse pool a partir dos dados da DefiLlama.");
    return;
  }

  const [tokenA, tokenB] = pool.underlyingTokens as [Address, Address];
  const info = isV4 ? await getV4PoolInfo(chainKey, tokenA, tokenB, fee) : await getPoolInfo(chainKey, tokenA, tokenB, fee);
  if (!info) {
    const hint = isV4
      ? " (só cobre pools V4 \"vanilla\", sem hook customizado e com tick spacing padrão — se esse pool usa um hook, /range não consegue achá-lo)"
      : "";
    await ctx.reply(`Não encontrei esse pool on-chain em ${pool.chain} (par/fee pode não ter um pool Uniswap ${isV4 ? "V4" : "V3"} criado)${hint}.`);
    return;
  }

  const currentPrice = sqrtPriceX96ToPrice(info.sqrtPriceX96, info.token0.decimals, info.token1.decimals);
  const protocolLabel = isV4 ? "Uniswap V4" : "Uniswap V3";
  const header = `${info.token0.symbol}/${info.token1.symbol} ${(fee / 10000).toFixed(2)}% (${protocolLabel}, ${pool.chain})`;
  const priceLine = `Preço atual: ${formatPrice(currentPrice)} ${info.token1.symbol} por ${info.token0.symbol}`;
  const disclaimer =
    "Isso NÃO considera o tamanho da posição que você vai abrir (a margem usa um custo de gas de referência, não o seu real, que só existe depois que a posição é criada) — é um ponto de partida, não a palavra final. Depois de abrir, use /addwallet e /positions pra monitorar de verdade.";

  // V4 não tem oráculo TWAP nativo (observe() virou hook opcional) — sem
  // tentar simular volatilidade por outra via, mostra só preço + faixa
  // honesta em vez de fingir uma calibração que não existe pra esse
  // protocolo (ver plano da Fase B).
  if (isV4) {
    await ctx.reply(
      [
        header,
        priceLine,
        "Faixa por volatilidade real: não disponível pra Uniswap V4 (o pool não tem oráculo TWAP nativo — esse recurso existe só pra V3 aqui).",
        "Considere olhar a distribuição de liquidez direto no app do Uniswap antes de decidir a faixa.",
      ].join("\n")
    );
    return;
  }

  for (const { windowSeconds, checkpointCount } of VOLATILITY_WINDOWS) {
    const secondsAgos = buildSecondsAgos(windowSeconds, checkpointCount);
    const tickCumulatives = await fetchTickCumulatives(chainKey, info.poolAddress, secondsAgos);
    if (!tickCumulatives) continue;

    const intervalTicks = intervalAverageTicks(tickCumulatives, secondsAgos);
    const range = suggestVolatilityRange(intervalTicks, info.currentTick, fee, tickSpacingForFee(fee), null);
    const low = formatBoundaryPrice(range.tickLower, info.token0.decimals, info.token1.decimals);
    const high = formatBoundaryPrice(range.tickUpper, info.token0.decimals, info.token1.decimals);

    // Janela curta mede volatilidade de POUCAS HORAS, que costuma ser bem
    // menor que a de dias — e a faixa sai proporcionalmente mais estreita.
    // Sem este aviso o número engana: o usuário lê "calibrada por volatilidade
    // real" e não percebe que a base é curta. Visto ao vivo (27/08/2026): o
    // pool mais líquido do par só alcançava 4h e a sugestão saiu com ~2% de
    // largura, apertada o bastante pra sair de range no mesmo dia.
    const shortWindow = windowSeconds < 6 * 3600;
    const widthPct = ((tickToPrice(range.tickUpper, info.token0.decimals, info.token1.decimals) /
      tickToPrice(range.tickLower, info.token0.decimals, info.token1.decimals)) - 1) * 100;

    await ctx.reply(
      [
        header,
        priceLine,
        `Faixa sugerida (calibrada por volatilidade real, últimos ${formatWindowDuration(windowSeconds)}): ${low} – ${high} ${info.token1.symbol} por ${info.token0.symbol}`,
        `Largura: ${widthPct.toFixed(1)}%`,
        ...(shortWindow
          ? [
              "",
              `⚠️ Só consegui olhar ${formatWindowDuration(windowSeconds)} de histórico — o oráculo deste pool não guarda mais que isso (buffer de tamanho fixo, e pool muito negociado sobrescreve rápido). Janela curta enxerga menos oscilação, então esta faixa tende a ser MAIS APERTADA do que uma calibrada em dias. Considere alargar antes de usar.`,
            ]
          : []),
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
      "Não consegui calibrar por volatilidade real: o oráculo deste pool não alcança nem a menor janela que eu tento (2h).",
      "",
      // Causa real, medida ao vivo: o buffer do oráculo tem tamanho FIXO e é
      // circular. Pool muito negociado sobrescreve as posições antigas rápido
      // e o alcance histórico encolhe. A mensagem antiga sugeria pool parado,
      // que costuma ser exatamente o inverso do que está acontecendo.
      "Isso normalmente NÃO quer dizer pool parado — costuma ser o contrário. O histórico do oráculo cabe num buffer de tamanho fixo, então quanto mais o pool é negociado, menos tempo ele guarda.",
      "Considere olhar a distribuição de liquidez direto no app do Uniswap antes de decidir a faixa.",
    ].join("\n")
  );
}

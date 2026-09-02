import type { CommandContext, Context } from "grammy";
import type { Address } from "viem";
import { chainKeyFromDefillamaName, getActiveChains } from "../../config/chains.js";
import { getPoolById, parseFeeTierLabel } from "../../data/defillama/client.js";
import { fetchTickCumulatives, getPoolInfo } from "../../data/onchain/client.js";
import { getV4PoolInfo } from "../../data/onchain/client-v4.js";
import { formatBoundaryPrice, formatPrice, formatWindowDuration } from "../../domain/lp-rebalance/format-reason.js";
import { sqrtPriceX96ToPrice, tickSpacingForFee, tickToPrice } from "../../domain/lp-rebalance/price-math.js";
import { buildSecondsAgos, intervalAverageTicks, suggestVolatilityRange, VOLATILITY_WINDOWS } from "../../domain/lp-rebalance/volatility-range.js";
import { estimateVolatility, rangeForHorizon } from "../../domain/lp-rebalance/range-from-history.js";
import { backtestWidths, bestWidth } from "../../domain/lp-rebalance/width-backtest.js";
import { measurePoolYields } from "../../data/onchain/measure-pool-yield.js";
import { DEFAULT_REFERENCE } from "../../domain/market/fee-per-liquidity.js";
import { getPriceHistorySince } from "../../persistence/repositories/pool-price-history.repository.js";

// Sugestão de faixa ANTES de abrir uma posição — reaproveita a mesma
// calibração por volatilidade real (oráculo TWAP) usada no job automático
// pra reposicionar posições existentes, mas aqui não existe posição nenhuma
// ainda, então: (a) não há heurístico de fallback (esse espelha a largura
// de uma posição já existente, que não existe aqui) — sem histórico
// suficiente, a resposta é honesta sobre não ter o que sugerir; (b) o custo
// de gas usado na margem (ver computeMarginFraction em volatility-range.ts)
// é o valor de REFERÊNCIA, não o seu real — ele depende do tamanho da
// posição, que ainda não existe.
/** Janela lida do banco. 60 dias cobrem bem mais que o oráculo de qualquer
 *  pool e ainda são recentes o bastante pra refletir o regime atual. */
const HISTORY_LOOKBACK_DAYS = 60;
/** Horizontes oferecidos — 1 dia (surf), 3 dias e 1 semana. */
const HORIZONS_DAYS = [1, 3, 7];

/** Larguras testadas no backtest. Vai do bem apertado ao bem folgado: o ponto
 *  ótimo costuma cair na parte estreita, e sem as opções largas na tabela não
 *  dá pra VER que ele é estreito. */
const LARGURAS = [0.01, 0.02, 0.03, 0.04, 0.06, 0.083, 0.1];

/** Horizonte das janelas do backtest. 7 dias é o tempo que uma posição costuma
 *  ficar aberta aqui — o resultado muda com esse número, e fixá-lo em algo
 *  arbitrário esconderia isso. */
const HORIZONTE_BACKTEST_DIAS = 7;

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

  // FONTE PRIMÁRIA: o histórico que o próprio bot guarda (backfill + ingestão
  // de 15min). O oráculo do pool só entra como último recurso, e a razão é
  // metodológica, não de conveniência: o buffer dele tem tamanho fixo, então
  // pool muito negociado guarda MENOS tempo — a janela acabava sendo escolhida
  // por disponibilidade, não por qualidade, e quanto mais o preço se movia,
  // mais estreita saía a faixa. Ver domain/lp-rebalance/range-from-history.ts.
  // Junta o histórico de TODOS os pools do mesmo par nesta chain (V3 e V4).
  // Não é otimização: é correção de viés. As séries são o MESMO preço — a
  // arbitragem mantém os pools alinhados (verificado: em 23/08 ambos marcavam
  // ~$77,2k) — e usar só a de um pool faz a amostra depender de qual deles o
  // bot acompanhou por mais tempo. Sem juntar, o mesmo par dava volatilidade
  // de 1,87%/dia pelo V3 (33 dias) e 1,05% pelo V4 (4 dias), produzindo faixas
  // de 6,7% e 3,7% pro mesmo horizonte. Duas respostas diferentes pra mesma
  // pergunta, decididas por acaso de amostragem.
  const historySince = new Date(Date.now() - HISTORY_LOOKBACK_DAYS * 86400000);
  const [v3Pool, v4Pool] = await Promise.all([
    getPoolInfo(chainKey, tokenA, tokenB, fee).catch(() => null),
    getV4PoolInfo(chainKey, tokenA, tokenB, fee).catch(() => null),
  ]);
  const poolAddresses = [...new Set([v3Pool?.poolAddress, v4Pool?.poolAddress, info.poolAddress].filter(Boolean))] as string[];
  const histories = await Promise.all(poolAddresses.map((addr) => getPriceHistorySince(chainKey, addr, historySince)));
  const history = histories.flat();
  const estimate = estimateVolatility(history);

  if (estimate) {
    // A taxa medida on-chain é o que transforma "tempo em faixa" em retorno.
    // Sem ela ainda dá pra mostrar o tempo, que já é metade da decisão.
    const medicao = (
      await measurePoolYields([{ poolId, chain: pool.chain, project: pool.project, poolMeta: pool.poolMeta, underlyingTokens: pool.underlyingTokens }])
    ).get(poolId);

    const backtest = medicao
      ? backtestWidths(history, {
          widths: LARGURAS,
          horizonDays: HORIZONTE_BACKTEST_DIAS,
          aprAtReferenceWidth: medicao.aprInRange,
          referenceWidth: DEFAULT_REFERENCE.halfWidthLog,
        })
      : null;
    const melhor = bestWidth(backtest);

    const corpo: string[] = [header, priceLine, ""];

    if (backtest && melhor) {
      // A tabela é a resposta principal: ela responde "que largura rende
      // mais", que é a pergunta de quem vai abrir. A faixa por horizonte
      // (±1σ) desceu pra linha de apoio — ela responde "quanto tempo dura",
      // que é só metade.
      corpo.push(
        `Que largura rende mais, medido nos seus ${estimate.observedDays.toFixed(0)} dias de histórico (janelas de ${HORIZONTE_BACKTEST_DIAS} dias):`,
        ""
      );
      for (const w of backtest) {
        const low = currentPrice * Math.exp(-w.halfWidthLog);
        const high = currentPrice * Math.exp(w.halfWidthLog);
        const marca = w === melhor ? "  <- melhor" : "";
        corpo.push(
          `   ±${(w.halfWidthLog * 100).toFixed(1).padStart(4)}%  ${formatPrice(low)}–${formatPrice(high)}  ` +
            `em faixa ${(w.timeInRange * 100).toFixed(0).padStart(3)}%  ` +
            `taxa ${(w.grossApr * 100).toFixed(0).padStart(4)}%  ` +
            `efetivo ${(w.effectiveApr * 100).toFixed(0).padStart(4)}%${marca}`
        );
      }
      corpo.push(
        "",
        `Efetivo = taxa × tempo em faixa. Ficar parado fora da faixa custa menos que perder concentração — por isso o melhor costuma ser mais ESTREITO do que a intuição sugere.`,
        "",
        // Sem este aviso a tabela empurra pra faixa apertada sem dizer o preço
        // disso. O backtest só conta tempo em faixa; cada saída exige fechar e
        // reabrir, e isso custa gas e atenção que não estão em lugar nenhum
        // acima. Quanto menor o "em faixa", mais vezes por semana isso
        // acontece.
        `NÃO ESTÁ NA CONTA: reposicionar. Uma faixa com ${(melhor.timeInRange * 100).toFixed(0)}% de tempo dentro sai de faixa várias vezes por semana, e cada volta custa gas e exige você olhar. Se não pretende reposicionar, escolha pelo "em faixa" alto, não pelo efetivo.`,
        "",
        `Base: ${backtest[0]!.windows} janelas sobre ${estimate.pointCount} pontos de preço reais.`
      );
    } else {
      corpo.push(
        "Não consegui medir a taxa deste pool on-chain agora, então não dá pra anualizar o retorno por largura. Fica só a faixa por horizonte:"
      );
    }

    corpo.push(
      "",
      "Se preferir escolher por quanto tempo quer que ela aguente:",
      ...HORIZONS_DAYS.map((dias) => {
        const r = rangeForHorizon(estimate, currentPrice, dias);
        return `   ${String(dias).padStart(2)} dia${dias > 1 ? "s" : " "}: ${formatPrice(r.low)} – ${formatPrice(r.high)}  (${(r.widthPct * 100).toFixed(1)}% de largura)`;
      }),
      "",
      `Volatilidade medida: ${(estimate.dailyVolatility * 100).toFixed(2)}%/dia. Cada faixa acima cobre ~68% dos cenários (±1 desvio).`,
      "",
      "Isto é backtest, não previsão: mede o que teria acontecido no regime que já passou. Regime muda.",
      "",
      disclaimer
    );

    await ctx.reply(corpo.join("\n"));
    return;
  }

  // V4 não tem oráculo TWAP nativo (observe() virou hook opcional) — sem
  // tentar simular volatilidade por outra via, mostra só preço + faixa
  // honesta em vez de fingir uma calibração que não existe pra esse
  // protocolo (ver plano da Fase B).
  if (isV4) {
    await ctx.reply(
      [
        header,
        priceLine,
        "Ainda não consigo calibrar a faixa deste pool: não tenho histórico de preço suficiente dele, e o V4 não tem oráculo TWAP nativo pra consultar na hora (no V3 dá pra recorrer a ele).",
        "O bot grava um ponto de preço a cada 15min dos pools em que você tem posição — depois de alguns dias acompanhando, a calibração passa a funcionar.",
        "Considere olhar a distribuição de liquidez direto no app do Uniswap antes de decidir a faixa.",
      ].join("\n")
    );
    return;
  }

  // Sem histórico próprio suficiente, cai pro oráculo do pool — com todas as
  // ressalvas de viés acima.
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

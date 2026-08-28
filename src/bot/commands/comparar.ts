import { InputFile, type CommandContext, type Context } from "grammy";
import { getActiveChains, chains } from "../../config/chains.js";
import { fetchAllPools } from "../../data/defillama/client.js";
import { renderPairPlot, type PairPlotInput } from "../../data/chart/plot-pairs.js";
import { comparePoolsForPair, measuredSpread, normalizePairKey, rankPools, type ComparedPool } from "../../domain/market/pair-compare.js";
import { DEFAULT_REFERENCE, type ReferencePosition } from "../../domain/market/fee-per-liquidity.js";
import { measurePoolYields, MEASURE_WINDOW_DAYS, type PoolMeasurement } from "../../data/onchain/measure-pool-yield.js";
import { listPositionPairSymbols } from "../../persistence/repositories/lp-positions.repository.js";
import { listWatchedPairs } from "../../persistence/repositories/market.repository.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";

// "Existe lugar melhor pra fazer o que eu já faço?" — o mesmo par ranqueado
// entre chains. O dado sai de fetchAllPools(), que o bot já baixa: o dataset
// da DefiLlama traz TODAS as pools de TODAS as chains.

/** Piso de TVL só pra tirar poeira do ranking — pool minúsculo não é opção
 *  real e polui a lista. Bem abaixo do corte de segurança do /yield ($1M),
 *  porque aqui o objetivo é COMPARAR, não recomendar. */
const MIN_TVL_USD = 100_000;
const MAX_RESULTS = 8;

function formatMillions(usd: number): string {
  return `$${(usd / 1e6).toFixed(1)}M`;
}

// Prepara as linhas do gráfico e o texto que o acompanha.
//
// A tabela de texto foi ABANDONADA: o Telegram usa fonte proporcional fora de
// <pre>, e o resumo diário mandava sem parse_mode — o usuário via as tags
// cruas na tela. Mesmo com HTML certo, a tabela ficava apertada no celular.
// Gráfico não depende de fonte, de largura de tela nem de parse_mode.
/** Abaixo dessa razão entre a melhor e a pior medição, tratar as pools como
 *  equivalentes: a diferença cabe dentro do ruído da janela de medição, e
 *  apontar um "vencedor" seria precisão falsa. */
const SPREAD_EQUIVALENTE = 1.25;

function nomeCurto(p: ComparedPool): string {
  return `${p.chain} ${p.project.replace("uniswap-", "uni ")} ${p.poolMeta ?? ""}`.trim();
}

// Prepara as linhas do gráfico e o texto que o acompanha.
//
// MUDANÇA DE CRITÉRIO (28/08/2026): o ranking era por giro (volume/TVL) com
// desempate por apyBase. Os dois dividem por TVL, e TVL conta a liquidez que
// está FORA de faixa — que não ganha taxa nenhuma. Medindo as mesmas 4 pools
// on-chain, elas pagavam quase igual (96,6% a 104,9% de retorno pra uma
// posição de referência) enquanto o apyBase ia de 10,9% a 30,1%. O ranking
// antigo errava por ~2x e mandaria trocar de pool sem ganho nenhum.
// Ver domain/market/fee-per-liquidity.ts.
//
// A tabela de texto continua ABANDONADA: o Telegram usa fonte proporcional
// fora de <pre>, e o resumo diário mandava sem parse_mode — o usuário via as
// tags cruas. Gráfico não depende de fonte, largura de tela nem parse_mode.
export function preparePairComparison(
  pairKey: string,
  pools: ComparedPool[],
  measurements: Map<string, PoolMeasurement> = new Map(),
  ref: ReferencePosition = DEFAULT_REFERENCE
): { plot: PairPlotInput | null; text: string } {
  if (pools.length === 0) {
    return {
      plot: null,
      text: [
        `Nenhuma pool encontrada pro par ${pairKey} com TVL ≥ $${MIN_TVL_USD.toLocaleString("pt-BR")}.`,
        "",
        "Confira a grafia dos símbolos (ex: /comparar WBTC-USDC). O par precisa existir no dataset da DefiLlama — pools muito novos podem ainda não estar lá.",
      ].join("\n"),
    };
  }

  const todas = rankPools(pools, measurements);
  const ranked = todas.slice(0, MAX_RESULTS);
  const medidas = ranked.filter((p) => p.measured);
  // Conta sobre o par INTEIRO, não sobre a fatia exibida — senão o número
  // some junto com as linhas cortadas e o usuário não sabe o que ficou fora.
  const naoMedidas = todas.length - todas.filter((p) => p.measured).length;
  const larguraPct = (ref.halfWidthLog * 100).toFixed(0);
  const referencia = `$${ref.valueToken1.toLocaleString("pt-BR")} numa faixa de ±${larguraPct}%`;

  // Só desenha barras de APR quando há 2+ medições: uma barra sozinha não
  // compara nada, e misturar medido com estimado na mesma escala é
  // exatamente o erro que essa mudança veio corrigir.
  const usaApr = medidas.length >= 2;
  const plotPools = usaApr ? medidas : ranked;
  const plot: PairPlotInput = {
    pairKey,
    metric: usaApr ? "apr" : "turnover",
    pools: plotPools.map((p) => ({
      // Rótulo curto: no eixo Y do gráfico, nome de protocolo inteiro
      // ("uniswap-v3") come a área útil da imagem.
      label: `${p.chain} · ${p.project.replace("uniswap-", "uni ")} · ${p.poolMeta ?? "?"}`,
      turnover: p.turnover,
      tvlUsd: p.tvlUsd,
      apyBase: p.apyBase,
      aprInRange: p.measured?.aprInRange ?? null,
      isMonitorable: p.isMonitorable,
    })),
  };

  const linhas: string[] = [];

  if (medidas.length > 0) {
    linhas.push(
      `${pairKey} — medido on-chain, janela de ${MEASURE_WINDOW_DAYS} dias.`,
      "",
      `Quanto ${referencia} renderia por ano em cada pool, ENQUANTO a posição estiver em faixa:`,
      ""
    );
    for (const p of medidas) {
      const llama = p.apyBase !== null ? `DefiLlama dizia ${p.apyBase.toFixed(1)}%` : "DefiLlama não reporta";
      linhas.push(`  ${(p.measured!.aprInRange * 100).toFixed(0)}%/ano — ${nomeCurto(p)}  (${llama})`);
    }

    const spread = measuredSpread(ranked);
    linhas.push("");
    if (spread !== null && spread < SPREAD_EQUIVALENTE) {
      // O achado que motivou a mudança: pools do mesmo par se equilibram por
      // arbitragem de capital. Dizer isso vale mais que apontar um 1º lugar
      // cuja vantagem não sobrevive à próxima janela de medição.
      linhas.push(
        `Essas ${medidas.length} pools pagam praticamente o mesmo — ${((spread - 1) * 100).toFixed(0)}% de diferença entre a primeira e a última. É o esperado: se uma pool do mesmo par pagasse bem mais por unidade de liquidez, os LPs migrariam pra lá até equilibrar.`,
        "",
        "Ou seja: TROCAR DE POOL aqui muda pouco. O que muda seu retorno de verdade é a largura da faixa — faixa mais estreita concentra mais e rende mais por dólar, e sai de faixa mais rápido."
      );
    } else if (spread !== null) {
      const melhor = medidas[0]!;
      linhas.push(`A primeira paga ${spread.toFixed(2)}x o que a última paga — aqui a escolha da pool importa. Melhor medida: ${nomeCurto(melhor)}.`);
    }

    linhas.push(
      "",
      `Como é medido: feeGrowthGlobal é a taxa que o pool acumulou POR UNIDADE DE LIQUIDEZ; a diferença entre dois blocos, dividida pelo tempo, é exatamente o que sua posição ganha. Não passa por TVL — que é onde o apyBase da DefiLlama erra, por contar também a liquidez parada fora de faixa, que não ganha nada.`,
      "",
      "Ressalvas: o número é o retorno ENQUANTO EM FAIXA (fora dela é zero), não desconta IL nem gas, e a comparação só vale com a mesma largura nos dois lados — por isso a faixa de referência é fixa."
    );
    if (naoMedidas > 0) {
      linhas.push("", `Outras ${naoMedidas} pool(s) apareceram no par mas não deu pra medir: chain sem RPC configurado aqui, protocolo fora do Uniswap V3/V4, ou pool V4 com hook customizado. Ficaram de fora do ranking em vez de entrar com um número de régua diferente.`);
    }
  } else {
    // Nenhuma medição possível — cai pro giro, dizendo que é estimativa.
    const melhorMonitoravel = ranked.find((p) => p.isMonitorable && p.turnover !== null);
    linhas.push(`${pairKey} — não consegui medir nenhuma dessas pools on-chain (chain sem RPC aqui, ou protocolo fora do Uniswap V3/V4).`, "");
    if (melhorMonitoravel) {
      linhas.push(`Melhor opção que o bot acompanha, por GIRO (estimativa, não medição): ${nomeCurto(melhorMonitoravel)} — gira ${melhorMonitoravel.turnover!.toFixed(2)}x por dia, TVL $${(melhorMonitoravel.tvlUsd / 1e6).toFixed(1)}M.`, "");
    }
    linhas.push(
      "Giro = volume negociado em 24h ÷ TVL do pool: quantas vezes por dia o capital do pool é negociado. Mais giro tende a ser mais taxa por dólar aplicado.",
      "",
      "Mas giro divide por TVL, e TVL inclui a liquidez que está fora de faixa e não ganha nada — então ele erra na direção de premiar pool com liquidez espalhada. É estimativa, não medida."
    );
  }

  return { plot, text: linhas.join("\n") };
}

export async function compararCommand(ctx: CommandContext<Context>) {
  const arg = ctx.match?.toString().trim();
  const monitorable = getActiveChains().map((c) => chains[c].defillamaChainName);

  let pairKeys: string[];
  if (arg) {
    const key = normalizePairKey(arg);
    if (!key) {
      await ctx.reply(
        [
          "Uso: /comparar <par>",
          "Ex: /comparar WBTC-USDC",
          "",
          "Só pares (2 tokens), separados por hífen. Sem argumento, uso os pares das suas posições.",
        ].join("\n")
      );
      return;
    }
    pairKeys = [key];
  } else {
    const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
    const [fromPositions, watched] = await Promise.all([listPositionPairSymbols(user.id), listWatchedPairs(user.id)]);
    const keys = new Set<string>();
    for (const symbol of fromPositions) {
      const k = normalizePairKey(symbol);
      if (k) keys.add(k);
    }
    for (const k of watched) keys.add(k);
    pairKeys = [...keys];

    if (pairKeys.length === 0) {
      await ctx.reply(
        [
          "Você ainda não tem posição nem par acompanhado, então não sei o que comparar.",
          "",
          "Peça um par direto (/comparar WBTC-USDC) ou adicione um à sua lista (/watchpair WBTC-USDC).",
        ].join("\n")
      );
      return;
    }
  }

  const allPools = await fetchAllPools();
  const comparable = allPools
    .filter((p) => p.tvlUsd >= MIN_TVL_USD && !p.outlier)
    .map((p) => ({
      poolId: p.pool,
      chain: p.chain,
      project: p.project,
      symbol: p.symbol,
      tvlUsd: p.tvlUsd,
      volumeUsd1d: p.volumeUsd1d,
      apyBase: p.apyBase,
      apy: p.apy,
      poolMeta: p.poolMeta,
      underlyingTokens: p.underlyingTokens,
    }));

  for (const pairKey of pairKeys) {
    const doPar = comparePoolsForPair(comparable, pairKey, monitorable);
    // Medição on-chain só das pools DESSE par (não do dataset inteiro): são
    // ~4 chamadas de RPC por pool, mais 2 por chain pra localizar os blocos.
    const measurements = await measurePoolYields(
      doPar.map((p) => ({ poolId: p.poolId, chain: p.chain, project: p.project, poolMeta: p.poolMeta, underlyingTokens: p.underlyingTokens }))
    );
    const { plot, text } = preparePairComparison(pairKey, doPar, measurements);
    if (plot) {
      try {
        await ctx.replyWithPhoto(new InputFile(await renderPairPlot(plot), "comparar.png"));
      } catch (err) {
        // Gráfico é enriquecimento — sem .venv na máquina, o texto ainda vale.
        console.error("[comparar] falha ao gerar gráfico:", err);
      }
    }
    await ctx.reply(text);
  }
}

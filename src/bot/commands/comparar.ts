import { InputFile, type CommandContext, type Context } from "grammy";
import { getActiveChains, chains } from "../../config/chains.js";
import { fetchAllPools } from "../../data/defillama/client.js";
import { renderPairPlot, type PairPlotInput } from "../../data/chart/plot-pairs.js";
import { comparePoolsForPair, normalizePairKey, type ComparedPool } from "../../domain/market/pair-compare.js";
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
export function preparePairComparison(
  pairKey: string,
  pools: ComparedPool[]
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

  // Ordena por GIRO. Duas exceções vão pro fim em vez de liderar:
  //   - sem volume reportado (turnover null) — não é o mesmo que giro zero;
  //   - sem taxa reportada (apyBase null ou 0) — pool de fee dinâmica via
  //     hook, que a DefiLlama não precifica. Giro alto sem retorno mensurável
  //     não é recomendação, é ruído (um deles chegou a aparecer em 1º).
  const isRankable = (p: ComparedPool) => p.turnover !== null && p.apyBase !== null && p.apyBase > 0;
  const sorted = [...pools]
    .sort((a, b) => {
      const rankable = Number(isRankable(b)) - Number(isRankable(a));
      if (rankable !== 0) return rankable;
      return (b.turnover ?? -1) - (a.turnover ?? -1);
    })
    .slice(0, MAX_RESULTS);

  const plot: PairPlotInput = {
    pairKey,
    pools: sorted.map((p) => ({
      // Rótulo curto: no eixo Y do gráfico, nome de protocolo inteiro
      // ("uniswap-v3") come a área útil da imagem.
      label: `${p.chain} · ${p.project.replace("uniswap-", "uni ")} · ${p.poolMeta ?? "?"}`,
      turnover: p.turnover,
      tvlUsd: p.tvlUsd,
      apyBase: p.apyBase,
      isMonitorable: p.isMonitorable,
    })),
  };

  // O destaque é a melhor opção MONITORÁVEL, não a melhor absoluta: a pergunta
  // por trás do comando é "vale mudar minha posição?", e sugerir uma chain que
  // o bot não acompanha (ou um pool de TVL irrisório) responde outra pergunta.
  // Se a líder absoluta for não-monitorável, isso é dito à parte, sem virar
  // recomendação.
  const nome = (p: ComparedPool) => `${p.chain} ${p.project.replace("uniswap-", "uni ")} ${p.poolMeta ?? ""}`.trim();
  const melhorMonitoravel = sorted.find((p) => p.isMonitorable && p.turnover !== null);
  const lider = sorted[0];

  const destaque: string[] = [];
  if (melhorMonitoravel) {
    destaque.push(
      `Melhor opção que o bot acompanha: ${nome(melhorMonitoravel)} — gira ${melhorMonitoravel.turnover!.toFixed(2)}x por dia, TVL $${(melhorMonitoravel.tvlUsd / 1e6).toFixed(1)}M.`
    );
  }
  if (lider && !lider.isMonitorable && lider.turnover !== null) {
    destaque.push(
      `(${nome(lider)} gira mais — ${lider.turnover.toFixed(2)}x — mas fica numa chain sem monitoramento.)`
    );
  }

  return {
    plot,
    text: [
      ...destaque,
      "",
      // O usuário pediu explicitamente pra explicar o que é giro.
      "Giro = volume negociado em 24h ÷ TVL do pool: quantas vezes por dia o capital do pool é negociado. Giro 1,0 significa que o pool movimentou o próprio tamanho em um dia — e como a taxa é cobrada por negociação, mais giro é mais taxa pra cada dólar aplicado.",
      "",
      // O ranking não normaliza gas nem risco de chain — sem este aviso, a
      // comparação induz a erro.
      "Giro não é o único critério: ele ignora custo de gas da chain, risco de bridge e profundidade real na sua faixa. TVL baixo gira mais fácil — e escorrega mais fácil.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
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
    }));

  for (const pairKey of pairKeys) {
    const { plot, text } = preparePairComparison(pairKey, comparePoolsForPair(comparable, pairKey, monitorable));
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

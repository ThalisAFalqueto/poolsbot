import type { CommandContext, Context } from "grammy";
import { getActiveChains, chains } from "../../config/chains.js";
import { fetchAllPools } from "../../data/defillama/client.js";
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

// Escapa o que o Telegram interpretaria como marcação HTML. Símbolo de token
// é texto livre vindo da DefiLlama — um "<" perdido quebraria a mensagem
// inteira, não só aquela linha.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatPairComparison(pairKey: string, pools: ComparedPool[]): string {
  if (pools.length === 0) {
    return [
      `Nenhuma pool encontrada pro par ${escapeHtml(pairKey)} com TVL ≥ $${MIN_TVL_USD.toLocaleString("pt-BR")}.`,
      "",
      "Confira a grafia dos símbolos (ex: /comparar WBTC-USDC). O par precisa existir no dataset da DefiLlama — pools muito novos podem ainda não estar lá.",
    ].join("\n");
  }

  // Ordena por GIRO (volume/TVL), que é o que o usuário pediu: quanto o
  // capital do pool trabalha por dia. Duas exceções empurram linhas pro fim
  // em vez de deixá-las liderar o ranking:
  //   - sem volume reportado (turnover null) — não é o mesmo que giro zero;
  //   - sem taxa reportada (apyBase null ou 0) — acontece com pool de fee
  //     dinâmica via hook, que a DefiLlama não consegue precificar. Um pool
  //     desses chegou a aparecer em 1º com giro 10,4 e apyBase 0,0%, o que é
  //     o oposto de "melhor taxa": giro alto sem retorno mensurável não é
  //     recomendação, é ruído.
  const isRankable = (p: ComparedPool) => p.turnover !== null && p.apyBase !== null && p.apyBase > 0;
  const sorted = [...pools]
    .sort((a, b) => {
      const rankable = Number(isRankable(b)) - Number(isRankable(a));
      if (rankable !== 0) return rankable;
      return (b.turnover ?? -1) - (a.turnover ?? -1);
    })
    .slice(0, MAX_RESULTS);

  // Tabela dentro de <pre>: é o ÚNICO jeito de o Telegram usar fonte
  // monoespaçada. Fora dele, alinhar com espaços não funciona (a fonte é
  // proporcional) e as colunas saem tortas — foi o que aconteceu na 1ª versão.
  const rows = sorted.map((p) => {
    const chain = escapeHtml(p.chain).slice(0, 9).padEnd(9);
    const proj = escapeHtml(p.project.replace("uniswap-", "uni ")).slice(0, 10).padEnd(10);
    const fee = escapeHtml(p.poolMeta ?? "?").slice(0, 6).padEnd(6);
    const tvl = formatMillions(p.tvlUsd).padStart(7);
    const giro = (p.turnover === null ? "n/d" : p.turnover.toFixed(2)).padStart(5);
    const apy = (p.apyBase !== null ? `${p.apyBase.toFixed(1)}%` : "n/d").padStart(6);
    const flag = p.isMonitorable ? "  " : " !";
    return `${chain} ${proj} ${fee} ${tvl} ${giro} ${apy}${flag}`;
  });
  const head = `${"chain".padEnd(9)} ${"protocolo".padEnd(10)} ${"taxa".padEnd(6)} ${"TVL".padStart(7)} ${"giro".padStart(5)} ${"apyBase".padStart(6)}`;

  const hasUnmonitorable = sorted.some((p) => !p.isMonitorable);

  return [
    `🔀 <b>${escapeHtml(pairKey)}</b> entre chains, do maior giro pro menor:`,
    "",
    `<pre>${head}\n${"─".repeat(head.length + 2)}\n${rows.join("\n")}</pre>`,
    // O usuário pediu explicitamente pra explicar o que é giro — sem isso a
    // coluna mais importante da tabela é um número sem significado.
    "<b>Giro</b> = volume negociado em 24h ÷ TVL do pool. É quantas vezes por dia o capital do pool é negociado. Giro 1,0 significa que o pool movimentou o próprio tamanho em um dia — e como a taxa é cobrada por negociação, mais giro é mais taxa pra cada dólar aplicado.",
    "",
    ...(hasUnmonitorable ? ["<b>!</b> = chain que o bot NÃO acompanha hoje: abrir posição lá te deixa sem monitoramento, alerta de faixa e P&amp;L.", ""] : []),
    // O score de risco do /yield não normaliza custo de gas nem risco de
    // bridge — nada distingue Arbitrum de uma chain obscura além do TVL. Sem
    // este aviso, a comparação induz a erro.
    "Giro alto não é o único critério: ele ignora custo de gas da chain, risco de bridge e profundidade real na sua faixa. TVL baixo gira mais fácil — e escorrega mais fácil.",
  ].join("\n");
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
    await ctx.reply(formatPairComparison(pairKey, comparePoolsForPair(comparable, pairKey, monitorable)), { parse_mode: "HTML" });
  }
}

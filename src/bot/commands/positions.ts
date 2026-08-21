import type { CommandContext, Context } from "grammy";
import type { Address } from "viem";
import { chains, getActiveChains } from "../../config/chains.js";
import { fetchPositionsForWallets, fetchUncollectedFees, type UncollectedFees } from "../../data/onchain/client.js";
import { calculateRealizedApr, type AprResult } from "../../domain/lp-rebalance/calculate-apr.js";
import { calculateImpermanentLoss, type ImpermanentLossResult } from "../../domain/lp-rebalance/calculate-il.js";
import { calculatePnl, type PnlResult } from "../../domain/lp-rebalance/calculate-pnl.js";
import { formatBoundaryPrice, formatPrice } from "../../domain/lp-rebalance/format-reason.js";
import { isInRange, sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { isStablecoinSymbol } from "../../domain/lp-rebalance/stablecoins.js";
import type { OnchainPosition } from "../../domain/lp-rebalance/types.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { listWallets } from "../../persistence/repositories/user-wallets.repository.js";
import {
  syncIlBaseline,
  toPositionUpsertInput,
  upsertPositions,
} from "../../persistence/repositories/lp-positions.repository.js";

// tokenId é um contador por contrato NPM, não globalmente único entre
// chains — a posição #12345 na Arbitrum e a #12345 na Base são coisas
// diferentes. Toda Map indexada por posição usa essa chave composta.
function positionKey(chain: string, tokenId: bigint | string): string {
  return `${chain}:${tokenId}`;
}

// Meta declarada do usuário pro projeto (≥3%/mês) — hoje o bot é de uso
// pessoal, então fica hardcoded; se algum dia virar multi-usuário, isso
// precisaria virar uma preferência por usuário.
const TARGET_MONTHLY_PCT = 0.03;

const PNL_DISCLAIMER =
  "* Valores calculados desde que o poolsbot passou a monitorar cada posição (não é a abertura on-chain real). Fees são as coletáveis agora, via simulação de collect() sem gastar gas — entram no P&L total, mas não no IL isolado.";

// Telegram limita mensagens a 4096 caracteres. Em vez de truncar e esconder
// posições (silenciosamente omitir uma que esteja fora de range seria um
// problema real, não só estético), a lista inteira é paginada em várias
// mensagens quando não cabe numa só.
//
// Este número NÃO é o limite bruto do Telegram — chunkLines só bounda o
// tamanho dos BLOCOS de posição, mas cabeçalho + resumo do portfólio (só na
// 1ª página) + PNL_DISCLAIMER (227 caracteres, só na última) são colados
// DEPOIS da divisão em páginas, sem entrar nessa conta. Bug real encontrado
// em produção (20/08/2026): com poucas posições mas de MOEDAS DE COTAÇÃO
// diferentes (resumo cresce, 1 linha por moeda), o colchão de 4096-3500=596
// não bastou e o Telegram rejeitou com "message is too long" — não era
// sobre volume de posições, era sobre o resumo ter ficado maior que o
// colchão reservado. 3200 deixa ~900 de colchão (cabeçalho ~60 +
// disclaimer 227 + até ~600 pro resumo, generoso pra qualquer portfólio
// realista).
const MAX_MESSAGE_CHARS = 3200;

// 4 casas decimais pros amounts de token (formatPrice usa 2, que zeraria
// quantidades pequenas de WETH); os VALORES em token1 continuam com 2 casas.
function formatAmount(value: number): string {
  return value.toFixed(4);
}

type FeesAmounts = { amount0: number; amount1: number };

// endereço encurtado (0x1234…abcd) como fallback quando a wallet não tem
// rótulo — só é chamado quando o usuário tem 2+ wallets vinculadas.
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Genérica pra reaproveitar entre APR total (fees+preço) e APR só-de-taxas
// (equivalente ao "fee APR" que ferramentas tipo Revert Finance mostram
// separado do "total APR" — a diferença entre os dois é o efeito do IL).
function formatAprLine(apr: AprResult | null, label: string): string {
  if (!apr) return `${label}: indisponível (fees desconhecidas)`;
  if (apr.unreliableReason === "too_new") {
    const hours = Math.max(0, Math.round(apr.elapsedDays * 24));
    return `${label}: cedo demais pra estimar (observando há ${hours}h)`;
  }
  if (apr.unreliableReason === "implausible") {
    return `${label}: não confiável (posição com valor de entrada residual)`;
  }
  const monthlyPct = (apr.monthlyEquivalentPct * 100).toFixed(1);
  const annualPct = (apr.annualizedPct * 100).toFixed(1);
  return `${label}: ${apr.monthlyEquivalentPct >= 0 ? "+" : ""}${monthlyPct}%/mês (${apr.annualizedPct >= 0 ? "+" : ""}${annualPct}%/ano)`;
}

// "ROI" no sentido que ferramentas tipo Revert Finance usam: retorno
// CUMULATIVO em taxas desde a entrada, sem anualizar (diferente do "fee
// APR" acima, que já é anualizado/mensalizado) — só faz sentido mostrar
// quando o cálculo é confiável (senão simpleReturnPct vem zerado por
// construção, ver calculate-apr.ts).
function formatFeeAprLine(feeApr: AprResult | null): string {
  const aprLine = formatAprLine(feeApr, "Rentabilidade em taxas");
  if (!feeApr?.reliable) return aprLine;
  const roiPct = (feeApr.simpleReturnPct * 100).toFixed(2);
  return `${aprLine} · ROI acumulado em taxas: ${feeApr.simpleReturnPct >= 0 ? "+" : ""}${roiPct}%`;
}

// Comparação explícita contra "só ter segurado" a composição de entrada —
// o dado (hodlValueToken1/ilToken1) já existia em calculate-pnl.ts, só não
// era exibido como linha própria. vsHold = ilToken1 + feesValueToken1: se
// as fees coletadas superam o IL (divergence loss), o resultado é positivo
// (mesma lógica que Revert Finance anota como "Total Fee > Div. Loss =
// Lucro"). "≈ USD" só aparece quando token1 É uma stablecoin reconhecida —
// não uma conversão via oráculo, que o projeto deliberadamente não usa.
function formatHoldLine(pnl: PnlResult | null, token1Symbol: string): string {
  if (!pnl) return "vs HOLD: indisponível (fees desconhecidas)";
  const vsHold = pnl.ilToken1 + pnl.feesValueToken1;
  const vsHoldPct = pnl.entryValueToken1 > 0 ? (vsHold / pnl.entryValueToken1) * 100 : null;
  const pctText = vsHoldPct !== null ? ` (${vsHoldPct >= 0 ? "+" : ""}${vsHoldPct.toFixed(2)}%)` : "";
  const usdNote = isStablecoinSymbol(token1Symbol) ? " ≈ USD" : "";
  return `Se tivesse feito HOLD: ${formatPrice(pnl.hodlValueToken1)} ${token1Symbol}${usdNote} · LP vs HOLD: ${vsHold >= 0 ? "+" : ""}${formatPrice(vsHold)} ${token1Symbol}${pctText}`;
}

function formatAgeLine(apr: AprResult | null): string {
  if (!apr) return "Idade: indisponível";
  if (apr.elapsedDays < 1) {
    const hours = Math.max(0, Math.round(apr.elapsedDays * 24));
    return `Idade: ${hours}h`;
  }
  return `Idade: ${apr.elapsedDays.toFixed(1)} dias`;
}

function buildPositionBlock(
  p: OnchainPosition,
  il: ImpermanentLossResult,
  pnl: PnlResult | null,
  fees: FeesAmounts | null,
  wasReset: boolean,
  walletLabel: string | null,
  apr: AprResult | null,
  feeApr: AprResult | null
): string {
  const inRange = isInRange(p.currentTick, p.tickLower, p.tickUpper);
  const low = formatBoundaryPrice(p.tickLower, p.token0.decimals, p.token1.decimals);
  const high = formatBoundaryPrice(p.tickUpper, p.token0.decimals, p.token1.decimals);
  const current = formatPrice(sqrtPriceX96ToPrice(p.sqrtPriceX96, p.token0.decimals, p.token1.decimals));
  const status = inRange ? "✅" : "🚨";
  const chainName = chains[p.chain].defillamaChainName;
  const walletTag = walletLabel ? `, ${walletLabel}` : "";
  const headerLine = `${status} ${p.token0.symbol}/${p.token1.symbol} ${(p.fee / 10000).toFixed(2)}% (${chainName}${walletTag}) — faixa ${low}–${high}, atual ${current} ${p.token1.symbol} por ${p.token0.symbol} (#${p.tokenId})`;

  const since = il.since.toLocaleDateString("pt-BR");
  const resetNote = wasReset ? " (resetado)" : "";
  const entryLine = pnl
    ? `Entrada (${since}${resetNote}): ${formatAmount(il.baselineAmount0)} ${p.token0.symbol} + ${formatAmount(il.baselineAmount1)} ${p.token1.symbol} ≈ ${formatPrice(pnl.entryValueToken1)} ${p.token1.symbol}`
    : `Entrada (${since}${resetNote}): ${formatAmount(il.baselineAmount0)} ${p.token0.symbol} + ${formatAmount(il.baselineAmount1)} ${p.token1.symbol}`;
  const currentLine = `Atual: ${formatAmount(il.currentAmount0)} ${p.token0.symbol} + ${formatAmount(il.currentAmount1)} ${p.token1.symbol} ≈ ${formatPrice(il.positionValueToken1)} ${p.token1.symbol}`;

  const feesLine =
    fees && pnl
      ? `Fees coletáveis: ${formatAmount(fees.amount0)} ${p.token0.symbol} + ${formatAmount(fees.amount1)} ${p.token1.symbol} ≈ ${formatPrice(pnl.feesValueToken1)} ${p.token1.symbol}`
      : "Fees coletáveis: indisponível (falha ao simular collect())";
  const summaryLine = pnl
    ? `Movimento de preço: ${pnl.priceMovementToken1 >= 0 ? "+" : ""}${formatPrice(pnl.priceMovementToken1)} ${p.token1.symbol} · IL: ${(il.ilPct * 100).toFixed(2)}% (${formatPrice(pnl.ilToken1)} ${p.token1.symbol}) · P&L total (com fees): ${pnl.totalPnlToken1 >= 0 ? "+" : ""}${formatPrice(pnl.totalPnlToken1)} ${p.token1.symbol}`
    : `IL: ${(il.ilPct * 100).toFixed(2)}% · P&L total: indisponível (fees desconhecidas)`;

  const holdLine = formatHoldLine(pnl, p.token1.symbol);
  const aprLine = formatAprLine(apr, "APR realizado");
  const feeAprLine = formatFeeAprLine(feeApr);
  const ageLine = formatAgeLine(apr);

  return [
    headerLine,
    `   ${entryLine}`,
    `   ${currentLine}`,
    `   ${feesLine}`,
    `   ${summaryLine}`,
    `   ${holdLine}`,
    `   ${aprLine}`,
    `   ${feeAprLine}`,
    `   ${ageLine}`,
  ].join("\n");
}

type SummaryEntry = {
  token1Address: string;
  token1Symbol: string;
  entryValue: number;
  currentValue: number;
  feesValue: number;
  totalPnl: number;
  // totalPnl escalado pra uma janela de 30 dias (totalPnl * 30/elapsedDays),
  // já pronto pra somar direto num grupo e dividir pela soma de entryValue —
  // dá a média ponderada por capital do retorno mensal. null quando a
  // posição é nova demais pra ter uma estimativa confiável (ver
  // calculate-apr.ts) — fica de fora da média, mas é contada à parte.
  monthlyEquivalentPnl: number | null;
};

// Posições podem ter moedas de cotação (token1) diferentes entre si — somar
// um valor "em USDC" com um "em LINK" não faz sentido sem um oráculo de
// preço USD, que o projeto deliberadamente não usa (ver domain/calculate-il.ts:
// token1 como unidade de conta é matematicamente exato POR POSIÇÃO, mas não
// convertível entre posições sem mais uma fonte de dado). Em vez de um total
// único, agrupa por token1 e soma dentro de cada grupo — correto sempre, e
// colapsa num total só quando o usuário só usa uma moeda de cotação. Isso
// também separa corretamente entre chains sem precisar de chave composta
// aqui: o mesmo símbolo (ex. USDC) tem um ENDEREÇO diferente em cada chain,
// então agrupar por endereço já isola por chain automaticamente.
function buildPortfolioSummary(entries: SummaryEntry[]): string[] {
  if (entries.length === 0) return [];

  const groups = new Map<
    string,
    { symbol: string; count: number; entry: number; current: number; fees: number; pnl: number; monthlyPnl: number; monthlyEntry: number; tooNew: number }
  >();
  for (const e of entries) {
    const g = groups.get(e.token1Address) ?? {
      symbol: e.token1Symbol,
      count: 0,
      entry: 0,
      current: 0,
      fees: 0,
      pnl: 0,
      monthlyPnl: 0,
      monthlyEntry: 0,
      tooNew: 0,
    };
    g.count += 1;
    g.entry += e.entryValue;
    g.current += e.currentValue;
    g.fees += e.feesValue;
    g.pnl += e.totalPnl;
    if (e.monthlyEquivalentPnl !== null) {
      g.monthlyPnl += e.monthlyEquivalentPnl;
      g.monthlyEntry += e.entryValue;
    } else {
      g.tooNew += 1;
    }
    groups.set(e.token1Address, g);
  }

  const lines = [...groups.values()].flatMap((g) => {
    const summaryLine = `${g.count} posiç${g.count === 1 ? "ão" : "ões"} em ${g.symbol}: entrada ${formatPrice(g.entry)} · atual ${formatPrice(g.current)} · fees ${formatPrice(g.fees)} · P&L total ${g.pnl >= 0 ? "+" : ""}${formatPrice(g.pnl)} ${g.symbol}`;

    if (g.monthlyEntry <= 0) {
      const tooNewNote = g.tooNew > 0 ? ` (${g.tooNew} muito nova${g.tooNew === 1 ? "" : "s"} pra estimar)` : "";
      return [summaryLine, `   Retorno médio ponderado: indisponível${tooNewNote}`];
    }

    const weightedMonthlyPct = g.monthlyPnl / g.monthlyEntry;
    const hitTarget = weightedMonthlyPct >= TARGET_MONTHLY_PCT;
    const gapPct = Math.abs((weightedMonthlyPct / TARGET_MONTHLY_PCT - 1) * 100).toFixed(0);
    const status = hitTarget ? `✅ ${gapPct}% acima da meta` : `⚠️ ${gapPct}% abaixo da meta`;
    const tooNewNote = g.tooNew > 0 ? ` (+${g.tooNew} muito nova${g.tooNew === 1 ? "" : "s"} pra entrar na média)` : "";
    return [
      summaryLine,
      `   Retorno médio ponderado: ${(weightedMonthlyPct * 100).toFixed(1)}%/mês (meta: ${(TARGET_MONTHLY_PCT * 100).toFixed(0)}%/mês) ${status}${tooNewNote}`,
    ];
  });

  return ["📊 Resumo do portfólio (por moeda de cotação):", ...lines, ""];
}

function chunkLines(lines: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 pro "\n" de junção
    if (current.length > 0 && currentLen + lineLen > maxChars) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function positionsCommand(ctx: CommandContext<Context>) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const wallets = await listWallets(user.id);
  if (wallets.length === 0) {
    await ctx.reply("Nenhuma wallet vinculada ainda. Use /addwallet <endereço> primeiro.");
    return;
  }
  const walletLabelByAddress = new Map(wallets.map((w) => [w.address, w.label]));
  const showWalletTag = wallets.length > 1;

  const activeChains = getActiveChains();
  const perChain = await fetchPositionsForWallets(
    wallets.map((w) => w.address as Address),
    activeChains
  );
  const positions = perChain.flatMap((c) => c.positions);
  if (positions.length === 0) {
    const chainNames = activeChains.map((c) => chains[c].defillamaChainName).join(", ");
    await ctx.reply(`Nenhuma posição de liquidez ativa encontrada nessas wallets (Uniswap V3) em ${chainNames}.`);
    return;
  }

  // /positions continua "sempre fresco" pros dados exibidos (nunca lê a
  // lista de posições do banco) — mas grava identidade+baseline como efeito
  // colateral idempotente, resolvendo o caso de uma wallet nova que ainda
  // não passou pelo ciclo de 15min do scheduler. Não chama
  // deleteStalePositions aqui: reconciliação completa fica só no job, pra
  // evitar duas fontes de escrita concorrentes na mesma linha.
  //
  // fetchUncollectedFees roda por (chain, wallet): collect() exige que
  // msg.sender seja o DONO da posição, então não dá pra simular pra todas
  // as posições de uma chain de uma vez só se elas vierem de wallets
  // diferentes — precisa agrupar por wallet dentro de cada chain primeiro.
  const [upserted, feesEntries] = await Promise.all([
    upsertPositions(positions.map((p) => toPositionUpsertInput(user.id, p.chain, p))),
    Promise.all(
      perChain.flatMap(({ chain, positions: chainPositions }) => {
        const byWallet = new Map<Address, OnchainPosition[]>();
        for (const p of chainPositions) {
          byWallet.set(p.walletAddress, [...(byWallet.get(p.walletAddress) ?? []), p]);
        }
        return [...byWallet.entries()].map(async ([walletAddress, walletPositions]) => {
          const fees = await fetchUncollectedFees(chain, walletAddress, walletPositions);
          return [...fees.entries()].map(([tokenId, amounts]) => [positionKey(chain, tokenId), amounts] as const);
        });
      })
    ),
  ]);
  const upsertedByTokenId = new Map(upserted.map((u) => [positionKey(u.chain, u.tokenId), u]));
  const feesByTokenId = new Map(feesEntries.flat());

  // Fora de range primeiro — é o que precisa de atenção. Com paginação isso
  // já bastaria, mas também garante que a 1ª mensagem sempre traz o que
  // importa mesmo que o usuário não role até a última página. Em caso de
  // empate, agrupa por wallet (ordem em que foi vinculada) — só cosmético,
  // deixa a lista mais fácil de ler quando há mais de uma.
  const now = new Date();
  const walletOrder = new Map(wallets.map((w, i) => [w.address, i]));
  const sorted = [...positions].sort((a, b) => {
    const aOut = isInRange(a.currentTick, a.tickLower, a.tickUpper) ? 1 : 0;
    const bOut = isInRange(b.currentTick, b.tickLower, b.tickUpper) ? 1 : 0;
    if (aOut !== bOut) return aOut - bOut;
    return (walletOrder.get(a.walletAddress) ?? 0) - (walletOrder.get(b.walletAddress) ?? 0);
  });

  const results = await Promise.all(
    sorted.map(async (p) => {
      const record = upsertedByTokenId.get(positionKey(p.chain, p.tokenId));
      if (!record) {
        return {
          block: `❔ ${p.token0.symbol}/${p.token1.symbol} (#${p.tokenId})\n   Indisponível: falha ao sincronizar posição.`,
          summaryEntry: null as SummaryEntry | null,
        };
      }

      const baseline = await syncIlBaseline(record.id, {
        liquidity: p.liquidity,
        sqrtPriceX96: p.sqrtPriceX96,
        tick: p.currentTick,
      });
      const il = calculateImpermanentLoss({
        liquidity: p.liquidity,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        decimals0: p.token0.decimals,
        decimals1: p.token1.decimals,
        baselineSqrtPriceX96: baseline.sqrtPriceX96,
        baselineRecordedAt: baseline.recordedAt,
        currentSqrtPriceX96: p.sqrtPriceX96,
      });

      const rawFees: UncollectedFees | undefined = feesByTokenId.get(positionKey(p.chain, p.tokenId));
      const fees: FeesAmounts | null = rawFees
        ? {
            amount0: Number(rawFees.amount0) / 10 ** p.token0.decimals,
            amount1: Number(rawFees.amount1) / 10 ** p.token1.decimals,
          }
        : null;
      const pnl = fees
        ? calculatePnl({
            il,
            entryPriceToken1: sqrtPriceX96ToPrice(baseline.sqrtPriceX96, p.token0.decimals, p.token1.decimals),
            currentPriceToken1: sqrtPriceX96ToPrice(p.sqrtPriceX96, p.token0.decimals, p.token1.decimals),
            feesAmount0: fees.amount0,
            feesAmount1: fees.amount1,
          })
        : null;

      const apr = pnl
        ? calculateRealizedApr({ entryValueToken1: pnl.entryValueToken1, totalPnlToken1: pnl.totalPnlToken1, since: il.since, now })
        : null;
      // Mesma função, só trocando o P&L de entrada — isola o retorno SÓ de
      // taxas (equivalente ao "fee APR" que ferramentas tipo Revert Finance
      // mostram separado do "total APR", já que o total é puxado pra baixo
      // pelo IL).
      const feeApr = pnl
        ? calculateRealizedApr({ entryValueToken1: pnl.entryValueToken1, totalPnlToken1: pnl.feesValueToken1, since: il.since, now })
        : null;

      const summaryEntry: SummaryEntry | null = pnl
        ? {
            token1Address: p.token1.address,
            token1Symbol: p.token1.symbol,
            entryValue: pnl.entryValueToken1,
            currentValue: pnl.positionValueToken1,
            feesValue: pnl.feesValueToken1,
            totalPnl: pnl.totalPnlToken1,
            monthlyEquivalentPnl: apr?.reliable ? pnl.totalPnlToken1 * (30 / apr.elapsedDays) : null,
          }
        : null;

      const walletLabel = showWalletTag ? (walletLabelByAddress.get(p.walletAddress) ?? shortAddress(p.walletAddress)) : null;
      return {
        block: buildPositionBlock(p, il, pnl, fees, baseline.wasReset, walletLabel, apr, feeApr),
        walletAddress: p.walletAddress,
        summaryEntry,
      };
    })
  );

  // Linha em branco entre blocos de wallets diferentes — só quando há mais
  // de uma vinculada (senão nunca muda, nunca insere nada).
  const blocks = results.flatMap((r, i) => {
    const separator = showWalletTag && i > 0 && results[i - 1]!.walletAddress !== r.walletAddress ? [""] : [];
    return [...separator, r.block];
  });
  const summaryEntries = results.flatMap((r) => (r.summaryEntry ? [r.summaryEntry] : []));
  const summaryLines = buildPortfolioSummary(summaryEntries);

  const pages = chunkLines(blocks, MAX_MESSAGE_CHARS);

  for (const [i, pageLines] of pages.entries()) {
    const header =
      i === 0
        ? `Suas posições de LP (${positions.length}):`
        : `Suas posições de LP — continuação (${i + 1}/${pages.length}):`;
    const summary = i === 0 ? summaryLines : [];
    const footer = i === pages.length - 1 ? `\n\n${PNL_DISCLAIMER}` : "";
    await ctx.reply([header, ...summary, ...pageLines].join("\n") + footer);
  }
}

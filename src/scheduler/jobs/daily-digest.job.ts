import { chains, getActiveChains } from "../../config/chains.js";
import { fetchAllPools } from "../../data/defillama/client.js";
import { fetchLastClosedDay, fetchMarketVolumeNow } from "../../data/defillama/dexs.js";
import { comparePoolsForPair, normalizePairKey } from "../../domain/market/pair-compare.js";
import { analyzeMarketRegime } from "../../domain/market/regime.js";
import { telegramChannel } from "../../notifications/channels/telegram.channel.js";
import { listPositionPairSymbols, listUserWallets } from "../../persistence/repositories/lp-positions.repository.js";
import {
  findLatestMarketVolumeDate,
  insertMarketVolume,
  listMarketVolumeSince,
} from "../../persistence/repositories/market.repository.js";
import { formatMarketRegime } from "../../domain/market/format-regime.js";
import { calculatePeriodReport } from "../../domain/portfolio/period-report.js";
import { formatWeeklySummary } from "../../domain/portfolio/format-report.js";
import { weekBounds } from "../../domain/portfolio/periods.js";
import { loadPeriodNav } from "../../data/period-nav.js";
import { preparePairComparison } from "../../bot/commands/comparar.js";
import { measurePoolYields } from "../../data/onchain/measure-pool-yield.js";
import { shouldDropAsOutlier } from "../../domain/yield-optimizer/outlier.js";
import { renderMarketPlot } from "../../data/chart/plot-market.js";
import { renderPairPlot } from "../../data/chart/plot-pairs.js";
import { InputFile } from "grammy";
import { Api } from "grammy";
import { env } from "../../config/env.js";

// Resumo diário: regime de mercado + comparação dos pares acompanhados entre
// chains. Roda no ciclo de 15min como os outros, mas com DOIS portões:
//   1. horário: só a partir de DIGEST_HOUR_UTC (briefing matinal, não 3h da
//      manhã — o resumo chega quando a pessoa vai olhar);
//   2. idempotência: só manda se ainda não mandou hoje.
//
// A gravação do volume de mercado acontece ANTES e INDEPENDENTE do envio: se
// o Telegram falhar, o histórico do dia não se perde (ele é a base do
// percentil, e um buraco ali contamina a leitura por 90 dias).

/** 11h UTC = 8h no horário de Brasília. */
const DIGEST_HOUR_UTC = 11;
const LOOKBACK_DAYS = 200;
const MIN_TVL_USD = 100_000;
/** Teto de pares no resumo — mais que isso vira spam diário, não briefing. */
const MAX_PAIRS_IN_DIGEST = 3;

const sentToday = new Set<string>();

/** Dia da semana (UTC) em que o fechamento semanal entra no resumo. 1 =
 *  segunda — a semana de segunda a domingo já fechou, então o número é
 *  definitivo em vez de parcial. */
const DIA_DO_FECHAMENTO_SEMANAL = 1;

// Fechamento da SEMANA ANTERIOR, anexado ao resumo de segunda. Decisão do
// usuário (07/09/2026): o diário fica sob demanda (/dia), porque num único dia
// o número é quase todo ruído de preço; o semanal chega sozinho.
//
// Devolve null em silêncio quando falta foto de abertura — o resumo diário não
// é lugar de explicar ausência de dado, e o /semana explica direito se ele
// perguntar.
async function blocoSemanal(userId: number, now: Date): Promise<DigestBlock | null> {
  const periodo = weekBounds(new Date(now.getTime() - 7 * 86400000));
  // Semana já fechada: sem medição ao vivo. Abertura e fechamento são as fotos
  // das 00:00 de segunda a segunda — ver data/period-nav.ts pro deslocamento
  // de um dia que existia aqui até 11/09/2026.
  const medido = await loadPeriodNav(userId, periodo, now);
  if (medido.status !== "ok") return null;

  const report = calculatePeriodReport({
    navStartUsdc: medido.abertura.navUsdc,
    navEndUsdc: medido.fechamento.navUsdc,
    flows: medido.fluxos.map((f) => ({ direction: f.direction, valueUsdc: f.valueUsdc, occurredAt: f.occurredAt })),
    periodStart: medido.abertura.at,
    periodEnd: medido.fechamento.at,
  });
  return { kind: "text", text: formatWeeklySummary(periodo, report, medido.fechamento.navUsdc) };
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// Grava o último dia FECHADO. Idempotente por data (onConflictDoNothing), e
// só busca a série se de fato falta dado — a chamada é a de ~19 MB.
async function recordMarketVolume(): Promise<void> {
  const latestStored = await findLatestMarketVolumeDate();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (latestStored !== null && latestStored >= yesterday) return; // já em dia

  const point = await fetchLastClosedDay();
  if (!point) {
    console.warn("[daily-digest] a DefiLlama não devolveu nenhum dia fechado");
    return;
  }
  await insertMarketVolume([{ ...point, source: "defillama_daily" }]);
}

/** Um pedaço do resumo: imagem (com legenda) ou texto puro. */
type DigestBlock = { kind: "photo"; png: Buffer; caption?: string } | { kind: "text"; text: string };

/** Janela desenhada no gráfico de mercado — ver CHART_DAYS em mercado.ts. */
const CHART_DAYS = 120;

async function buildDigest(userId: number, now: Date): Promise<DigestBlock[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const [series, volumeAgora] = await Promise.all([listMarketVolumeSince(since), fetchMarketVolumeNow()]);
  const regime = analyzeMarketRegime(series);
  const blocks: DigestBlock[] = [];

  // Gráfico de mercado primeiro — é a leitura imediata; o texto detalha.
  if (series.length > 0) {
    try {
      const png = await renderMarketPlot({
        history: series.slice(-CHART_DAYS),
        percentile: regime.available ? regime.percentile : null,
        label: regime.available ? regime.label : "sem leitura",
      });
      blocks.push({ kind: "photo", png });
    } catch (err) {
      console.error("[daily-digest] falha ao gerar gráfico de mercado:", err);
    }
  }
  blocks.push({ kind: "text", text: formatMarketRegime(regime, volumeAgora) });

  // Segunda-feira: o fechamento da semana que acabou entra no mesmo resumo.
  if (now.getUTCDay() === DIA_DO_FECHAMENTO_SEMANAL) {
    const semanal = await blocoSemanal(userId, now);
    if (semanal) blocks.push(semanal);
  }

  // Pares = os que ele tem em posição ∪ os que ele configurou.
  // Pares vêm SÓ das posições agora. A lista manual (/watchpair) saiu na
  // limpeza de 07/09/2026 — vivia vazia, e o que você tem em posição é
  // justamente o que interessa acompanhar.
  const fromPositions = await listPositionPairSymbols(userId);
  const keys = new Set<string>();
  for (const symbol of fromPositions) {
    const k = normalizePairKey(symbol);
    if (k) keys.add(k);
  }
  if (keys.size === 0) return blocks;

  const monitorable = getActiveChains().map((c) => chains[c].defillamaChainName);
  const allPools = await fetchAllPools();
  const comparable = allPools
    .filter((p) => p.tvlUsd >= MIN_TVL_USD && !shouldDropAsOutlier(p))
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

  for (const pairKey of [...keys].slice(0, MAX_PAIRS_IN_DIGEST)) {
    const doPar = comparePoolsForPair(comparable, pairKey, monitorable);
    // Mesma medição on-chain do /comparar — o resumo diário não pode mostrar
    // um ranking por régua diferente da do comando.
    const measurements = await measurePoolYields(
      doPar.map((p) => ({ poolId: p.poolId, chain: p.chain, project: p.project, poolMeta: p.poolMeta, underlyingTokens: p.underlyingTokens }))
    );
    const { plot, text } = preparePairComparison(pairKey, doPar, measurements);
    if (plot) {
      try {
        blocks.push({ kind: "photo", png: await renderPairPlot(plot) });
      } catch (err) {
        console.error("[daily-digest] falha ao gerar gráfico de par:", err);
      }
    }
    blocks.push({ kind: "text", text });
  }
  return blocks;
}

// O canal de notificação só manda TEXTO — imagem exige a Api direto. Mesma
// instância standalone que telegram.channel.ts usa (desacoplada do bot em
// polling), pelo mesmo motivo: notificação não depende do ciclo de vida do bot.
const api = new Api(env.telegramBotToken);

async function sendBlock(chatId: string, block: DigestBlock): Promise<void> {
  if (block.kind === "photo") {
    await api.sendPhoto(chatId, new InputFile(block.png, "resumo.png"), block.caption ? { caption: block.caption } : undefined);
    return;
  }
  await telegramChannel.send(chatId, block.text);
}

export async function dailyDigestJob(): Promise<string> {
  const now = new Date();
  const today = utcDate(now);

  // O volume é gravado sempre que falta, independente do horário do resumo —
  // não faz sentido perder o dado do dia por causa do portão de horário.
  try {
    await recordMarketVolume();
  } catch (err) {
    console.error("[daily-digest] falha ao gravar volume de mercado:", err);
  }

  if (now.getUTCHours() < DIGEST_HOUR_UTC) {
    return `volume em dia; resumo sai a partir das ${DIGEST_HOUR_UTC}h UTC.`;
  }

  const rows = await listUserWallets();
  const userIds = [...new Set(rows.map((r) => r.userId))];
  if (userIds.length === 0) return "nenhuma wallet vinculada.";

  const chatByUser = new Map(rows.map((r) => [r.userId, r.telegramChatId]));
  let sent = 0;
  let skipped = 0;

  for (const userId of userIds) {
    const key = `${userId}:${today}`;
    if (sentToday.has(key)) {
      skipped += 1;
      continue;
    }

    const chatId = chatByUser.get(userId);
    if (!chatId) continue;

    try {
      const blocks = await buildDigest(userId, now);
      for (const block of blocks) await sendBlock(chatId, block);
      // Marca DEPOIS do envio: se falhar no meio, a próxima rodada tenta de
      // novo em vez de pular o dia inteiro.
      sentToday.add(key);
      sent += 1;
    } catch (err) {
      console.error(`[daily-digest] falha ao montar/enviar resumo do usuário ${userId}:`, err);
    }
  }

  // Memória de processo: `sentToday` se perde num restart, e aí o resumo
  // poderia sair duas vezes no mesmo dia. Aceito de propósito — a alternativa
  // (mais uma tabela) não se paga pra uma mensagem informativa, e mandar duas
  // vezes é bem menos grave que não mandar.
  const summary = sent > 0 ? `resumo diário enviado pra ${sent} usuário(s).` : `nada a enviar (${skipped} já receberam hoje).`;
  console.log(`[daily-digest] ${summary}`);
  return summary;
}

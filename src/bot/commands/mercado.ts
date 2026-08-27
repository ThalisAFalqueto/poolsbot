import { InputFile, type CommandContext, type Context } from "grammy";
import { fetchMarketVolumeNow, type MarketVolumeNow } from "../../data/defillama/dexs.js";
import { analyzeMarketRegime, type MarketRegime } from "../../domain/market/regime.js";
import { TARGET_MONTHLY_PCT } from "../../domain/portfolio/target.js";
import { renderMarketPlot } from "../../data/chart/plot-market.js";
import { listMarketVolumeSince } from "../../persistence/repositories/market.repository.js";

// Leitura de regime do mercado — contexto pra o usuário decidir SE ajusta a
// meta. O bot nunca mexe nela sozinho (decisão dele, ver o plano): um número
// que baliza decisão precisa ser estável e auditável entre meses.

/** Janela lida do banco. Precisa cobrir os 90 dias do percentil com folga. */
const LOOKBACK_DAYS = 200;

function formatBillions(usd: number): string {
  return `$${(usd / 1e9).toFixed(2)}B`;
}

function signedPct(value: number | null): string {
  if (value === null) return "n/d";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

const LABEL_TEXT: Record<string, string> = {
  aquecido: "🔥 aquecido",
  normal: "➖ normal",
  fraco: "🧊 fraco",
};

const LEVEL_TEXT: Record<string, string> = {
  acima_da_media: "acima do normal do mês",
  em_linha: "em linha com o mês",
  abaixo_da_media: "abaixo do normal do mês",
};

export function formatMarketRegime(regime: MarketRegime, now: MarketVolumeNow): string {
  if (!regime.available) {
    return [
      "📊 Mercado — ainda sem leitura confiável.",
      "",
      `Tenho ${regime.pointsAvailable} dia(s) de histórico de volume; preciso de pelo menos 30 pra calcular um percentil que signifique alguma coisa.`,
      `Volume agora (24h): ${formatBillions(now.total24h)}.`,
    ].join("\n");
  }

  return [
    `📊 Mercado: ${LABEL_TEXT[regime.label] ?? regime.label}`,
    "",
    `Volume de DEXs em ${regime.latestDate}: ${formatBillions(regime.latestVolumeUsd)}`,
    `   percentil ${(regime.percentile * 100).toFixed(0)}% dos últimos ${regime.windowDays} dias`,
    `   semana ${LEVEL_TEXT[regime.weekVsMonth]} (7d ${formatBillions(regime.shortMaUsd)} vs 30d ${formatBillions(regime.longMaUsd)})`,
    "",
    `Agora (24h móvel): ${formatBillions(now.total24h)} · 1d ${signedPct(now.changePct1d)} · 7d ${signedPct(now.changePct7d)} · 30d ${signedPct(now.changePct1m)}`,
    "",
    `Sua meta segue em ${(TARGET_MONTHLY_PCT * 100).toFixed(0)}%/mês — o bot não mexe nela, isso é leitura de contexto pra você decidir.`,
    // O percentil mede PATAMAR contra os últimos 90 dias; as variações ao lado
    // medem DIREÇÃO recente. Podem discordar (patamar alto e caindo), e é
    // justamente essa combinação que interessa — por isso as duas aparecem.
    "* Percentil é o patamar frente aos últimos 90 dias; as variações de 1d/7d são a direção recente. Um mercado pode estar num patamar alto e caindo ao mesmo tempo.",
  ].join("\n");
}

/** Janela DESENHADA no gráfico — menor que a lida do banco (que precisa dos
 *  90 dias do percentil + 30 da média móvel). 120 dias mostram a mudança de
 *  regime sem espremer a linha. */
const CHART_DAYS = 120;

export async function mercadoCommand(ctx: CommandContext<Context>) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const [series, now] = await Promise.all([listMarketVolumeSince(since), fetchMarketVolumeNow()]);
  const regime = analyzeMarketRegime(series);

  // Gráfico primeiro, texto depois: a imagem é o que dá a leitura imediata
  // (foi o que o usuário pediu), o texto é o detalhe numérico.
  if (series.length > 0) {
    try {
      const png = await renderMarketPlot({
        history: series.slice(-CHART_DAYS),
        percentile: regime.available ? regime.percentile : null,
        label: regime.available ? regime.label : "sem leitura",
      });
      await ctx.replyWithPhoto(new InputFile(png, "mercado.png"));
    } catch (err) {
      // Gráfico é enriquecimento — se o .venv não estiver configurado nesta
      // máquina, o comando continua útil em texto em vez de não responder.
      console.error("[mercado] falha ao gerar gráfico:", err);
    }
  }

  await ctx.reply(formatMarketRegime(regime, now));
}

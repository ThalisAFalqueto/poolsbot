// Leitura de regime do mercado a partir do volume agregado de DEXs.
//
// O objetivo é dar CONTEXTO pra decisão do usuário sobre a meta mensal — nunca
// mexer nela. Decisão explícita dele: o bot informa, ele decide.
//
// Duas escolhas deliberadas contra "achismo com cara de dado":
//   1. Percentil contra a própria história recente, não um limiar inventado.
//      "Volume no percentil 20 dos últimos 90 dias" é verificável; "mercado em
//      bear" é opinião com aparência de fato.
//   2. Sem dado suficiente, devolve indisponível — nunca extrapola de uma
//      amostra curta, mesmo padrão de calculate-apr.ts com posição nova.

export type MarketVolumePoint = { date: string; volumeUsd: number };

/** Janela de comparação. 90 dias cobre ~1 trimestre: pega mudança de regime
 *  sem ser dominado por um pico isolado, e sem virar média de anos. */
const PERCENTILE_WINDOW_DAYS = 90;
/** Abaixo disso o percentil é ruído de amostra pequena. */
const MIN_POINTS_FOR_PERCENTILE = 30;

const SHORT_MA_DAYS = 7;
const LONG_MA_DAYS = 30;

/** Cortes do rótulo. Terços aproximados — a leitura fina fica com o percentil
 *  em si, que é sempre exibido junto. */
const HOT_PERCENTILE = 0.7;
const WEAK_PERCENTILE = 0.3;
/** Diferença mínima entre as médias pra valer menção. */
const MA_FLAT_BAND = 0.05;

// NOME IMPORTA: isto compara o NÍVEL da última semana contra o do último mês.
// NÃO é direção — o volume pode estar num patamar alto (semana acima do mês) e
// ao mesmo tempo caindo dia a dia, que é literalmente o caso em 27/08/2026
// (média 7d de $10,8B contra 30d de $7,2B, mas -23% na semana). Chamar isso de
// "tendência: subindo" seria repetir o bug do alerta que dizia "APY caiu" numa
// alta: rótulo contradizendo os números ao lado. A direção de curto prazo vem
// dos campos change_1d/change_7d da API, exibidos separados.
export type MarketLevel = "acima_da_media" | "em_linha" | "abaixo_da_media";
export type MarketLabel = "aquecido" | "normal" | "fraco";

export type MarketRegime =
  | { available: false; reason: "dados_insuficientes"; pointsAvailable: number }
  | {
      available: true;
      label: MarketLabel;
      /** 0-1: fração dos dias da janela com volume ABAIXO do dia mais recente. */
      percentile: number;
      /** Nível da semana vs o do mês — patamar, não direção (ver MarketLevel). */
      weekVsMonth: MarketLevel;
      latestVolumeUsd: number;
      latestDate: string;
      shortMaUsd: number;
      longMaUsd: number;
      windowDays: number;
    };

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percentileOf(value: number, sample: number[]): number {
  if (sample.length === 0) return 0;
  const below = sample.filter((v) => v < value).length;
  return below / sample.length;
}

// `series` deve conter só dias FECHADOS, em ordem crescente de data (ver
// data/defillama/dexs.ts, que já descarta o dia em curso). Passar o dia
// parcial aqui distorce tanto o percentil quanto as médias.
export function analyzeMarketRegime(series: MarketVolumePoint[]): MarketRegime {
  if (series.length < MIN_POINTS_FOR_PERCENTILE) {
    return { available: false, reason: "dados_insuficientes", pointsAvailable: series.length };
  }

  const latest = series[series.length - 1]!;
  // A janela EXCLUI o próprio dia comparado — senão ele entraria na sua
  // própria distribuição e puxaria o percentil pro meio.
  const window = series.slice(-1 - PERCENTILE_WINDOW_DAYS, -1).map((p) => p.volumeUsd);
  const percentile = percentileOf(latest.volumeUsd, window);

  const shortMaUsd = average(series.slice(-SHORT_MA_DAYS).map((p) => p.volumeUsd));
  const longMaUsd = average(series.slice(-LONG_MA_DAYS).map((p) => p.volumeUsd));

  // A curta acima da longa indica atividade da semana acima do normal do mês.
  // A banda morta evita destacar um cruzamento por diferença irrelevante.
  const maRatio = longMaUsd > 0 ? shortMaUsd / longMaUsd - 1 : 0;
  const weekVsMonth: MarketLevel =
    maRatio > MA_FLAT_BAND ? "acima_da_media" : maRatio < -MA_FLAT_BAND ? "abaixo_da_media" : "em_linha";

  const label: MarketLabel = percentile >= HOT_PERCENTILE ? "aquecido" : percentile <= WEAK_PERCENTILE ? "fraco" : "normal";

  return {
    available: true,
    label,
    percentile,
    weekVsMonth,
    latestVolumeUsd: latest.volumeUsd,
    latestDate: latest.date,
    shortMaUsd,
    longMaUsd,
    windowDays: window.length,
  };
}

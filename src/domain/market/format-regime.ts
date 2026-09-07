import type { MarketVolumeNow } from "../../data/defillama/dexs.js";
import { TARGET_MONTHLY_PCT } from "../portfolio/target.js";
import type { MarketRegime } from "./regime.js";

// Texto da leitura de regime de mercado.
//
// Mora no domínio, e não no comando, porque o comando /mercado foi REMOVIDO na
// limpeza de 07/09/2026 (os sites fazem isso melhor) mas o resumo diário
// continua mandando o gráfico e o texto — o usuário recebe passivamente sem
// precisar pedir. Deixar a formatação dentro de um arquivo de comando fazia o
// job importar de bot/commands/, que é dependência na direção errada.

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

import type { AlertRuleConfig, PoolSnapshot } from "./types.js";

const KIND_PREFIX = {
  triggered: "🚨 Alerta disparado:",
  reminder: "⏰ Lembrete (ainda ativo):",
  recovered: "✅ Normalizado:",
} as const;

type Kind = keyof typeof KIND_PREFIX;

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// As frações "drop"/"spike" calculadas em evaluate-rule.ts podem trocar de
// sinal entre o disparo e a recuperação do alerta — "recovered" só exige
// cruzar de volta o threshold (com folga de histerese), não voltar
// exatamente ao baseline, então o valor pode passar longe pro lado oposto
// (ex: APY que tinha caído se recupera E dispara bem acima do baseline de
// comparação). Achado real em produção (23/08/2026): mensagem dizia "APY
// caiu -31.0%" com os números mostrando 16.24% → 21.29% (uma ALTA de 31%,
// não queda) — o texto tinha a palavra fixa, sem checar o sinal de verdade.
// positiveWord é usado quando value >= 0 (o sentido "esperado" da métrica:
// queda pra apy/tvl, alta pra volume), negativeWord no sinal oposto.
function describeChange(value: number, positiveWord: string, negativeWord: string): string {
  const word = value >= 0 ? positiveWord : negativeWord;
  return `${word} ${pct(Math.abs(value))}`;
}

export function formatReason(
  rule: AlertRuleConfig,
  current: PoolSnapshot,
  baseline: PoolSnapshot | null,
  kind: Kind
): string {
  const prefix = KIND_PREFIX[kind];

  switch (rule.metric) {
    case "apy_drop_relative": {
      const drop = baseline ? (baseline.apy - current.apy) / baseline.apy : 0;
      return `${prefix} APY ${describeChange(drop, "caiu", "subiu")} em ${rule.windowHours}h (${baseline?.apy.toFixed(2)}% → ${current.apy.toFixed(2)}%).`;
    }
    case "tvl_drop_relative": {
      const drop = baseline ? (baseline.tvlUsd - current.tvlUsd) / baseline.tvlUsd : 0;
      return `${prefix} TVL ${describeChange(drop, "caiu", "subiu")} em ${rule.windowHours}h ($${baseline?.tvlUsd.toLocaleString("pt-BR")} → $${current.tvlUsd.toLocaleString("pt-BR")}).`;
    }
    case "apy_below_absolute": {
      return `${prefix} APY em ${current.apy.toFixed(2)}%, abaixo do limite de ${rule.thresholdValue.toFixed(2)}%.`;
    }
    case "tvl_below_absolute": {
      return `${prefix} TVL em $${current.tvlUsd.toLocaleString("pt-BR")}, abaixo do limite de $${rule.thresholdValue.toLocaleString("pt-BR")}.`;
    }
    case "reward_apy_ending": {
      const from = baseline?.apyReward ?? 0;
      const to = current.apyReward ?? 0;
      // "recovered" aqui só exige to > 0 (ver evaluate-rule.ts) — não que
      // tenha voltado perto do valor original, então pode disparar com
      // to > from (recompensa voltou maior do que tinha caído). Mesma classe
      // de bug do apy/tvl_drop_relative: não travar a frase em "caiu".
      const verb = to <= from ? "caiu" : "voltou a subir";
      return `${prefix} APY de recompensa ${verb} de ${from.toFixed(2)}% para ${to.toFixed(2)}%${to <= from ? " — possível fim de incentivo" : ""}.`;
    }
    case "il_risk_proxy": {
      if (current.il7d === null) {
        return `${prefix} Pool marcado com risco de impermanent loss pela DefiLlama (sem magnitude estimada — estimativa categórica de terceiro).`;
      }
      return `${prefix} Impermanent loss estimado em ${Math.abs(current.il7d).toFixed(2)}% nos últimos 7d (estimativa da DefiLlama, não é cálculo próprio).`;
    }
    case "volume_spike_relative": {
      const baselineVolume = baseline?.volumeUsd ?? null;
      const currentVolume = current.volumeUsd ?? 0;
      const spike = baselineVolume ? (currentVolume - baselineVolume) / baselineVolume : 0;
      return `${prefix} Volume ${describeChange(spike, "disparou", "caiu")} em ${rule.windowHours}h ($${baselineVolume?.toLocaleString("pt-BR") ?? "?"} → $${currentVolume.toLocaleString("pt-BR")}). Pode ser wash trading OU um evento de mercado real (ex: alta forte de preço) — não distingue os dois, investigar antes de assumir manipulação.`;
    }
  }
}

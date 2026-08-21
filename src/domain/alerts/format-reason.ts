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
      return `${prefix} APY caiu ${pct(drop)} em ${rule.windowHours}h (${baseline?.apy.toFixed(2)}% → ${current.apy.toFixed(2)}%).`;
    }
    case "tvl_drop_relative": {
      const drop = baseline ? (baseline.tvlUsd - current.tvlUsd) / baseline.tvlUsd : 0;
      return `${prefix} TVL caiu ${pct(drop)} em ${rule.windowHours}h ($${baseline?.tvlUsd.toLocaleString("pt-BR")} → $${current.tvlUsd.toLocaleString("pt-BR")}).`;
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
      return `${prefix} APY de recompensa caiu de ${from.toFixed(2)}% para ${to.toFixed(2)}% — possível fim de incentivo.`;
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
      return `${prefix} Volume disparou ${pct(spike)} em ${rule.windowHours}h ($${baselineVolume?.toLocaleString("pt-BR") ?? "?"} → $${currentVolume.toLocaleString("pt-BR")}). Pode ser wash trading OU um evento de mercado real (ex: alta forte de preço) — não distingue os dois, investigar antes de assumir manipulação.`;
    }
  }
}

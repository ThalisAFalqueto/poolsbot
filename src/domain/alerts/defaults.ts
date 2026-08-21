export const DEFAULT_ALERT_RULES = [
  { metric: "apy_drop_relative" as const, thresholdValue: 0.2, windowHours: 24, reminderIntervalHours: 6 },
  { metric: "tvl_drop_relative" as const, thresholdValue: 0.2, windowHours: 24, reminderIntervalHours: 6 },
  // Limiar de +500% direto do paper de detecção de wash trading (ACM
  // ToIT) analisado na pesquisa da estratégia — ver artifact/memória do
  // projeto. Não confirma manipulação sozinho (falta o fator de preço
  // estável do paper original), só sinaliza "pico notável".
  { metric: "volume_spike_relative" as const, thresholdValue: 5.0, windowHours: 24, reminderIntervalHours: 6 },
];

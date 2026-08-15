export const DEFAULT_ALERT_RULES = [
  { metric: "apy_drop_relative" as const, thresholdValue: 0.2, windowHours: 24, reminderIntervalHours: 6 },
  { metric: "tvl_drop_relative" as const, thresholdValue: 0.2, windowHours: 24, reminderIntervalHours: 6 },
];

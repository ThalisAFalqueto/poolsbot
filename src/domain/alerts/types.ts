export type AlertMetric =
  | "apy_drop_relative"
  | "apy_below_absolute"
  | "tvl_drop_relative"
  | "tvl_below_absolute"
  | "reward_apy_ending"
  | "il_risk_proxy";

export type PoolSnapshot = {
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  tvlUsd: number;
  ilRisk: string | null;
  il7d: number | null;
  recordedAt: Date;
};

export type AlertRuleConfig = {
  id: number;
  metric: AlertMetric;
  thresholdValue: number;
  windowHours: number | null;
  reminderIntervalHours: number;
};

export type AlertRuleState = {
  status: "ok" | "triggered";
  lastValue: number | null;
  triggeredAt: Date | null;
  lastNotifiedAt: Date | null;
};

export type AlertNotification = {
  kind: "triggered" | "reminder" | "recovered";
  reason: string;
  confidence: number; // 0-1
};

export type EvaluateRuleInput = {
  rule: AlertRuleConfig;
  state: AlertRuleState;
  current: PoolSnapshot;
  baseline: PoolSnapshot | null; // null = dado insuficiente (ex: watched há menos que windowHours)
  now: Date;
};

export type EvaluateRuleOutput = {
  nextState: AlertRuleState;
  notification: AlertNotification | null;
};

import { formatReason } from "./format-reason.js";
import type {
  AlertRuleConfig,
  AlertRuleState,
  EvaluateRuleInput,
  EvaluateRuleOutput,
  PoolSnapshot,
} from "./types.js";

// 5 pontos percentuais de folga antes de re-armar. Ruído normal de APY/TVL
// entre polls consecutivos de 15min fica bem abaixo disso pra pools líquidos
// — grande o suficiente pra evitar flapping bem em cima do threshold, pequeno
// o suficiente pra re-armar rápido quando a recuperação é real.
const HYSTERESIS_PCT = 0.05;

type Condition = { triggered: boolean; recovered: boolean; value: number } | null;

function evaluateCondition(
  rule: AlertRuleConfig,
  current: PoolSnapshot,
  baseline: PoolSnapshot | null
): Condition {
  const t = rule.thresholdValue;
  const h = HYSTERESIS_PCT;

  switch (rule.metric) {
    case "apy_drop_relative": {
      if (!baseline || baseline.apy <= 0) return null;
      const drop = (baseline.apy - current.apy) / baseline.apy;
      return { triggered: drop >= t, recovered: drop <= t - h, value: drop };
    }
    case "tvl_drop_relative": {
      if (!baseline || baseline.tvlUsd <= 0) return null;
      const drop = (baseline.tvlUsd - current.tvlUsd) / baseline.tvlUsd;
      return { triggered: drop >= t, recovered: drop <= t - h, value: drop };
    }
    case "apy_below_absolute": {
      const v = current.apy;
      return { triggered: v <= t, recovered: v >= t * (1 + h), value: v };
    }
    case "tvl_below_absolute": {
      const v = current.tvlUsd;
      return { triggered: v <= t, recovered: v >= t * (1 + h), value: v };
    }
    case "reward_apy_ending": {
      // baseline aqui é sempre o snapshot IMEDIATAMENTE anterior (15min), não
      // a janela de windowHours — comparar vs. 24h atrás atrasaria a detecção
      // e diluiria uma queda abrupta (reward zerando) numa média que talvez
      // nunca cruze o threshold.
      if (!baseline || baseline.apyReward === null || baseline.apyReward <= 0) return null;
      const curReward = current.apyReward ?? 0;
      const drop = (baseline.apyReward - curReward) / baseline.apyReward;
      return { triggered: drop >= t, recovered: curReward > 0, value: drop };
    }
    case "il_risk_proxy": {
      if (current.ilRisk !== "yes") return { triggered: false, recovered: true, value: 0 };
      if (current.il7d === null) {
        // il7d é null na maioria dos pools testados — sem esse fallback a
        // métrica nunca dispararia na prática. Dispara só com o sinal
        // categórico da DefiLlama, com confidence mais baixa.
        return { triggered: true, recovered: false, value: NaN };
      }
      const v = Math.abs(current.il7d);
      return { triggered: v >= t, recovered: v <= t - h, value: v };
    }
  }
}

function confidenceFor(rule: AlertRuleConfig, current: PoolSnapshot): number {
  if (rule.metric === "reward_apy_ending") return 0.75;
  if (rule.metric === "il_risk_proxy") return current.il7d === null ? 0.4 : 0.6;
  return 0.9;
}

export function evaluateRule(input: EvaluateRuleInput): EvaluateRuleOutput {
  const { rule, state, current, baseline, now } = input;
  const cond = evaluateCondition(rule, current, baseline);

  if (cond === null) {
    return { nextState: state, notification: null }; // dado insuficiente: não muda nada
  }

  if (state.status === "ok") {
    if (!cond.triggered) {
      return { nextState: { ...state, lastValue: cond.value }, notification: null };
    }
    const nextState: AlertRuleState = {
      status: "triggered",
      lastValue: cond.value,
      triggeredAt: now,
      lastNotifiedAt: now,
    };
    return {
      nextState,
      notification: {
        kind: "triggered",
        reason: formatReason(rule, current, baseline, "triggered"),
        confidence: confidenceFor(rule, current),
      },
    };
  }

  // state.status === "triggered"
  if (cond.recovered) {
    const nextState: AlertRuleState = {
      status: "ok",
      lastValue: cond.value,
      triggeredAt: null,
      lastNotifiedAt: null,
    };
    return {
      nextState,
      notification: {
        kind: "recovered",
        reason: formatReason(rule, current, baseline, "recovered"),
        confidence: confidenceFor(rule, current),
      },
    };
  }

  const reminderMs = rule.reminderIntervalHours * 3600 * 1000;
  const dueForReminder =
    state.lastNotifiedAt === null || now.getTime() - state.lastNotifiedAt.getTime() >= reminderMs;

  if (dueForReminder) {
    return {
      nextState: { ...state, lastValue: cond.value, lastNotifiedAt: now },
      notification: {
        kind: "reminder",
        reason: formatReason(rule, current, baseline, "reminder"),
        confidence: confidenceFor(rule, current),
      },
    };
  }

  return { nextState: { ...state, lastValue: cond.value }, notification: null };
}

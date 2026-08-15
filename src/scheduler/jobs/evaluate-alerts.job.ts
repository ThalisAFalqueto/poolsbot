import { evaluateRule } from "../../domain/alerts/evaluate-rule.js";
import { findClosestBefore } from "../../domain/alerts/find-baseline.js";
import type { AlertRuleConfig, AlertRuleState } from "../../domain/alerts/types.js";
import type { Signal } from "../../domain/signals/types.js";
import { executeSignal } from "../../execution/noop-executor.js";
import { dispatchSignal } from "../../notifications/dispatch-signal.js";
import { listActiveRulesWithContext } from "../../persistence/repositories/alert-rules.repository.js";
import { updateAlertState } from "../../persistence/repositories/alert-state.repository.js";
import { getHistorySince } from "../../persistence/repositories/apy-history.repository.js";

export async function evaluateAlertsJob(): Promise<void> {
  const now = new Date();
  const rules = await listActiveRulesWithContext();
  if (rules.length === 0) return;

  const windowHoursValues = rules.map((r) => r.windowHours).filter((w): w is number => w !== null);
  const maxWindowHours = windowHoursValues.length > 0 ? Math.max(...windowHoursValues) : 1;
  const since = new Date(now.getTime() - (maxWindowHours + 1) * 3600 * 1000);

  const poolIds = [...new Set(rules.map((r) => r.poolId))];
  const historyByPool = await getHistorySince(poolIds, since);

  let notifiedCount = 0;

  for (const rule of rules) {
    const history = historyByPool.get(rule.poolId);
    if (!history || history.length === 0) continue;

    const current = history[history.length - 1]!;
    const ruleConfig: AlertRuleConfig = {
      id: rule.ruleId,
      metric: rule.metric,
      thresholdValue: rule.thresholdValue,
      windowHours: rule.windowHours,
      reminderIntervalHours: rule.reminderIntervalHours,
    };
    const state: AlertRuleState = {
      status: rule.status,
      lastValue: rule.lastValue,
      triggeredAt: rule.triggeredAt,
      lastNotifiedAt: rule.lastNotifiedAt,
    };

    const baseline =
      rule.metric === "reward_apy_ending"
        ? (history.length >= 2 ? history[history.length - 2]! : null)
        : rule.windowHours !== null
          ? findClosestBefore(history, new Date(now.getTime() - rule.windowHours * 3600 * 1000))
          : null;

    const { nextState, notification } = evaluateRule({ rule: ruleConfig, state, current, baseline, now });

    await updateAlertState(rule.ruleId, nextState);

    if (notification) {
      const signal: Signal = {
        type: "risk_alert",
        userId: String(rule.userId),
        poolId: rule.poolId,
        reason: notification.reason,
        suggestedAction: { kind: "none" },
        confidence: notification.confidence,
        createdAt: now,
      };
      await dispatchSignal(signal, rule.telegramChatId);
      executeSignal(signal);
      notifiedCount += 1;
    }
  }

  console.log(`[evaluate-alerts] ${rules.length} regras avaliadas, ${notifiedCount} notificações enviadas.`);
}

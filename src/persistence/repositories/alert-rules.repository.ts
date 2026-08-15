import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { alertRules, alertState, users, watchedPools } from "../schema/index.js";
import type { AlertMetric } from "../../domain/alerts/types.js";

export type ActiveAlertRuleContext = {
  ruleId: number;
  metric: AlertMetric;
  thresholdValue: number;
  windowHours: number | null;
  reminderIntervalHours: number;
  status: "ok" | "triggered";
  lastValue: number | null;
  triggeredAt: Date | null;
  lastNotifiedAt: Date | null;
  poolId: string;
  chain: string;
  userId: number;
  telegramChatId: string;
};

export async function listActiveRulesWithContext(): Promise<ActiveAlertRuleContext[]> {
  const rows = await db
    .select({
      ruleId: alertRules.id,
      metric: alertRules.metric,
      thresholdValue: alertRules.thresholdValue,
      windowHours: alertRules.windowHours,
      reminderIntervalHours: alertRules.reminderIntervalHours,
      status: alertState.status,
      lastValue: alertState.lastValue,
      triggeredAt: alertState.triggeredAt,
      lastNotifiedAt: alertState.lastNotifiedAt,
      poolId: watchedPools.poolId,
      chain: watchedPools.chain,
      userId: users.id,
      telegramChatId: users.telegramChatId,
    })
    .from(alertRules)
    .innerJoin(alertState, eq(alertState.alertRuleId, alertRules.id))
    .innerJoin(watchedPools, eq(watchedPools.id, alertRules.watchedPoolId))
    .innerJoin(users, eq(users.id, watchedPools.userId));

  return rows as ActiveAlertRuleContext[];
}

export type UserAlertRule = ActiveAlertRuleContext & { poolId: string };

export async function listRulesForUser(userId: number) {
  return db
    .select({
      ruleId: alertRules.id,
      metric: alertRules.metric,
      thresholdValue: alertRules.thresholdValue,
      status: alertState.status,
      triggeredAt: alertState.triggeredAt,
      poolId: watchedPools.poolId,
      chain: watchedPools.chain,
    })
    .from(alertRules)
    .innerJoin(alertState, eq(alertState.alertRuleId, alertRules.id))
    .innerJoin(watchedPools, eq(watchedPools.id, alertRules.watchedPoolId))
    .where(eq(watchedPools.userId, userId));
}

export async function deleteRuleForUser(alertRuleId: number, userId: number): Promise<boolean> {
  const rows = await db
    .select({ ruleId: alertRules.id })
    .from(alertRules)
    .innerJoin(watchedPools, eq(watchedPools.id, alertRules.watchedPoolId))
    .where(and(eq(alertRules.id, alertRuleId), eq(watchedPools.userId, userId)));

  if (!rows[0]) return false;

  await db.delete(alertRules).where(eq(alertRules.id, alertRuleId));
  return true;
}

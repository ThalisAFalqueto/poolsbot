import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { alertState } from "../schema/index.js";
import type { AlertRuleState } from "../../domain/alerts/types.js";

export async function updateAlertState(alertRuleId: number, nextState: AlertRuleState): Promise<void> {
  await db
    .update(alertState)
    .set({
      status: nextState.status,
      lastValue: nextState.lastValue,
      triggeredAt: nextState.triggeredAt,
      lastNotifiedAt: nextState.lastNotifiedAt,
      updatedAt: new Date(),
    })
    .where(eq(alertState.alertRuleId, alertRuleId));
}

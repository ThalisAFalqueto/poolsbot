import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { alertRules, alertState, watchedPools } from "../schema/index.js";
import { DEFAULT_ALERT_RULES } from "../../domain/alerts/defaults.js";

export async function listDistinctWatchedPools(): Promise<{ poolId: string; chain: string }[]> {
  const rows = await db
    .selectDistinct({ poolId: watchedPools.poolId, chain: watchedPools.chain })
    .from(watchedPools);
  return rows;
}

export async function watchPool(
  userId: number,
  poolId: string,
  chain: string
): Promise<{ isNew: boolean }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(watchedPools)
      .values({ userId, poolId, chain })
      .onConflictDoNothing({ target: [watchedPools.userId, watchedPools.poolId] })
      .returning();

    const watchedPool = inserted[0];
    if (!watchedPool) {
      return { isNew: false };
    }

    for (const defaultRule of DEFAULT_ALERT_RULES) {
      const [rule] = await tx
        .insert(alertRules)
        .values({
          watchedPoolId: watchedPool.id,
          metric: defaultRule.metric,
          thresholdValue: defaultRule.thresholdValue,
          windowHours: defaultRule.windowHours,
          reminderIntervalHours: defaultRule.reminderIntervalHours,
          isDefault: true,
        })
        .returning();

      if (rule) {
        await tx.insert(alertState).values({ alertRuleId: rule.id, status: "ok" });
      }
    }

    return { isNew: true };
  });
}

export async function unwatchPool(userId: number, poolId: string): Promise<boolean> {
  const deleted = await db
    .delete(watchedPools)
    .where(and(eq(watchedPools.userId, userId), eq(watchedPools.poolId, poolId)))
    .returning();
  return deleted.length > 0;
}

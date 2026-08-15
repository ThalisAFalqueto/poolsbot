import { and, asc, gte, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { apyHistory } from "../schema/index.js";
import type { PoolSnapshot } from "../../domain/alerts/types.js";

export type ApyHistoryRow = {
  poolId: string;
  chain: string;
  apyBase: number | null;
  apyReward: number | null;
  apy: number;
  tvlUsd: number;
  ilRisk: string | null;
  il7d: number | null;
};

export async function insertSnapshots(rows: ApyHistoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(apyHistory).values(rows);
}

// Retorna o histórico de cada poolId (ordenado ascendente por recordedAt),
// agrupado num Map para evitar N+1 queries no job de avaliação de alertas.
export async function getHistorySince(
  poolIds: string[],
  since: Date
): Promise<Map<string, PoolSnapshot[]>> {
  const result = new Map<string, PoolSnapshot[]>();
  if (poolIds.length === 0) return result;

  const rows = await db
    .select()
    .from(apyHistory)
    .where(and(inArray(apyHistory.poolId, poolIds), gte(apyHistory.recordedAt, since)))
    .orderBy(asc(apyHistory.poolId), asc(apyHistory.recordedAt));

  for (const row of rows) {
    const snapshot: PoolSnapshot = {
      apy: row.apy,
      apyBase: row.apyBase,
      apyReward: row.apyReward,
      tvlUsd: row.tvlUsd,
      ilRisk: row.ilRisk,
      il7d: row.il7d,
      recordedAt: row.recordedAt,
    };
    const list = result.get(row.poolId);
    if (list) {
      list.push(snapshot);
    } else {
      result.set(row.poolId, [snapshot]);
    }
  }

  return result;
}

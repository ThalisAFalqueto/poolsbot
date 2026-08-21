import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "../db.js";
import { poolPriceHistory } from "../schema/index.js";

export type PricePoint = { recordedAt: Date; price: number };
export type PriceHistoryRow = PricePoint & { chain: string; poolAddress: string; source: string };

export async function insertPriceHistory(rows: PriceHistoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(poolPriceHistory).values(rows);
}

export async function getPriceHistorySince(chain: string, poolAddress: string, since: Date): Promise<PricePoint[]> {
  const rows = await db
    .select({ recordedAt: poolPriceHistory.recordedAt, price: poolPriceHistory.price })
    .from(poolPriceHistory)
    .where(
      and(
        eq(poolPriceHistory.chain, chain),
        eq(poolPriceHistory.poolAddress, poolAddress),
        gte(poolPriceHistory.recordedAt, since)
      )
    )
    .orderBy(asc(poolPriceHistory.recordedAt));
  return rows;
}

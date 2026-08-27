import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "../db.js";
import { marketVolumeHistory, watchedPairs } from "../schema/index.js";

// Volume agregado de mercado + pares acompanhados. Ver o comentário das
// tabelas em schema/index.ts pro desenho.

export type MarketVolumeRow = { date: string; volumeUsd: number };

// onConflictDoNothing: backfill e job diário se sobrepõem de propósito (o job
// relê o último dia fechado), e a primeira gravação de cada data é a que vale.
export async function insertMarketVolume(rows: { date: string; volumeUsd: number; source: string }[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(marketVolumeHistory).values(rows).onConflictDoNothing();
}

export async function listMarketVolumeSince(fromDate: string): Promise<MarketVolumeRow[]> {
  return db
    .select({ date: marketVolumeHistory.date, volumeUsd: marketVolumeHistory.volumeUsd })
    .from(marketVolumeHistory)
    .where(gte(marketVolumeHistory.date, fromDate))
    .orderBy(asc(marketVolumeHistory.date));
}

export async function findLatestMarketVolumeDate(): Promise<string | null> {
  const [row] = await db
    .select({ date: marketVolumeHistory.date })
    .from(marketVolumeHistory)
    .orderBy(desc(marketVolumeHistory.date))
    .limit(1);
  return row?.date ?? null;
}

export async function listWatchedPairs(userId: number): Promise<string[]> {
  const rows = await db
    .select({ pairKey: watchedPairs.pairKey })
    .from(watchedPairs)
    .where(eq(watchedPairs.userId, userId))
    .orderBy(asc(watchedPairs.pairKey));
  return rows.map((r) => r.pairKey);
}

export async function watchPair(userId: number, pairKey: string): Promise<{ isNew: boolean }> {
  const inserted = await db
    .insert(watchedPairs)
    .values({ userId, pairKey })
    .onConflictDoNothing()
    .returning({ id: watchedPairs.id });
  return { isNew: inserted.length > 0 };
}

export async function unwatchPair(userId: number, pairKey: string): Promise<boolean> {
  const deleted = await db
    .delete(watchedPairs)
    .where(and(eq(watchedPairs.userId, userId), eq(watchedPairs.pairKey, pairKey)))
    .returning({ id: watchedPairs.id });
  return deleted.length > 0;
}

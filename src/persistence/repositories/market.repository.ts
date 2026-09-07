import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "../db.js";
import { marketVolumeHistory } from "../schema/index.js";

// Volume agregado de mercado — alimenta o gráfico do resumo diário.
//
// Já guardava também os "pares acompanhados" (/watchpair), removidos na
// limpeza de 07/09/2026: a tabela vivia vazia, e o resumo diário passou a
// tirar os pares das próprias posições do usuário.

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




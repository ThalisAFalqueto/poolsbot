import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { watchedPools } from "../schema/index.js";

// Pools que o usuário quer que o bot ACOMPANHE — a lista que diz ao
// ingest-pools quais pools gravar em apy_history.
//
// Já criava também regras de alerta (queda de APY/TVL) junto. Isso saiu na
// limpeza de 07/09/2026: os alertas de métrica de pool nunca foram usados, e o
// que sobrou aqui é o que importa — manter o histórico de uma pool ao longo do
// tempo, que nenhum site guarda pra você.

export async function listDistinctWatchedPools(): Promise<{ poolId: string; chain: string }[]> {
  return db.selectDistinct({ poolId: watchedPools.poolId, chain: watchedPools.chain }).from(watchedPools);
}

export async function watchPool(userId: number, poolId: string, chain: string): Promise<{ isNew: boolean }> {
  const inserted = await db
    .insert(watchedPools)
    .values({ userId, poolId, chain })
    .onConflictDoNothing({ target: [watchedPools.userId, watchedPools.poolId] })
    .returning();
  return { isNew: inserted.length > 0 };
}

export async function unwatchPool(userId: number, poolId: string): Promise<boolean> {
  const deleted = await db
    .delete(watchedPools)
    .where(and(eq(watchedPools.userId, userId), eq(watchedPools.poolId, poolId)))
    .returning();
  return deleted.length > 0;
}

/** Pools que o usuário acompanha. Substitui a contagem que vinha das regras de
 *  alerta, removidas na limpeza de 07/09/2026 — o /status quer saber quantas
 *  pools estão sendo gravadas, não quantas regras existem. */
export async function listWatchedPoolIds(userId: number): Promise<string[]> {
  const rows = await db.select({ poolId: watchedPools.poolId }).from(watchedPools).where(eq(watchedPools.userId, userId));
  return rows.map((r) => r.poolId);
}

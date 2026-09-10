import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { poolPriceHistory } from "../schema/index.js";

export type PricePoint = { recordedAt: Date; price: number };
export type PriceHistoryRow = PricePoint & { chain: string; poolAddress: string; source: string };

export async function insertPriceHistory(rows: PriceHistoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(poolPriceHistory).values(rows);
}

/**
 * Espaçamento mínimo entre dois pontos do MESMO pool.
 *
 * POR QUE ISSO EXISTE. Dois jobs gravam preço: check-positions (pool onde há
 * posição) e ingest-pools (pool observado). O mesmo pool pode ser os dois ao
 * mesmo tempo, e aí os dois gravariam no mesmo ciclo, com segundos de
 * diferença.
 *
 * Isso não é só redundância — corrompe o σ. `estimateVolatility` normaliza
 * cada retorno por √Δt; com Δt de 30 segundos (0,00035 dia) o divisor é 0,019,
 * e qualquer diferença de preço entre as duas leituras é AMPLIFICADA ~53
 * vezes. Preço idêntico é igualmente ruim: entra um retorno zero que puxa o σ
 * pra baixo. Mesma classe de erro do σ com 9 amostras (ver TICK_SAMPLES).
 *
 * 5 minutos é bem menor que o ciclo de 15, então nada de legítimo é perdido.
 */
export const MIN_PRICE_GAP_MS = 5 * 60_000;

/**
 * Grava só os pontos cujo pool não tem leitura recente demais. Devolve quantos
 * de fato entraram.
 *
 * Deixa a ordem dos jobs no ciclo irrelevante: quem chegar primeiro grava, o
 * segundo vira no-op. Sem isso, a proteção teria que ser combinada entre os
 * dois jobs — e combinado entre jobs é o que se quebra na primeira mudança.
 */
export async function insertPriceHistoryIfDue(rows: PriceHistoryRow[], minGapMs = MIN_PRICE_GAP_MS): Promise<number> {
  if (rows.length === 0) return 0;

  const chaves = [...new Set(rows.map((r) => r.poolAddress))];
  const recentes = await db
    .select({ chain: poolPriceHistory.chain, poolAddress: poolPriceHistory.poolAddress, recordedAt: poolPriceHistory.recordedAt })
    .from(poolPriceHistory)
    .where(
      and(
        inArray(poolPriceHistory.poolAddress, chaves),
        gte(poolPriceHistory.recordedAt, new Date(Date.now() - minGapMs))
      )
    )
    .orderBy(desc(poolPriceHistory.recordedAt));

  const bloqueados = new Set(recentes.map((r) => `${r.chain}:${r.poolAddress}`));
  const aGravar = rows.filter((r) => !bloqueados.has(`${r.chain}:${r.poolAddress}`));
  await insertPriceHistory(aGravar);
  return aGravar.length;
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

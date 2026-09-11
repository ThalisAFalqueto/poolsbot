import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db.js";
import { walletCashFlows, walletNavSnapshots } from "../schema/index.js";

// Fotografias de patrimônio e fluxos de caixa da carteira — base do /mes.
// Ver o comentário das tabelas em schema/index.ts pro porquê do desenho.

export type NavSnapshotInput = {
  userId: number;
  walletAddress: string;
  chain: string;
  date: string; // YYYY-MM-DD, UTC
  navUsdc: number;
  idleUsdc: number;
  positionsUsdc: number;
  feesUsdc: number;
};

export type NavSnapshotRow = {
  walletAddress: string;
  chain: string;
  date: string;
  navUsdc: number;
  idleUsdc: number;
  positionsUsdc: number;
  feesUsdc: number;
};

// onConflictDoNothing: a PRIMEIRA foto do dia é a que vale. O job roda a cada
// 15min e sai cedo quando já existe linha de hoje (ver hasSnapshotForDate),
// mas duas execuções concorrentes ainda poderiam chegar aqui juntas — nesse
// caso a segunda vira no-op em vez de erro de índice único.
export async function insertNavSnapshots(rows: NavSnapshotInput[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(walletNavSnapshots).values(rows).onConflictDoNothing();
}

// Leitura barata que o job usa pra decidir se precisa gastar RPC hoje.
export async function hasSnapshotForDate(userId: number, date: string): Promise<boolean> {
  const [row] = await db
    .select({ id: walletNavSnapshots.id })
    .from(walletNavSnapshots)
    .where(and(eq(walletNavSnapshots.userId, userId), eq(walletNavSnapshots.date, date)))
    .limit(1);
  return row !== undefined;
}

export async function listNavSnapshotsBetween(userId: number, fromDate: string, toDate: string): Promise<NavSnapshotRow[]> {
  return db
    .select({
      walletAddress: walletNavSnapshots.walletAddress,
      chain: walletNavSnapshots.chain,
      date: walletNavSnapshots.date,
      navUsdc: walletNavSnapshots.navUsdc,
      idleUsdc: walletNavSnapshots.idleUsdc,
      positionsUsdc: walletNavSnapshots.positionsUsdc,
      feesUsdc: walletNavSnapshots.feesUsdc,
    })
    .from(walletNavSnapshots)
    .where(
      and(
        eq(walletNavSnapshots.userId, userId),
        gte(walletNavSnapshots.date, fromDate),
        lte(walletNavSnapshots.date, toDate)
      )
    )
    .orderBy(asc(walletNavSnapshots.date));
}

// A foto mais recente ATÉ uma data (inclusive) — usada pra achar o patrimônio
// de abertura do mês. Não exige uma foto exatamente no dia 1º: se o bot ficou
// fora do ar naquele dia, a última foto anterior serve como referência (e o
// /mes diz de qual dia ela é, em vez de fingir precisão que não tem).
export async function findLatestNavSnapshotUpTo(userId: number, date: string): Promise<NavSnapshotRow | null> {
  const [row] = await db
    .select({
      walletAddress: walletNavSnapshots.walletAddress,
      chain: walletNavSnapshots.chain,
      date: walletNavSnapshots.date,
      navUsdc: walletNavSnapshots.navUsdc,
      idleUsdc: walletNavSnapshots.idleUsdc,
      positionsUsdc: walletNavSnapshots.positionsUsdc,
      feesUsdc: walletNavSnapshots.feesUsdc,
    })
    .from(walletNavSnapshots)
    .where(and(eq(walletNavSnapshots.userId, userId), lte(walletNavSnapshots.date, date)))
    .orderBy(desc(walletNavSnapshots.date))
    .limit(1);
  return row ?? null;
}

/** Patrimônio de UMA foto, somado sobre todas as wallets e chains, com o
 *  instante em que foi medido. */
export type NavPointRow = {
  date: string;
  recordedAt: Date;
  navUsdc: number;
  idleUsdc: number;
  positionsUsdc: number;
  feesUsdc: number;
};

/**
 * A foto mais recente ATÉ uma data (inclusive), SOMADA sobre todas as linhas
 * dela — uma por (wallet, chain).
 *
 * Substitui findLatestNavSnapshotUpTo nos relatórios, que tinha dois defeitos
 * (achados em 11/09/2026):
 *   1. devolvia UMA linha (limit 1): com duas wallets ou duas chains, o
 *      patrimônio seria o de uma só;
 *   2. não trazia o instante da medição. A foto com data D é tirada às 00:00
 *      de D — é o patrimônio no INÍCIO do dia —, e sem o instante os
 *      relatórios a tratavam como o fim do dia (ver data/period-nav.ts).
 *
 * recordedAt é o MENOR instante entre as linhas: é a partir dele que um aporte
 * pode ter ficado de fora de alguma wallet da foto.
 */
export async function findNavAt(userId: number, date: string): Promise<NavPointRow | null> {
  const [ultima] = await db
    .select({ date: walletNavSnapshots.date })
    .from(walletNavSnapshots)
    .where(and(eq(walletNavSnapshots.userId, userId), lte(walletNavSnapshots.date, date)))
    .orderBy(desc(walletNavSnapshots.date))
    .limit(1);
  if (!ultima) return null;

  const linhas = await db
    .select({
      recordedAt: walletNavSnapshots.recordedAt,
      navUsdc: walletNavSnapshots.navUsdc,
      idleUsdc: walletNavSnapshots.idleUsdc,
      positionsUsdc: walletNavSnapshots.positionsUsdc,
      feesUsdc: walletNavSnapshots.feesUsdc,
    })
    .from(walletNavSnapshots)
    .where(and(eq(walletNavSnapshots.userId, userId), eq(walletNavSnapshots.date, ultima.date)));

  return linhas.reduce<NavPointRow>(
    (t, l) => ({
      date: t.date,
      recordedAt: l.recordedAt < t.recordedAt ? l.recordedAt : t.recordedAt,
      navUsdc: t.navUsdc + l.navUsdc,
      idleUsdc: t.idleUsdc + l.idleUsdc,
      positionsUsdc: t.positionsUsdc + l.positionsUsdc,
      feesUsdc: t.feesUsdc + l.feesUsdc,
    }),
    { date: ultima.date, recordedAt: linhas[0]!.recordedAt, navUsdc: 0, idleUsdc: 0, positionsUsdc: 0, feesUsdc: 0 }
  );
}

export type CashFlowInput = {
  userId: number;
  walletAddress: string;
  chain: string;
  uniqueId: string;
  direction: "deposit" | "withdrawal";
  asset: string;
  amount: number;
  valueUsdc: number;
  txHash: string;
  occurredAt: Date;
};

export type CashFlowRow = CashFlowInput;

// Dedup por uniqueId (o id da Alchemy) — o job relê janelas sobrepostas de
// propósito, pra não perder transferência por causa de atraso de indexação.
export async function insertCashFlows(rows: CashFlowInput[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(walletCashFlows).values(rows).onConflictDoNothing();
}

export async function listCashFlowsBetween(userId: number, from: Date, to: Date): Promise<CashFlowRow[]> {
  return db
    .select({
      userId: walletCashFlows.userId,
      walletAddress: walletCashFlows.walletAddress,
      chain: walletCashFlows.chain,
      uniqueId: walletCashFlows.uniqueId,
      direction: walletCashFlows.direction,
      asset: walletCashFlows.asset,
      amount: walletCashFlows.amount,
      valueUsdc: walletCashFlows.valueUsdc,
      txHash: walletCashFlows.txHash,
      occurredAt: walletCashFlows.occurredAt,
    })
    .from(walletCashFlows)
    .where(and(eq(walletCashFlows.userId, userId), gte(walletCashFlows.occurredAt, from), lte(walletCashFlows.occurredAt, to)))
    .orderBy(asc(walletCashFlows.occurredAt));
}

// Marca d'água pra próxima varredura: o job só busca transferências a partir
// daqui (com folga), em vez de reler a carteira inteira todo dia.
export async function findLatestCashFlowAt(userId: number): Promise<Date | null> {
  const [row] = await db
    .select({ occurredAt: walletCashFlows.occurredAt })
    .from(walletCashFlows)
    .where(eq(walletCashFlows.userId, userId))
    .orderBy(desc(walletCashFlows.occurredAt))
    .limit(1);
  return row?.occurredAt ?? null;
}

import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import { db } from "../db.js";
import { lpPositions, lpPositionState, users } from "../schema/index.js";
import type { PositionState } from "../../domain/lp-rebalance/types.js";

export type UserWithWallet = { userId: number; telegramChatId: string; walletAddress: string };

export async function listUsersWithWallet(): Promise<UserWithWallet[]> {
  const rows = await db
    .select({ userId: users.id, telegramChatId: users.telegramChatId, walletAddress: users.walletAddress })
    .from(users)
    .where(isNotNull(users.walletAddress));
  return rows.filter((r): r is UserWithWallet => r.walletAddress !== null);
}

export type PositionUpsertInput = {
  userId: number;
  chain: string;
  tokenId: string;
  poolAddress: string;
  token0Address: string;
  token1Address: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  fee: number;
  tickLower: number;
  tickUpper: number;
};

export type UpsertedPosition = { id: number; tokenId: string; isNew: boolean };

// Cada posição é resolvida individualmente (select -> branch insert/update)
// em vez de um único onConflictDoUpdate, pra poder criar a linha de estado
// inicial (lpPositionState) só quando a posição é realmente nova, e pra
// devolver `isNew` de forma direta pro chamador. Escala bem = número de
// posições de uma wallet (dezenas, não milhares) por ciclo de 15min.
export async function upsertPositions(inputs: PositionUpsertInput[]): Promise<UpsertedPosition[]> {
  const results: UpsertedPosition[] = [];

  for (const input of inputs) {
    const [existing] = await db
      .select({ id: lpPositions.id })
      .from(lpPositions)
      .where(and(eq(lpPositions.tokenId, input.tokenId), eq(lpPositions.chain, input.chain)))
      .limit(1);

    if (existing) {
      await db
        .update(lpPositions)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(lpPositions.id, existing.id));
      results.push({ id: existing.id, tokenId: input.tokenId, isNew: false });
      continue;
    }

    const [inserted] = await db.insert(lpPositions).values(input).returning({ id: lpPositions.id });
    if (inserted) {
      await db.insert(lpPositionState).values({ lpPositionId: inserted.id, status: "in_range" });
      results.push({ id: inserted.id, tokenId: input.tokenId, isNew: true });
    }
  }

  return results;
}

// Reconciliação: remove qualquer posição do usuário/chain cujo tokenId não
// esteja mais no conjunto ativo on-chain (fechada ou transferida pra outra
// wallet) — cascade limpa lp_position_state junto.
export async function deleteStalePositions(userId: number, chain: string, activeTokenIds: string[]): Promise<void> {
  if (activeTokenIds.length === 0) {
    await db.delete(lpPositions).where(and(eq(lpPositions.userId, userId), eq(lpPositions.chain, chain)));
    return;
  }
  await db
    .delete(lpPositions)
    .where(
      and(
        eq(lpPositions.userId, userId),
        eq(lpPositions.chain, chain),
        notInArray(lpPositions.tokenId, activeTokenIds)
      )
    );
}

export async function getPositionState(lpPositionId: number): Promise<PositionState> {
  const [row] = await db
    .select()
    .from(lpPositionState)
    .where(eq(lpPositionState.lpPositionId, lpPositionId))
    .limit(1);
  if (!row) {
    throw new Error(`Estado não encontrado pra posição ${lpPositionId}`);
  }
  return { status: row.status, outOfRangeSince: row.outOfRangeSince, lastNotifiedAt: row.lastNotifiedAt };
}

export async function updatePositionState(lpPositionId: number, next: PositionState): Promise<void> {
  await db
    .update(lpPositionState)
    .set({
      status: next.status,
      outOfRangeSince: next.outOfRangeSince,
      lastNotifiedAt: next.lastNotifiedAt,
      updatedAt: new Date(),
    })
    .where(eq(lpPositionState.lpPositionId, lpPositionId));
}

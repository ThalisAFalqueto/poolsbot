import { and, desc, eq, ilike, notInArray } from "drizzle-orm";
import { db } from "../db.js";
import {
  closedLpPositions,
  lpPositionIlAlertState,
  lpPositionIlBaseline,
  lpPositions,
  lpPositionState,
  userWallets,
  users,
} from "../schema/index.js";
import { decideBaseline } from "../../domain/lp-rebalance/il-baseline.js";
import type { IlAlertState } from "../../domain/lp-rebalance/evaluate-il-alert.js";
import type { OnchainPosition, PositionState } from "../../domain/lp-rebalance/types.js";

// Uma linha por par (usuário, wallet) — um usuário com N wallets vinculadas
// aparece N vezes. Quem chama agrupa por userId quando precisa processar
// todas as wallets de um usuário de uma vez (ver check-positions.job.ts).
export type UserWalletRow = { userId: number; telegramChatId: string; address: string };

export async function listUserWallets(): Promise<UserWalletRow[]> {
  return db
    .select({ userId: users.id, telegramChatId: users.telegramChatId, address: userWallets.address })
    .from(userWallets)
    .innerJoin(users, eq(userWallets.userId, users.id));
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

export type UpsertedPosition = { id: number; chain: string; tokenId: string; isNew: boolean };

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
      results.push({ id: existing.id, chain: input.chain, tokenId: input.tokenId, isNew: false });
      continue;
    }

    const [inserted] = await db.insert(lpPositions).values(input).returning({ id: lpPositions.id });
    if (inserted) {
      await db.insert(lpPositionState).values({ lpPositionId: inserted.id, status: "in_range" });
      results.push({ id: inserted.id, chain: input.chain, tokenId: input.tokenId, isNew: true });
    }
  }

  return results;
}

export type PositionSnapshot = {
  entryValueToken1: number;
  positionValueToken1: number;
  feesValueToken1: number;
  hodlValueToken1: number;
  ilToken1: number;
  totalPnlToken1: number;
  entryDate: Date;
};

// Grava o "último P&L conhecido" — chamado só pelo /positions (não pelo job
// de 15min, que não busca fees por custo de RPC extra por posição). É essa
// gravação que permite arquivar a posição quando ela fechar (ver
// archiveAndDeleteStalePositions abaixo); sem nenhum /positions rodado
// antes do fechamento, não há o que arquivar.
export async function updatePositionSnapshot(lpPositionId: number, snapshot: PositionSnapshot): Promise<void> {
  await db
    .update(lpPositions)
    .set({
      lastKnownEntryValueToken1: snapshot.entryValueToken1,
      lastKnownPositionValueToken1: snapshot.positionValueToken1,
      lastKnownFeesValueToken1: snapshot.feesValueToken1,
      lastKnownHodlValueToken1: snapshot.hodlValueToken1,
      lastKnownIlToken1: snapshot.ilToken1,
      lastKnownTotalPnlToken1: snapshot.totalPnlToken1,
      lastKnownEntryDate: snapshot.entryDate,
      lastSnapshotAt: new Date(),
    })
    .where(eq(lpPositions.id, lpPositionId));
}

// Reconciliação: remove qualquer posição do usuário/chain cujo tokenId não
// esteja mais no conjunto ativo on-chain (fechada ou transferida pra outra
// wallet) — cascade limpa lp_position_state junto. ANTES de deletar, arquiva
// em closed_lp_positions qualquer posição que tenha um snapshot conhecido
// (ver updatePositionSnapshot) — sem isso, fechar uma posição apagava todo
// o histórico dela (achado real, 21/08/2026: usuário ia fechar a posição
// WBTC/USDC real e perder IL/fees/P&L acumulados sem nenhum rastro).
export async function archiveAndDeleteStalePositions(userId: number, chain: string, activeTokenIds: string[]): Promise<void> {
  const staleWhere =
    activeTokenIds.length === 0
      ? and(eq(lpPositions.userId, userId), eq(lpPositions.chain, chain))
      : and(eq(lpPositions.userId, userId), eq(lpPositions.chain, chain), notInArray(lpPositions.tokenId, activeTokenIds));

  const stale = await db.select().from(lpPositions).where(staleWhere);

  const toArchive = stale.filter(
    (p): p is typeof p & { lastSnapshotAt: Date } =>
      p.lastSnapshotAt !== null &&
      p.lastKnownEntryValueToken1 !== null &&
      p.lastKnownPositionValueToken1 !== null &&
      p.lastKnownFeesValueToken1 !== null &&
      p.lastKnownHodlValueToken1 !== null &&
      p.lastKnownIlToken1 !== null &&
      p.lastKnownTotalPnlToken1 !== null &&
      p.lastKnownEntryDate !== null
  );

  if (toArchive.length > 0) {
    await db.insert(closedLpPositions).values(
      toArchive.map((p) => ({
        userId: p.userId,
        chain: p.chain,
        tokenId: p.tokenId,
        label: p.label,
        token0Symbol: p.token0Symbol,
        token1Symbol: p.token1Symbol,
        openedAt: p.lastKnownEntryDate!,
        entryValueToken1: p.lastKnownEntryValueToken1!,
        finalPositionValueToken1: p.lastKnownPositionValueToken1!,
        finalFeesValueToken1: p.lastKnownFeesValueToken1!,
        hodlValueToken1: p.lastKnownHodlValueToken1!,
        ilToken1: p.lastKnownIlToken1!,
        totalPnlToken1: p.lastKnownTotalPnlToken1!,
      }))
    );
  }

  await db.delete(lpPositions).where(staleWhere);
}

// Escreve o apelido — ÚNICO lugar que deveria tocar essa coluna (ver
// comentário em schema/index.ts sobre por que não pode entrar em
// PositionUpsertInput). Não desambigua por chain se o mesmo tokenId
// existir em mais de uma chain do mesmo usuário — atualiza todas as que
// baterem; aceitável hoje (uso real é só Arbitrum).
export async function setPositionLabel(userId: number, tokenId: string, label: string): Promise<boolean> {
  const updated = await db
    .update(lpPositions)
    .set({ label, updatedAt: new Date() })
    .where(and(eq(lpPositions.userId, userId), eq(lpPositions.tokenId, tokenId)))
    .returning({ id: lpPositions.id });
  return updated.length > 0;
}

export type PositionRef = { id: number; tokenId: string; chain: string };

// Tenta achar por apelido primeiro (case-insensitive), senão trata o
// identificador como tokenId cru. null se não achar dos dois jeitos.
export async function findPositionByLabelOrTokenId(userId: number, identifier: string): Promise<PositionRef | null> {
  const cols = { id: lpPositions.id, tokenId: lpPositions.tokenId, chain: lpPositions.chain };
  const [byLabel] = await db
    .select(cols)
    .from(lpPositions)
    .where(and(eq(lpPositions.userId, userId), ilike(lpPositions.label, identifier)))
    .limit(1);
  if (byLabel) return byLabel;

  const [byTokenId] = await db
    .select(cols)
    .from(lpPositions)
    .where(and(eq(lpPositions.userId, userId), eq(lpPositions.tokenId, identifier)))
    .limit(1);
  return byTokenId ?? null;
}

// Lista todas as posições do usuário (id, tokenId, chain) — usado por
// /graph sem argumento, pra decidir entre "usa a única" e "pede pra
// especificar" sem precisar de outra função inteira só pra contar.
export async function listPositionRefs(userId: number): Promise<PositionRef[]> {
  return db
    .select({ id: lpPositions.id, tokenId: lpPositions.tokenId, chain: lpPositions.chain })
    .from(lpPositions)
    .where(eq(lpPositions.userId, userId));
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

// Helper compartilhado entre check-positions.job.ts e bot/commands/positions.ts,
// pra não duplicar a montagem do PositionUpsertInput nos dois call sites.
export function toPositionUpsertInput(userId: number, chain: string, p: OnchainPosition): PositionUpsertInput {
  return {
    userId,
    chain,
    tokenId: p.tokenId.toString(),
    poolAddress: p.poolAddress,
    token0Address: p.token0.address,
    token1Address: p.token1.address,
    token0Symbol: p.token0.symbol,
    token1Symbol: p.token1.symbol,
    token0Decimals: p.token0.decimals,
    token1Decimals: p.token1.decimals,
    fee: p.fee,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
  };
}

export type IlBaseline = { liquidity: bigint; sqrtPriceX96: bigint; tick: number; recordedAt: Date; wasReset: boolean };

export async function getIlBaseline(lpPositionId: number): Promise<IlBaseline | null> {
  const [row] = await db
    .select()
    .from(lpPositionIlBaseline)
    .where(eq(lpPositionIlBaseline.lpPositionId, lpPositionId))
    .limit(1);
  if (!row) return null;
  return {
    liquidity: BigInt(row.liquidity),
    sqrtPriceX96: BigInt(row.sqrtPriceX96),
    tick: row.tick,
    recordedAt: row.recordedAt,
    wasReset: row.wasReset,
  };
}

// Lê o baseline existente, decide via decideBaseline (domínio puro), e grava
// create/reset quando necessário. Deve ser chamado pra TODA posição em todo
// ciclo (não só quando há notificação) — senão uma mudança de liquidez numa
// posição que continua in-range nunca seria detectada.
export async function syncIlBaseline(
  lpPositionId: number,
  current: { liquidity: bigint; sqrtPriceX96: bigint; tick: number }
): Promise<IlBaseline> {
  const existing = await getIlBaseline(lpPositionId);
  const action = decideBaseline(existing?.liquidity ?? null, current.liquidity);
  if (action === "keep" && existing) return existing;

  const wasReset = action === "reset";
  const recordedAt = new Date();
  const values = {
    lpPositionId,
    liquidity: current.liquidity.toString(),
    sqrtPriceX96: current.sqrtPriceX96.toString(),
    tick: current.tick,
    wasReset,
    recordedAt,
  };

  await db
    .insert(lpPositionIlBaseline)
    .values(values)
    .onConflictDoUpdate({ target: lpPositionIlBaseline.lpPositionId, set: values });

  return { liquidity: current.liquidity, sqrtPriceX96: current.sqrtPriceX96, tick: current.tick, recordedAt, wasReset };
}

const DEFAULT_IL_ALERT_STATE: IlAlertState = { status: "ok", triggeredAt: null, lastNotifiedAt: null };

// Diferente de lp_position_state (sempre criado junto com a posição em
// upsertPositions), o estado de alerta de IL não tem uma linha garantida —
// retorna o default "ok" se ainda não foi avaliado nenhuma vez.
export async function getIlAlertState(lpPositionId: number): Promise<IlAlertState> {
  const [row] = await db
    .select()
    .from(lpPositionIlAlertState)
    .where(eq(lpPositionIlAlertState.lpPositionId, lpPositionId))
    .limit(1);
  if (!row) return DEFAULT_IL_ALERT_STATE;
  return { status: row.status, triggeredAt: row.triggeredAt, lastNotifiedAt: row.lastNotifiedAt };
}

export async function updateIlAlertState(lpPositionId: number, next: IlAlertState): Promise<void> {
  const values = {
    lpPositionId,
    status: next.status,
    triggeredAt: next.triggeredAt,
    lastNotifiedAt: next.lastNotifiedAt,
    updatedAt: new Date(),
  };
  await db
    .insert(lpPositionIlAlertState)
    .values(values)
    .onConflictDoUpdate({ target: lpPositionIlAlertState.lpPositionId, set: values });
}

export type ClosedPositionRow = {
  chain: string;
  tokenId: string;
  label: string | null;
  token0Symbol: string;
  token1Symbol: string;
  openedAt: Date;
  closedAt: Date;
  entryValueToken1: number;
  finalPositionValueToken1: number;
  finalFeesValueToken1: number;
  hodlValueToken1: number;
  ilToken1: number;
  totalPnlToken1: number;
};

export async function listClosedPositions(userId: number): Promise<ClosedPositionRow[]> {
  return db
    .select({
      chain: closedLpPositions.chain,
      tokenId: closedLpPositions.tokenId,
      label: closedLpPositions.label,
      token0Symbol: closedLpPositions.token0Symbol,
      token1Symbol: closedLpPositions.token1Symbol,
      openedAt: closedLpPositions.openedAt,
      closedAt: closedLpPositions.closedAt,
      entryValueToken1: closedLpPositions.entryValueToken1,
      finalPositionValueToken1: closedLpPositions.finalPositionValueToken1,
      finalFeesValueToken1: closedLpPositions.finalFeesValueToken1,
      hodlValueToken1: closedLpPositions.hodlValueToken1,
      ilToken1: closedLpPositions.ilToken1,
      totalPnlToken1: closedLpPositions.totalPnlToken1,
    })
    .from(closedLpPositions)
    .where(eq(closedLpPositions.userId, userId))
    .orderBy(desc(closedLpPositions.closedAt));
}

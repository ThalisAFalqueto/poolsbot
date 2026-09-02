import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { closeTriggers, userWallets, users } from "../schema/index.js";

// Gatilhos de fechamento automático. Ver o comentário da tabela em
// schema/index.ts pro desenho, e contracts/src/CloseOnlyController.sol pro que
// o bot consegue (e não consegue) fazer com eles.

export type CloseTrigger = {
  id: number;
  userId: number;
  chain: string;
  protocol: string;
  tokenId: string;
  belowPrice: number | null;
  abovePrice: number | null;
  enabled: boolean;
  firedAt: Date | null;
};

export type CloseTriggerInput = {
  userId: number;
  chain: string;
  protocol: string;
  tokenId: string;
  belowPrice: number | null;
  abovePrice: number | null;
};

/**
 * Cria ou substitui o gatilho de uma posição.
 *
 * Reconfigurar RESSUSCITA o gatilho: `enabled` volta a true e `firedAt` volta a
 * null. É deliberado — depois de disparar, o gatilho fica desarmado, e o jeito
 * de rearmar é justamente configurar de novo (o que o usuário faria depois de
 * reabrir a posição).
 */
export async function upsertCloseTrigger(input: CloseTriggerInput): Promise<void> {
  await db
    .insert(closeTriggers)
    .values({ ...input, enabled: true })
    .onConflictDoUpdate({
      target: [closeTriggers.userId, closeTriggers.chain, closeTriggers.protocol, closeTriggers.tokenId],
      set: {
        belowPrice: input.belowPrice,
        abovePrice: input.abovePrice,
        enabled: true,
        firedAt: null,
        firedTxHash: null,
      },
    });
}

/** Desarma sem apagar — o histórico de que já existiu um gatilho ali importa
 *  quando se quer entender por que uma posição foi fechada. */
export async function disableCloseTrigger(
  userId: number,
  chain: string,
  protocol: string,
  tokenId: string
): Promise<boolean> {
  const rows = await db
    .update(closeTriggers)
    .set({ enabled: false })
    .where(
      and(
        eq(closeTriggers.userId, userId),
        eq(closeTriggers.chain, chain),
        eq(closeTriggers.protocol, protocol),
        eq(closeTriggers.tokenId, tokenId)
      )
    )
    .returning({ id: closeTriggers.id });
  return rows.length > 0;
}

export async function listCloseTriggers(userId: number): Promise<CloseTrigger[]> {
  return db
    .select({
      id: closeTriggers.id,
      userId: closeTriggers.userId,
      chain: closeTriggers.chain,
      protocol: closeTriggers.protocol,
      tokenId: closeTriggers.tokenId,
      belowPrice: closeTriggers.belowPrice,
      abovePrice: closeTriggers.abovePrice,
      enabled: closeTriggers.enabled,
      firedAt: closeTriggers.firedAt,
    })
    .from(closeTriggers)
    .where(eq(closeTriggers.userId, userId));
}

export type ArmedTrigger = CloseTrigger & { telegramChatId: string; walletAddress: string };

/**
 * Gatilhos ARMADOS (enabled, ainda não disparados), com o chat pra avisar e a
 * wallet dona da posição — o job precisa dos três juntos, e buscar em três
 * consultas separadas abriria espaço pra inconsistência entre elas.
 */
export async function listArmedTriggers(): Promise<ArmedTrigger[]> {
  return db
    .select({
      id: closeTriggers.id,
      userId: closeTriggers.userId,
      chain: closeTriggers.chain,
      protocol: closeTriggers.protocol,
      tokenId: closeTriggers.tokenId,
      belowPrice: closeTriggers.belowPrice,
      abovePrice: closeTriggers.abovePrice,
      enabled: closeTriggers.enabled,
      firedAt: closeTriggers.firedAt,
      telegramChatId: users.telegramChatId,
      walletAddress: userWallets.address,
    })
    .from(closeTriggers)
    .innerJoin(users, eq(users.id, closeTriggers.userId))
    .innerJoin(userWallets, eq(userWallets.userId, closeTriggers.userId))
    .where(eq(closeTriggers.enabled, true));
}

/** Marca como disparado E desarma, numa escrita só. O par (enabled=false,
 *  firedAt) é o que impede uma segunda tentativa de fechar a mesma posição. */
export async function markTriggerFired(id: number, txHash: string): Promise<void> {
  await db.update(closeTriggers).set({ enabled: false, firedAt: new Date(), firedTxHash: txHash }).where(eq(closeTriggers.id, id));
}

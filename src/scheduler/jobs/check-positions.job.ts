import type { Address } from "viem";
import { fetchPositionsForWallet } from "../../data/onchain/client.js";
import { evaluatePosition } from "../../domain/lp-rebalance/evaluate-position.js";
import { suggestRange } from "../../domain/lp-rebalance/range-suggestion.js";
import type { PositionState } from "../../domain/lp-rebalance/types.js";
import type { Signal } from "../../domain/signals/types.js";
import { executeSignal } from "../../execution/noop-executor.js";
import { dispatchSignal } from "../../notifications/dispatch-signal.js";
import {
  deleteStalePositions,
  getPositionState,
  listUsersWithWallet,
  updatePositionState,
  upsertPositions,
  type PositionUpsertInput,
} from "../../persistence/repositories/lp-positions.repository.js";

const CHAIN = "arbitrum";

export async function checkPositionsJob(): Promise<void> {
  const users = await listUsersWithWallet();
  if (users.length === 0) return;

  let notifiedCount = 0;

  for (const user of users) {
    try {
      const onchainPositions = await fetchPositionsForWallet(user.walletAddress as Address);

      const upsertInputs: PositionUpsertInput[] = onchainPositions.map((p) => ({
        userId: user.userId,
        chain: CHAIN,
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
      }));

      const upserted = await upsertPositions(upsertInputs);
      await deleteStalePositions(
        user.userId,
        CHAIN,
        onchainPositions.map((p) => p.tokenId.toString())
      );

      const now = new Date();
      const upsertedByTokenId = new Map(upserted.map((u) => [u.tokenId, u]));

      for (const position of onchainPositions) {
        const tokenId = position.tokenId.toString();
        const record = upsertedByTokenId.get(tokenId);
        if (!record) continue; // upsert falhou pra essa posição, pula (loga no próximo ciclo se persistir)

        const state: PositionState = record.isNew
          ? { status: "in_range", outOfRangeSince: null, lastNotifiedAt: null }
          : await getPositionState(record.id);

        const { nextState, notification } = evaluatePosition({ position, state, now });
        await updatePositionState(record.id, nextState);

        if (!notification) continue;

        const suggestedAction: Signal["suggestedAction"] =
          notification.kind === "out_of_range" || notification.kind === "reminder"
            ? {
                kind: "move_range",
                params: (() => {
                  const suggested = suggestRange(position.currentTick, position.tickLower, position.tickUpper, position.fee);
                  return { newTickLower: suggested.tickLower, newTickUpper: suggested.tickUpper };
                })(),
              }
            : { kind: "none" };

        const signal: Signal = {
          type: "rebalance_lp",
          userId: String(user.userId),
          poolId: tokenId,
          reason: notification.reason,
          suggestedAction,
          confidence: notification.confidence,
          createdAt: now,
        };

        await dispatchSignal(signal, user.telegramChatId);
        executeSignal(signal);
        notifiedCount += 1;
      }
    } catch (err) {
      // falha de RPC/wallet individual não pode derrubar o ciclo pros outros
      // usuários — é esperada eventualmente, não excepcional.
      console.error(`[check-positions] falha ao processar wallet do usuário ${user.userId}:`, err);
    }
  }

  console.log(`[check-positions] ${users.length} wallet(s) verificada(s), ${notifiedCount} notificações enviadas.`);
}

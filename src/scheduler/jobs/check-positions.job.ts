import type { Address } from "viem";
import { chains, getActiveChains, type ChainKey } from "../../config/chains.js";
import { fetchPositionsForWallets, getGasPrice } from "../../data/onchain/client.js";
import { calculateImpermanentLoss } from "../../domain/lp-rebalance/calculate-il.js";
import { estimateRebalanceCost, type GasCostEstimate } from "../../domain/lp-rebalance/estimate-gas-cost.js";
import { evaluateIlAlert, type IlAlertState } from "../../domain/lp-rebalance/evaluate-il-alert.js";
import { evaluatePosition } from "../../domain/lp-rebalance/evaluate-position.js";
import { formatIlLine } from "../../domain/lp-rebalance/format-reason.js";
import { isInRange, sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { suggestRange } from "../../domain/lp-rebalance/range-suggestion.js";
import type { OnchainPosition, PositionState } from "../../domain/lp-rebalance/types.js";
import type { Signal } from "../../domain/signals/types.js";
import { executeSignal } from "../../execution/noop-executor.js";
import { dispatchSignal } from "../../notifications/dispatch-signal.js";
import {
  deleteStalePositions,
  getIlAlertState,
  getPositionState,
  listUserWallets,
  syncIlBaseline,
  toPositionUpsertInput,
  updateIlAlertState,
  updatePositionState,
  upsertPositions,
} from "../../persistence/repositories/lp-positions.repository.js";

type UserGroup = { userId: number; telegramChatId: string; addresses: Address[] };

function groupByUser(rows: { userId: number; telegramChatId: string; address: string }[]): UserGroup[] {
  const groups = new Map<number, UserGroup>();
  for (const row of rows) {
    const g = groups.get(row.userId) ?? { userId: row.userId, telegramChatId: row.telegramChatId, addresses: [] };
    g.addresses.push(row.address as Address);
    groups.set(row.userId, g);
  }
  return [...groups.values()];
}

// Preço de gas buscado no máximo 1x por chain por execução do job (não por
// posição, não por usuário) — cache local ao ciclo, populado sob demanda só
// quando alguma posição fora de range realmente precisa (a maioria dos
// ciclos não tem nenhuma, então a chamada de RPC é evitada na prática).
async function getGasPriceCached(cache: Map<ChainKey, bigint>, chain: ChainKey): Promise<bigint | null> {
  const cached = cache.get(chain);
  if (cached !== undefined) return cached;
  try {
    const price = await getGasPrice(chain);
    cache.set(chain, price);
    return price;
  } catch (err) {
    console.error(`[check-positions] falha ao buscar preço de gas em ${chain}:`, err);
    return null;
  }
}

async function estimateGasCostIfOutOfRange(
  cache: Map<ChainKey, bigint>,
  position: OnchainPosition
): Promise<GasCostEstimate | null> {
  if (isInRange(position.currentTick, position.tickLower, position.tickUpper)) return null; // não vai ser usado

  const gasPriceWei = await getGasPriceCached(cache, position.chain);
  if (gasPriceWei === null) return null;

  const currentPrice = sqrtPriceX96ToPrice(position.sqrtPriceX96, position.token0.decimals, position.token1.decimals);
  return estimateRebalanceCost(gasPriceWei, position, chains[position.chain].wethAddress, currentPrice);
}

export async function checkPositionsJob(): Promise<void> {
  const rows = await listUserWallets();
  if (rows.length === 0) return;

  const users = groupByUser(rows);
  const activeChains = getActiveChains();
  const gasPriceCache = new Map<ChainKey, bigint>();
  let notifiedCount = 0;

  for (const user of users) {
    // fetchPositionsForWallets já isola falha de RPC por wallet e por chain
    // (não lança, só omite o que falhou) — o try/catch externo aqui é uma
    // segunda camada de defesa (qualquer falha inesperada na própria
    // chamada não pode derrubar o ciclo pros outros usuários); o try/catch
    // interno, por chain, cobre falhas de banco/lógica depois de já ter os
    // dados on-chain daquela chain, já com as posições de TODAS as wallets
    // do usuário juntas (reconciliação precisa ver o conjunto completo, ver
    // comentário em deleteStalePositions abaixo).
    let perChain: Awaited<ReturnType<typeof fetchPositionsForWallets>>;
    try {
      perChain = await fetchPositionsForWallets(user.addresses, activeChains);
    } catch (err) {
      console.error(`[check-positions] falha ao buscar posições do usuário ${user.userId}:`, err);
      continue;
    }

    for (const { chain, positions: onchainPositions } of perChain) {
      try {
        // onchainPositions já vem com as posições de TODAS as wallets do
        // usuário nessa chain juntas (fetchPositionsForWallets faz o
        // merge) — importante reconciliar de uma vez só aqui: se
        // deleteStalePositions fosse chamado wallet por wallet, a chamada
        // da wallet A apagaria por engano as posições que só existem na
        // wallet B do mesmo usuário.
        const upsertInputs = onchainPositions.map((p) => toPositionUpsertInput(user.userId, chain, p));
        const upserted = await upsertPositions(upsertInputs);
        await deleteStalePositions(
          user.userId,
          chain,
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

          const gasCost = await estimateGasCostIfOutOfRange(gasPriceCache, position);
          const { nextState, notification } = evaluatePosition({ position, state, now, gasCost });
          await updatePositionState(record.id, nextState);

          // syncIlBaseline e o cálculo de IL rodam pra TODA posição, não só
          // quando há notificação de range — senão (a) uma mudança de
          // liquidez numa posição que continua in-range nunca seria
          // detectada, e (b) o alerta de IL (independente do range) nunca
          // seria avaliado.
          const baseline = await syncIlBaseline(record.id, {
            liquidity: position.liquidity,
            sqrtPriceX96: position.sqrtPriceX96,
            tick: position.currentTick,
          });
          const il = calculateImpermanentLoss({
            liquidity: position.liquidity,
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
            decimals0: position.token0.decimals,
            decimals1: position.token1.decimals,
            baselineSqrtPriceX96: baseline.sqrtPriceX96,
            baselineRecordedAt: baseline.recordedAt,
            currentSqrtPriceX96: position.sqrtPriceX96,
          });

          if (notification) {
            const reasonWithIl = `${notification.reason}\n\n${formatIlLine(il, baseline.wasReset, position.token1.symbol)}`;

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
              reason: reasonWithIl,
              suggestedAction,
              confidence: notification.confidence,
              createdAt: now,
            };

            await dispatchSignal(signal, user.telegramChatId);
            executeSignal(signal);
            notifiedCount += 1;
          }

          // Alerta de IL — independente do estado de range (uma posição pode
          // continuar in-range e ainda assim acumular IL relevante).
          const ilAlertState: IlAlertState = await getIlAlertState(record.id);
          const { nextState: nextIlAlertState, notification: ilNotification } = evaluateIlAlert({
            position,
            il,
            state: ilAlertState,
            now,
          });
          await updateIlAlertState(record.id, nextIlAlertState);

          if (ilNotification) {
            const ilSignal: Signal = {
              type: "rebalance_lp",
              userId: String(user.userId),
              poolId: tokenId,
              reason: ilNotification.reason,
              suggestedAction: { kind: "none" },
              confidence: ilNotification.confidence,
              createdAt: now,
            };

            await dispatchSignal(ilSignal, user.telegramChatId);
            executeSignal(ilSignal);
            notifiedCount += 1;
          }
        }
      } catch (err) {
        // falha de banco/lógica numa chain específica não pode derrubar as
        // outras chains nem os outros usuários — falha de RPC já é isolada
        // por fetchPositionsAcrossChains, isso cobre o resto do pipeline.
        console.error(`[check-positions] falha ao processar wallet do usuário ${user.userId} em ${chain}:`, err);
      }
    }
  }

  console.log(
    `[check-positions] ${users.length} usuário(s) verificado(s) (${rows.length} wallet(s)), ${notifiedCount} notificações enviadas.`
  );
}

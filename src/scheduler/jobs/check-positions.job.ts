import type { Address } from "viem";
import { chains, getActiveChains, type ChainKey } from "../../config/chains.js";
import { fetchPositionsForWallets, fetchTickCumulatives, getGasPrice } from "../../data/onchain/client.js";
import { findCloseGasCost, findMintGasCost } from "../../data/onchain/position-gas.js";
import { calculateImpermanentLoss } from "../../domain/lp-rebalance/calculate-il.js";
import { estimateRebalanceCost, type GasCostEstimate } from "../../domain/lp-rebalance/estimate-gas-cost.js";
import { evaluateIlAlert, type IlAlertState } from "../../domain/lp-rebalance/evaluate-il-alert.js";
import { evaluatePosition } from "../../domain/lp-rebalance/evaluate-position.js";
import { formatIlLine } from "../../domain/lp-rebalance/format-reason.js";
import { getAmountsForLiquidity } from "../../domain/lp-rebalance/liquidity-math.js";
import { isInRange, sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { suggestRange } from "../../domain/lp-rebalance/range-suggestion.js";
import type { OnchainPosition, PositionRangeSuggestion, PositionState } from "../../domain/lp-rebalance/types.js";
import {
  buildSecondsAgos,
  intervalAverageTicks,
  suggestVolatilityRange,
  VOLATILITY_WINDOWS,
} from "../../domain/lp-rebalance/volatility-range.js";
import type { Signal } from "../../domain/signals/types.js";
import { executeSignal } from "../../execution/noop-executor.js";
import { dispatchSignal } from "../../notifications/dispatch-signal.js";
import {
  archiveStalePositions,
  deleteStalePositions,
  getIlAlertState,
  getPositionState,
  hasCompleteSnapshot,
  listStalePositionCandidates,
  listUserWallets,
  recordCloseGas,
  setMintGas,
  syncIlBaseline,
  toPositionUpsertInput,
  updateIlAlertState,
  updatePositionState,
  upsertPositions,
} from "../../persistence/repositories/lp-positions.repository.js";
import { insertPriceHistory } from "../../persistence/repositories/pool-price-history.repository.js";

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

// Custo de rebalance como fração do valor ATUAL da posição — insumo γ da
// margem calibrada por custo/benefício (ver computeMarginFraction em
// volatility-range.ts). null quando não dá pra estimar (par sem WETH pra
// converter o custo de gas, ou preço de gas indisponível no ciclo); nesse
// caso a margem cai pro custo de referência (fator neutro), sem travar a
// sugestão. Reaproveita liquidity/tick/preço já lidos on-chain — nenhuma
// chamada de RPC extra.
function computeGasCostFraction(position: OnchainPosition, gasCost: GasCostEstimate | null): number | null {
  if (gasCost === null || gasCost.costToken1 === null) return null;

  const currentPrice = sqrtPriceX96ToPrice(position.sqrtPriceX96, position.token0.decimals, position.token1.decimals);
  const { amount0, amount1 } = getAmountsForLiquidity({
    liquidity: position.liquidity,
    sqrtPriceX96: position.sqrtPriceX96,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    decimals0: position.token0.decimals,
    decimals1: position.token1.decimals,
  });
  const positionValueToken1 = amount0 * currentPrice + amount1;
  if (positionValueToken1 <= 0) return null;

  return gasCost.costToken1 / positionValueToken1;
}

// Tenta a cascata de janelas (7d -> 24h -> 6h) via oráculo nativo do pool
// (1 chamada de RPC por tentativa, independente da janela) — usa a
// primeira que tiver histórico suficiente. Se nenhuma tiver (pool novo ou
// pouco usado), cai pro heurístico de espelhar a largura atual, que nunca
// falha (sem RPC). Só roda quando a posição está fora de range — em
// range, o resultado nunca é usado.
async function suggestRangeIfOutOfRange(
  position: OnchainPosition,
  gasCost: GasCostEstimate | null
): Promise<PositionRangeSuggestion | null> {
  if (isInRange(position.currentTick, position.tickLower, position.tickUpper)) return null;

  const gasCostFraction = computeGasCostFraction(position, gasCost);

  for (const { windowSeconds, checkpointCount } of VOLATILITY_WINDOWS) {
    const secondsAgos = buildSecondsAgos(windowSeconds, checkpointCount);
    const tickCumulatives = await fetchTickCumulatives(position.chain, position.poolAddress, secondsAgos);
    if (tickCumulatives) {
      const intervalTicks = intervalAverageTicks(tickCumulatives, secondsAgos);
      const range = suggestVolatilityRange(intervalTicks, position.currentTick, position.fee, gasCostFraction);
      return { range, source: "volatility", volatilityWindowSeconds: windowSeconds };
    }
  }

  const range = suggestRange(position.currentTick, position.tickLower, position.tickUpper, position.fee);
  return { range, source: "heuristic", volatilityWindowSeconds: null };
}

export async function checkPositionsJob(): Promise<string> {
  const rows = await listUserWallets();
  if (rows.length === 0) return "nenhuma wallet vinculada.";

  const users = groupByUser(rows);
  const activeChains = getActiveChains();
  const gasPriceCache = new Map<ChainKey, bigint>();
  let notifiedCount = 0;

  // Um ponto de preço por pool ÚNICO por execução do job (não por posição
  // nem por usuário) — mesmo pool pode aparecer em várias posições/wallets
  // no mesmo ciclo, e um ponto a cada 15min já é granularidade suficiente
  // pro histórico (ver pool_price_history em schema/index.ts).
  const recordedPricePools = new Set<string>();

  for (const user of users) {
    // fetchPositionsForWallets já isola falha de RPC por wallet e por chain
    // (não lança, só omite o que falhou) — o try/catch externo aqui é uma
    // segunda camada de defesa (qualquer falha inesperada na própria
    // chamada não pode derrubar o ciclo pros outros usuários); o try/catch
    // interno, por chain, cobre falhas de banco/lógica depois de já ter os
    // dados on-chain daquela chain, já com as posições de TODAS as wallets
    // do usuário juntas (reconciliação precisa ver o conjunto completo, ver
    // comentário sobre reconciliação abaixo).
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
        // a reconciliação (archive+delete) fosse chamada wallet por wallet, a
        // chamada da wallet A apagaria por engano as posições que só existem
        // na wallet B do mesmo usuário.
        const upsertInputs = onchainPositions.map((p) => toPositionUpsertInput(user.userId, chain, p));
        const upserted = await upsertPositions(upsertInputs);

        const activeTokenIds = onchainPositions.map((p) => p.tokenId.toString());
        const staleCandidates = await listStalePositionCandidates(user.userId, chain, activeTokenIds);

        await archiveStalePositions(staleCandidates, chains[chain].nativeGasSymbol);
        await deleteStalePositions(user.userId, chain, activeTokenIds);

        // Custo REAL de gas do close (não estimativa) — disparado DEPOIS de
        // arquivar/deletar, NÃO esperado (await): achado real, o RPC free
        // tier só aceita 10 blocos por chamada de eth_getLogs, um scan que
        // não acha nada pode levar dezenas de segundos a ~1-2min — segurar
        // a reconciliação do ciclo inteiro (todos os usuários) esperando
        // isso não vale a pena. recordCloseGas preenche a linha já
        // arquivada quando (e se) resolver — só busca pra candidatos que
        // de fato foram arquivados (sem snapshot completo, não tem linha
        // em closed_lp_positions pra preencher).
        for (const candidate of staleCandidates) {
          if (!hasCompleteSnapshot(candidate)) continue;
          findCloseGasCost(candidate.chain as ChainKey, BigInt(candidate.tokenId))
            .then((closeGas) => {
              if (closeGas) return recordCloseGas(candidate.chain, candidate.tokenId, closeGas);
              console.warn(`[check-positions] gas de close não encontrado pra #${candidate.tokenId}`);
            })
            .catch((err) => console.error(`[check-positions] falha ao buscar gas de close da posição #${candidate.tokenId}:`, err));
        }

        const now = new Date();
        const upsertedByTokenId = new Map(upserted.map((u) => [u.tokenId, u]));

        for (const position of onchainPositions) {
          const tokenId = position.tokenId.toString();
          const record = upsertedByTokenId.get(tokenId);
          if (!record) continue; // upsert falhou pra essa posição, pula (loga no próximo ciclo se persistir)

          if (record.isNew) {
            // Custo REAL de gas do mint (não estimativa) — só dá pra achar
            // aqui, na 1ª vez que o bot vê essa posição (ver findMintGasCost).
            // NÃO esperado (await) — mesmo motivo do gas de close acima:
            // scan de log limitado a 10 blocos/chamada pode levar dezenas
            // de segundos, não pode segurar o ciclo inteiro por causa de 1
            // posição nova.
            findMintGasCost(position.chain, position.tokenId)
              .then((mintGas) => {
                if (mintGas) return setMintGas(record.id, mintGas);
                console.warn(`[check-positions] gas de mint não encontrado pra #${tokenId} (fora da janela de busca)`);
              })
              .catch((err) => console.error(`[check-positions] falha ao buscar gas de mint da posição #${tokenId}:`, err));
          }

          const pricePoolKey = `${position.chain}:${position.poolAddress}`;
          if (!recordedPricePools.has(pricePoolKey)) {
            recordedPricePools.add(pricePoolKey);
            try {
              await insertPriceHistory([
                {
                  chain: position.chain,
                  poolAddress: position.poolAddress,
                  recordedAt: new Date(),
                  price: sqrtPriceX96ToPrice(position.sqrtPriceX96, position.token0.decimals, position.token1.decimals),
                  source: "onchain_ingest",
                },
              ]);
            } catch (err) {
              // não pode derrubar o processamento da posição por causa disso
              console.error(`[check-positions] falha ao gravar histórico de preço de ${pricePoolKey}:`, err);
            }
          }

          const state: PositionState = record.isNew
            ? { status: "in_range", outOfRangeSince: null, lastNotifiedAt: null }
            : await getPositionState(record.id);

          const gasCost = await estimateGasCostIfOutOfRange(gasPriceCache, position);
          const suggestedRange = await suggestRangeIfOutOfRange(position, gasCost);
          const { nextState, notification } = evaluatePosition({ position, state, now, gasCost, suggestedRange });
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

            // suggestedRange já foi calculado acima (mesma condição
            // !isInRange que gerou este notification) — reusa em vez de
            // recalcular, pra não duplicar RPC nem arriscar inconsistência
            // entre o texto da notificação e os params estruturados do Signal.
            const suggestedAction: Signal["suggestedAction"] =
              (notification.kind === "out_of_range" || notification.kind === "reminder") && suggestedRange
                ? {
                    kind: "move_range",
                    params: { newTickLower: suggestedRange.range.tickLower, newTickUpper: suggestedRange.range.tickUpper },
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

  const summary = `${users.length} usuário(s) verificado(s) (${rows.length} wallet(s)), ${notifiedCount} notificações enviadas.`;
  console.log(`[check-positions] ${summary}`);
  return summary;
}

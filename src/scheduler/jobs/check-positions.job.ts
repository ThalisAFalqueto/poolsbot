import type { Address } from "viem";
import { chains, getActiveChains, type ChainKey } from "../../config/chains.js";
import { fetchPositionsForWallets, fetchTickCumulatives, getGasPrice } from "../../data/onchain/client.js";
import { findCloseGasCost, findMintGasCost, findV4CloseGasCost, findV4MintGasCost } from "../../data/onchain/position-gas.js";
import { calculateImpermanentLoss } from "../../domain/lp-rebalance/calculate-il.js";
import { estimateRebalanceCost, type GasCostEstimate } from "../../domain/lp-rebalance/estimate-gas-cost.js";
import { evaluateIlAlert, type IlAlertState } from "../../domain/lp-rebalance/evaluate-il-alert.js";
import { evaluatePosition, isSafelyInRange } from "../../domain/lp-rebalance/evaluate-position.js";
import { formatIlLine } from "../../domain/lp-rebalance/format-reason.js";
import { getAmountsForLiquidity } from "../../domain/lp-rebalance/liquidity-math.js";
import { isInRange, sqrtPriceX96ToPrice, tickToPrice } from "../../domain/lp-rebalance/price-math.js";
import { edgeProximity, isNearEdge } from "../../domain/lp-rebalance/near-edge.js";
import { formatPrice } from "../../domain/lp-rebalance/format-reason.js";
import { telegramChannel } from "../../notifications/channels/telegram.channel.js";
import { getNearEdgeAlerts } from "../../persistence/repositories/users.repository.js";
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
  deleteConfirmedClosedPositions,
  getIlAlertState,
  getPositionState,
  hasCompleteSnapshot,
  listStalePositionCandidates,
  listUserWallets,
  setMintGas,
  syncIlBaseline,
  toPositionUpsertInput,
  updateIlAlertState,
  updatePositionState,
  upsertPositions,
  type CloseGasResult,
} from "../../persistence/repositories/lp-positions.repository.js";
import { insertPriceHistoryIfDue } from "../../persistence/repositories/pool-price-history.repository.js";
import { readV3CloseReceipt } from "../../data/onchain/close-receipt.js";
import type { CloseReceipt } from "../../domain/lp-rebalance/close-receipt.js";
import { getNearEdgeNotifiedAt, setNearEdgeNotifiedAt } from "../../persistence/repositories/lp-positions.repository.js";
import { confirmPositionClosed } from "../../data/onchain/confirm-closed.js";

/** Cadência do aviso de borda. 6h é o mesmo ritmo do lembrete de fora-de-faixa
 *  — chegar perto da borda não é notícia nova a cada 15min. */
const NEAR_EDGE_REMINDER_MS = 6 * 3600 * 1000;

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
  // CRITÉRIO TEM QUE SER O MESMO da máquina de estado (evaluate-position), não
  // a borda crua: ela só considera a posição recuperada com margem de
  // histerese pra dentro. Usando `isInRange` aqui, existia uma faixa de ticks
  // (dentro da borda, mas dentro da margem) em que este método devolvia null e
  // o evaluatePosition ainda emitia lembrete — o formatter estourava e
  // derrubava o ciclo inteiro da wallet. Bug real, 27/08/2026.
  if (isSafelyInRange(position.currentTick, position.tickLower, position.tickUpper)) return null;

  const gasCostFraction = computeGasCostFraction(position, gasCost);

  // V4 não tem o oráculo TWAP nativo (observe() virou hook opcional, ver
  // client-v4.ts) — e position.poolAddress guarda o PoolId (32 bytes) pra
  // posições V4, não um endereço de pool chamável (fetchTickCumulatives
  // quebraria tentando usar isso como endereço de contrato). Pula direto
  // pro heurístico, que é protocol-agnostic (só usa tick/tickSpacing).
  if (position.protocol === "v3") {
    for (const { windowSeconds, checkpointCount } of VOLATILITY_WINDOWS) {
      const secondsAgos = buildSecondsAgos(windowSeconds, checkpointCount);
      const tickCumulatives = await fetchTickCumulatives(position.chain, position.poolAddress, secondsAgos);
      if (tickCumulatives) {
        const intervalTicks = intervalAverageTicks(tickCumulatives, secondsAgos);
        const range = suggestVolatilityRange(intervalTicks, position.currentTick, position.fee, position.tickSpacing, gasCostFraction);
        return { range, source: "volatility", volatilityWindowSeconds: windowSeconds };
      }
    }
  }

  const range = suggestRange(position.currentTick, position.tickLower, position.tickUpper, position.tickSpacing);
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
    // Uma leitura por usuário, não por posição.
    const avisaBorda = await getNearEdgeAlerts(user.userId);
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

        // Chave composta (tokenId + protocol), não só tokenId: os dois
        // protocolos numeram tokenId de forma independente e podem colidir
        // (ver ActivePositionKey no repositório).
        const activeKeys = onchainPositions.map((p) => ({ tokenId: p.tokenId.toString(), protocol: p.protocol }));
        const suspeitas = await listStalePositionCandidates(user.userId, chain, activeKeys);

        // CONFIRMA no contrato antes de arquivar. Sumir da lista é indício, não
        // prova — ver data/onchain/confirm-closed.ts pro incidente de
        // 03/09/2026 em que uma posição aberta foi arquivada e recriada.
        // Na dúvida (leitura falhou), NÃO arquiva: manter custa uma linha,
        // apagar custa gas de mint, data de abertura e baseline de IL.
        const staleCandidates: typeof suspeitas = [];
        const naoConfirmadas: string[] = [];
        for (const c of suspeitas) {
          const r = await confirmPositionClosed(chain, c.protocol, c.tokenId);
          if (r.closed === true) staleCandidates.push(c);
          else naoConfirmadas.push(`#${c.tokenId} (${r.closed === false ? r.reason : `não confirmado: ${r.reason}`})`);
        }
        if (naoConfirmadas.length > 0) {
          console.warn(`[check-positions] sumiram da lista mas NÃO foram arquivadas: ${naoConfirmadas.join(", ")}`);
        }

        // RECIBO lido dos EVENTOS do contrato, não do snapshot do último
        // /positions — ver domain/lp-rebalance/close-receipt.ts pro caso real
        // (#5683732, 11/09/2026) em que o snapshot deixou final e fees
        // defasados. Só V3: no V4 não há DecreaseLiquidity/Collect. V4, ou
        // leitura que falhou, cai no snapshot, e o /closed avisa.
        const receiptsByPositionId = new Map<number, CloseReceipt>();
        for (const candidate of staleCandidates) {
          if (candidate.protocol !== "v3") continue;
          try {
            const recibo = await readV3CloseReceipt({
              chainKey: candidate.chain as ChainKey,
              tokenId: BigInt(candidate.tokenId),
              poolAddress: candidate.poolAddress as `0x${string}`,
              decimals0: candidate.token0Decimals,
              decimals1: candidate.token1Decimals,
              mintTxHash: candidate.mintGasTxHash,
            });
            if (recibo) receiptsByPositionId.set(candidate.id, recibo);
            else console.warn(`[check-positions] eventos de #${candidate.tokenId} não formam recibo completo — usando o snapshot`);
          } catch (err) {
            console.error(`[check-positions] falha ao ler recibo on-chain de #${candidate.tokenId} — usando o snapshot:`, err);
          }
        }

        // Custo REAL de gas do close (não estimativa) — só busca pra
        // candidatos que de fato vão ser arquivados (sem recibo on-chain nem
        // snapshot completo, não vale gastar uma chamada RPC à toa).
        const closeGasByPositionId = new Map<number, CloseGasResult>();
        for (const candidate of staleCandidates) {
          if (!receiptsByPositionId.has(candidate.id) && !hasCompleteSnapshot(candidate)) continue;
          try {
            const closeGas =
              candidate.protocol === "v3"
                ? await findCloseGasCost(candidate.chain as ChainKey, BigInt(candidate.tokenId))
                : await findV4CloseGasCost(candidate.chain as ChainKey, candidate.poolAddress as `0x${string}`, BigInt(candidate.tokenId));
            if (closeGas) {
              closeGasByPositionId.set(candidate.id, { closeGasNative: closeGas.gasNative, closeGasTxHashes: closeGas.txHashes });
            } else {
              console.warn(`[check-positions] gas de close não encontrado pra #${candidate.tokenId}`);
            }
          } catch (err) {
            console.error(`[check-positions] falha ao buscar gas de close da posição #${candidate.tokenId}:`, err);
          }
        }
        await archiveStalePositions(staleCandidates, closeGasByPositionId, chains[chain].nativeGasSymbol, receiptsByPositionId);
        // Apaga só o que foi CONFIRMADO fechado, não tudo que sumiu da lista.
        await deleteConfirmedClosedPositions(
          user.userId,
          chain,
          staleCandidates.map((c) => ({ tokenId: c.tokenId, protocol: c.protocol }))
        );

        const now = new Date();
        const upsertedByTokenId = new Map(upserted.map((u) => [u.tokenId, u]));

        for (const position of onchainPositions) {
          const tokenId = position.tokenId.toString();
          const record = upsertedByTokenId.get(tokenId);
          if (!record) continue; // upsert falhou pra essa posição, pula (loga no próximo ciclo se persistir)

          if (record.isNew) {
            // Custo REAL de gas do mint (não estimativa) — só dá pra achar
            // aqui, na 1ª vez que o bot vê essa posição (ver findMintGasCost).
            try {
              const mintGas =
                position.protocol === "v3"
                  ? await findMintGasCost(position.chain, position.tokenId)
                  : await findV4MintGasCost(position.chain, position.tokenId);
              if (mintGas) await setMintGas(record.id, mintGas);
              else console.warn(`[check-positions] gas de mint não encontrado pra #${tokenId} (fora da janela de busca)`);
            } catch (err) {
              console.error(`[check-positions] falha ao buscar gas de mint da posição #${tokenId}:`, err);
            }
          }

          const pricePoolKey = `${position.chain}:${position.poolAddress}`;
          if (!recordedPricePools.has(pricePoolKey)) {
            recordedPricePools.add(pricePoolKey);
            try {
              // Guardado: o ingest-pools grava a mesma pool quando ela está
              // em watched_pools, e dois pontos a segundos de distância
              // estragam o σ (ver MIN_PRICE_GAP_MS).
              await insertPriceHistoryIfDue([
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

          // Aviso de APROXIMAÇÃO da borda — antes de sair, não depois.
          //
          // Fica FORA da máquina de estado de evaluatePosition de propósito.
          // Aquela já causou um crash em produção (27/08/2026) por dois
          // critérios divergentes de "está em faixa"; aqui a pergunta é outra
          // ("quão perto da borda"), com relógio próprio e função pura, e os
          // dois nunca podem discordar sobre a mesma coisa.
          //
          // Desligado por usuário até ele ligar com /bordaalerta.
          if (avisaBorda && isNearEdge(position.currentTick, position.tickLower, position.tickUpper)) {
            const ultimoAviso = await getNearEdgeNotifiedAt(record.id);
            if (!ultimoAviso || now.getTime() - ultimoAviso.getTime() >= NEAR_EDGE_REMINDER_MS) {
              const p = edgeProximity(position.currentTick, position.tickLower, position.tickUpper)!;
              const borda = p.side === "upper" ? "TETO" : "PISO";
              const precoAtual = sqrtPriceX96ToPrice(position.sqrtPriceX96, position.token0.decimals, position.token1.decimals);
              const precoBorda = tickToPrice(
                p.side === "upper" ? position.tickUpper : position.tickLower,
                position.token0.decimals,
                position.token1.decimals
              );
              await telegramChannel.send(
                user.telegramChatId,
                [
                  `⚠️ Posição #${tokenId} (${position.token0.symbol}/${position.token1.symbol}) está chegando no ${borda}.`,
                  `Preço agora ${formatPrice(precoAtual)} · borda em ${formatPrice(precoBorda)} · falta ${(Math.abs(precoBorda / precoAtual - 1) * 100).toFixed(2)}%.`,
                  "",
                  "Se sair, você para de ganhar taxa até voltar. Isso é aviso, não recomendação — esperar costuma ser razoável quando a folga é pequena.",
                ].join("\n")
              );
              await setNearEdgeNotifiedAt(record.id, now);
              notifiedCount += 1;
            }
          } else if (avisaBorda) {
            // Voltou pro meio: zera o relógio pra o próximo avanço até a borda
            // avisar de novo, em vez de ficar em silêncio pelas próximas 6h.
            await setNearEdgeNotifiedAt(record.id, null);
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

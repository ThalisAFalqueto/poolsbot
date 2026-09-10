import { getActiveChains, type ChainKey } from "../../config/chains.js";
import { sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import type { PriceHistoryRow } from "../../persistence/repositories/pool-price-history.repository.js";
import { getPoolInfo, type PoolInfo } from "./client.js";
import { getV4PoolInfo } from "./client-v4.js";
import { resolveMeasurablePool, type MeasurablePool, type ResolvedPoolRef } from "./measure-pool-yield.js";

// Preço corrente de um pool do catálogo, no formato que vai pro histórico.
//
// POR QUE ISSO EXISTE (10/09/2026). O histórico de preço só era escrito pelo
// check-positions, ou seja, só pra pool onde havia POSIÇÃO ABERTA. Consequência
// prática: o usuário fechou a posição de WBTC/USDC no dia 09 e o histórico
// daquela pool congelou no mesmo minuto — 3.109 pontos e para. Um dia depois,
// avaliando abrir de novo, a resposta de "qual faixa usar" saiu centrada num
// preço 2,7% defasado.
//
// Isso invertia a lógica do bot: o histórico existia justamente pra decidir se
// vale entrar, mas só era coletado depois de já ter entrado. Agora quem está
// em `watched_pools` também é gravado.

/** Leitura do estado do pool. Injetável pelo mesmo motivo que em
 *  confirm-closed.ts: mockar módulo aqui se mostrou pouco confiável, e a
 *  alternativa é um teste que depende de qual RPC está configurado na máquina
 *  que roda a suíte. */
export type PoolInfoReader = (r: ResolvedPoolRef) => Promise<PoolInfo | null>;

const readInfoOnchain: PoolInfoReader = (r) =>
  r.isV4 ? getV4PoolInfo(r.chainKey, r.tokenA, r.tokenB, r.fee) : getPoolInfo(r.chainKey, r.tokenA, r.tokenB, r.fee);

export type ReadPoolPricesDeps = { activeChains?: ChainKey[]; readInfo?: PoolInfoReader };

/**
 * Lê o preço de cada pool que o RPC consegue resolver. Pool que não dá pra ler
 * é OMITIDA, não vira zero nem erro: uma leitura falha não pode derrubar o
 * ciclo dos outros pools, e um ponto inventado no histórico é pior que um
 * buraco (o buraco o backtest reconhece e descarta, ver MAX_GAP_DAYS).
 */
export async function readPoolPrices(pools: MeasurablePool[], deps: ReadPoolPricesDeps = {}): Promise<PriceHistoryRow[]> {
  const active = deps.activeChains ?? getActiveChains();
  const readInfo = deps.readInfo ?? readInfoOnchain;
  const now = new Date();

  const lidas = await Promise.all(
    pools.map(async (p): Promise<PriceHistoryRow | null> => {
      const r = resolveMeasurablePool(p, active);
      if (!r) return null;
      try {
        const info = await readInfo(r);
        if (!info) return null;
        return {
          // chainKey, não o nome da DefiLlama: o histórico gravado pelo
          // check-positions usa "arbitrum", e a consulta casa por igualdade
          // exata. Gravar "Arbitrum" aqui criaria uma segunda série paralela
          // que nunca se junta à primeira — e ninguém perceberia.
          chain: r.chainKey,
          poolAddress: info.poolAddress,
          recordedAt: now,
          price: sqrtPriceX96ToPrice(info.sqrtPriceX96, info.token0.decimals, info.token1.decimals),
          source: "onchain_ingest",
        };
      } catch (err) {
        console.error(`[pool-price] falha ao ler preço de ${p.poolId} (${p.chain}):`, err);
        return null;
      }
    })
  );

  return lidas.filter((r): r is PriceHistoryRow => r !== null);
}

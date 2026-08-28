import type { Address } from "viem";
import { chainKeyFromDefillamaName, getActiveChains, type ChainKey } from "../../config/chains.js";
import { parseFeeTierLabel } from "../defillama/client.js";
import { rawSqrtRatio, sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { DEFAULT_REFERENCE, measureYield, type MeasuredYield, type ReferencePosition } from "../../domain/market/fee-per-liquidity.js";
import { getPoolInfo } from "./client.js";
import { getV4PoolInfo } from "./client-v4.js";
import { fetchFeeGrowthWindow, findBlockNearTimestamp } from "./fee-growth.js";

// Mede AO VIVO quanto cada pool paga por unidade de liquidez, pra ranquear em
// cima disso em vez do apyBase da DefiLlama (que divide por TVL e ignora que
// metade da liquidez de um pool concentrado está fora de faixa, sem ganhar
// nada — ver domain/market/fee-per-liquidity.ts pro caso real que expôs o erro).
//
// Só funciona em pools Uniswap V3/V4 de chain que o bot tem RPC. O resto do
// ranking continua caindo no giro, e o texto tem que dizer qual é qual — um
// número medido e um estimado lado a lado, sem etiqueta, é pior que só o
// estimado.

/** Janela de medição. 3 dias é o meio-termo: curto o bastante pra refletir o
 *  regime de agora, longo o bastante pra não virar ruído de um dia fraco.
 *  Medido em 28/08/2026: as mesmas pools pagaram 40% menos em 20h do que na
 *  média dos 4 dias anteriores — janela curta demais engana. */
export const MEASURE_WINDOW_DAYS = 3;

export type MeasurablePool = {
  poolId: string;
  chain: string;
  project: string;
  poolMeta: string | null;
  underlyingTokens: string[] | null;
};

export type PoolMeasurement = MeasuredYield & { feeTier: number };

type Resolved = { poolId: string; chainKey: ChainKey; isV4: boolean; tokenA: Address; tokenB: Address; fee: number };

function resolve(pool: MeasurablePool, active: ChainKey[]): Resolved | null {
  const chainKey = chainKeyFromDefillamaName(pool.chain);
  if (!chainKey || !active.includes(chainKey)) return null;
  const isV4 = pool.project === "uniswap-v4";
  if (!isV4 && pool.project !== "uniswap-v3") return null;
  const fee = parseFeeTierLabel(pool.poolMeta);
  if (fee === null || !pool.underlyingTokens || pool.underlyingTokens.length < 2) return null;
  return { poolId: pool.poolId, chainKey, isV4, tokenA: pool.underlyingTokens[0] as Address, tokenB: pool.underlyingTokens[1] as Address, fee };
}

async function measureOne(r: Resolved, toBlock: bigint, fromBlock: bigint, ref: ReferencePosition): Promise<PoolMeasurement | null> {
  const info = r.isV4
    ? await getV4PoolInfo(r.chainKey, r.tokenA, r.tokenB, r.fee)
    : await getPoolInfo(r.chainKey, r.tokenA, r.tokenB, r.fee);
  if (!info) return null;

  const window = await fetchFeeGrowthWindow(
    { chainKey: r.chainKey, isV4: r.isV4, poolRef: info.poolAddress, decimals0: info.token0.decimals, decimals1: info.token1.decimals },
    fromBlock,
    toBlock,
    MEASURE_WINDOW_DAYS
  );
  if (!window) return null;

  const price = sqrtPriceX96ToPrice(info.sqrtPriceX96, info.token0.decimals, info.token1.decimals);
  const measured = measureYield(window, rawSqrtRatio(info.sqrtPriceX96), price, info.token1.decimals, ref);
  return measured ? { ...measured, feeTier: r.fee } : null;
}

/**
 * Mede o que der; devolve um Map por poolId. Pool ausente do Map = não foi
 * medido (chain sem RPC, protocolo não suportado, hook customizado no V4,
 * leitura falhou) — nunca confundir com "mediu e deu zero".
 */
export async function measurePoolYields(
  pools: MeasurablePool[],
  ref: ReferencePosition = DEFAULT_REFERENCE
): Promise<Map<string, PoolMeasurement>> {
  const active = getActiveChains();
  const resolved = pools.map((p) => resolve(p, active)).filter((r): r is Resolved => r !== null);
  if (resolved.length === 0) return new Map();

  // Um par de blocos por CHAIN (não por pool): a busca de bloco é o pedaço
  // caro, e todas as pools da mesma chain compartilham a mesma janela.
  const targetSeconds = Math.floor(Date.now() / 1000) - MEASURE_WINDOW_DAYS * 86400;
  const chainKeys = [...new Set(resolved.map((r) => r.chainKey))];
  const blocksByChain = new Map<ChainKey, { from: bigint; to: bigint }>();
  await Promise.all(
    chainKeys.map(async (chainKey) => {
      try {
        const [from, to] = await Promise.all([
          findBlockNearTimestamp(chainKey, targetSeconds),
          findBlockNearTimestamp(chainKey, Math.floor(Date.now() / 1000)),
        ]);
        blocksByChain.set(chainKey, { from, to });
      } catch (err) {
        console.error(`[measure-pool-yield] falha ao localizar blocos em ${chainKey}:`, err);
      }
    })
  );

  const out = new Map<string, PoolMeasurement>();
  const settled = await Promise.allSettled(
    resolved.map(async (r) => {
      const blocks = blocksByChain.get(r.chainKey);
      if (!blocks) return null;
      const m = await measureOne(r, blocks.to, blocks.from, ref);
      return m ? ([r.poolId, m] as const) : null;
    })
  );
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) out.set(s.value[0], s.value[1]);
    else if (s.status === "rejected") console.error("[measure-pool-yield] medição falhou:", s.reason);
  }
  return out;
}

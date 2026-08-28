import type { Address } from "viem";
import { chainKeyFromDefillamaName, chains, getActiveChains, type ChainKey } from "../../config/chains.js";
import { parseFeeTierLabel } from "../defillama/client.js";
import { rawSqrtRatio, sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import {
  DEFAULT_REFERENCE,
  daysToLeaveRange,
  measureYield,
  volatilityFromTicks,
  type MeasuredYield,
  type ReferencePosition,
} from "../../domain/market/fee-per-liquidity.js";
import { parseAbi } from "viem";
import { getPoolInfo, getPublicClient } from "./client.js";
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

export type PoolMeasurement = MeasuredYield & {
  feeTier: number;
  /** σ diário do par, estimado dos ticks amostrados na janela. null = não deu. */
  dailyVolatility: number | null;
  /** Dias até o preço andar até a borda da faixa de referência. Teto otimista
   *  (encostar acontece antes) — serve pra ordem de grandeza. */
  daysInRange: number | null;
};

/** Quantos blocos amostrar pra estimar volatilidade. 9 pontos = 8 retornos
 *  sobre a janela de 3 dias. Não é uma medição fina de σ: é o suficiente pra
 *  separar "a faixa dura horas" de "a faixa dura dias", que é a distinção que
 *  muda a decisão. Todos os pools da mesma chain são lidos nos MESMOS blocos,
 *  num multicall por bloco — o custo é por chain, não por pool. */
const TICK_SAMPLES = 9;

const v3TickAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const v4TickAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const v3LiquidityAbi = parseAbi(["function liquidity() view returns (uint128)"]);
const v4LiquidityAbi = parseAbi(["function getLiquidity(bytes32 poolId) view returns (uint128)"]);

// Liquidez ATIVA no tick corrente — o denominador da diluição. Sem ela,
// measureYield se recusa a medir de propósito (ver o comentário lá).
async function fetchActiveLiquidity(chainKey: ChainKey, isV4: boolean, poolRef: string): Promise<number | null> {
  try {
    const client = getPublicClient(chainKey);
    if (isV4) {
      const v4 = chains[chainKey].uniswapV4;
      if (!v4) return null;
      return Number(
        await client.readContract({ address: v4.stateView, abi: v4LiquidityAbi, functionName: "getLiquidity", args: [poolRef as `0x${string}`] })
      );
    }
    return Number(await client.readContract({ address: poolRef as Address, abi: v3LiquidityAbi, functionName: "liquidity" }));
  } catch {
    return null;
  }
}

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

type Located = { ref: Resolved; poolRef: string };

async function measureOne(
  r: Resolved,
  toBlock: bigint,
  fromBlock: bigint,
  ref: ReferencePosition,
  located: Located[]
): Promise<PoolMeasurement | null> {
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
  const activeLiquidity = await fetchActiveLiquidity(r.chainKey, r.isV4, info.poolAddress);
  const measured = measureYield(window, rawSqrtRatio(info.sqrtPriceX96), price, info.token1.decimals, ref, activeLiquidity);
  if (!measured) return null;
  located.push({ ref: r, poolRef: info.poolAddress });
  // volatilidade entra depois, num passo compartilhado por chain
  return { ...measured, feeTier: r.fee, dailyVolatility: null, daysInRange: null };
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
  const located: Located[] = [];
  const settled = await Promise.allSettled(
    resolved.map(async (r) => {
      const blocks = blocksByChain.get(r.chainKey);
      if (!blocks) return null;
      const m = await measureOne(r, blocks.to, blocks.from, ref, located);
      return m ? ([r.poolId, m] as const) : null;
    })
  );
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value) out.set(s.value[0], s.value[1]);
    else if (s.status === "rejected") console.error("[measure-pool-yield] medição falhou:", s.reason);
  }

  await anexarVolatilidade(located, out, blocksByChain, ref);
  return out;
}

// Amostra o tick de TODOS os pools da chain nos MESMOS blocos, via multicall —
// o custo é ~TICK_SAMPLES multicalls por chain, não por pool. Falha aqui não
// invalida a medição de taxa: dailyVolatility fica null e quem exibe diz
// "não sei", em vez de sumir com a pool ou inventar um número.
async function anexarVolatilidade(
  located: Located[],
  out: Map<string, PoolMeasurement>,
  blocksByChain: Map<ChainKey, { from: bigint; to: bigint }>,
  ref: ReferencePosition
): Promise<void> {
  const porChain = new Map<ChainKey, Located[]>();
  for (const l of located) {
    const lista = porChain.get(l.ref.chainKey) ?? [];
    lista.push(l);
    porChain.set(l.ref.chainKey, lista);
  }

  await Promise.all(
    [...porChain.entries()].map(async ([chainKey, lista]) => {
      const blocks = blocksByChain.get(chainKey);
      if (!blocks) return;
      const v4 = chains[chainKey].uniswapV4;
      const client = getPublicClient(chainKey);

      const passo = (blocks.to - blocks.from) / BigInt(TICK_SAMPLES - 1);
      if (passo <= 0n) return;
      const amostras = Array.from({ length: TICK_SAMPLES }, (_, i) => blocks.from + passo * BigInt(i));

      try {
        const porBloco = await Promise.all(
          amostras.map(async (blockNumber) => {
            const [block, ticks] = await Promise.all([
              client.getBlock({ blockNumber }),
              client.multicall({
                contracts: lista.map((l) =>
                  l.ref.isV4
                    ? ({ address: v4!.stateView, abi: v4TickAbi, functionName: "getSlot0", args: [l.poolRef as `0x${string}`] } as const)
                    : ({ address: l.poolRef as Address, abi: v3TickAbi, functionName: "slot0" } as const)
                ),
                allowFailure: true,
                // SEM isto o multicall lê o estado ATUAL em todas as amostras,
                // e a série de ticks sai constante -> σ = 0 pra tudo.
                blockNumber,
              }),
            ]);
            return { seconds: Number(block.timestamp), ticks };
          })
        );

        lista.forEach((l, i) => {
          const serie = porBloco
            .map((b) => {
              const r = b.ticks[i];
              if (r?.status !== "success") return null;
              return { tick: Number((r.result as readonly unknown[])[1]), seconds: b.seconds };
            })
            .filter((x): x is { tick: number; seconds: number } => x !== null);

          const sigma = volatilityFromTicks(serie);
          const medida = out.get(l.ref.poolId);
          if (!medida || sigma === null) return;
          out.set(l.ref.poolId, {
            ...medida,
            dailyVolatility: sigma,
            daysInRange: daysToLeaveRange(sigma, ref.halfWidthLog),
          });
        });
      } catch (err) {
        console.error(`[measure-pool-yield] falha ao amostrar ticks em ${chainKey}:`, err);
      }
    })
  );
}

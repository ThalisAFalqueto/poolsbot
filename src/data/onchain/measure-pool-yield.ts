import type { Address } from "viem";
import { chainKeyFromDefillamaName, chains, getActiveChains, type ChainKey } from "../../config/chains.js";
import { parseFeeTierLabel } from "../defillama/client.js";
import { rawSqrtRatio, sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import {
  DEFAULT_REFERENCE,
  daysToLeaveRange,
  measureYield,
  netYield,
  volatilityFromTicks,
  type MeasuredYield,
  type ReferencePosition,
} from "../../domain/market/fee-per-liquidity.js";
import { parseAbi } from "viem";
import { getPoolInfo, getPublicClient } from "./client.js";
import { createTokenPriceResolver, type TokenPriceResolver } from "./token-price.js";
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

/**
 * Tamanho da posição de referência, EM DÓLARES.
 *
 * BUG QUE ISSO CORRIGE (28/08/2026): a referência era `valueToken1: 1000`, ou
 * seja 1000 UNIDADES DE TOKEN1 — o que só é $1.000 quando token1 é stable. Na
 * pool WBTC/EVA, token1 é EVA (~$43), então a referência valia $43.518 e o
 * aviso dizia "$1.000 aqui seriam 13% da liquidez ativa" quando o correto era
 * 0,3%. Pior: a correção de diluição era aplicada nessa escala errada, e o
 * retorno saía subestimado em toda pool cujo token1 não fosse dólar.
 *
 * O APR ANTES da diluição é adimensional (as unidades cancelam), então esse
 * erro só apareceu depois que a diluição entrou.
 */
const REFERENCE_USD = 1000;

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
  /** Custo anualizado de LVR. null quando não deu pra medir σ. */
  lvrApr: number | null;
  /** aprInRange − lvrApr. É o número que responde "quanto sobra". Pode ser
   *  negativo, e em par volátil costuma ser. */
  netApr: number | null;
};

/**
 * Quantos blocos amostrar pra estimar σ. 49 pontos sobre a janela de 3 dias =
 * uma amostra a cada ~1,5h.
 *
 * O NÚMERO FOI MEDIDO, não escolhido por gosto. σ entra no custo AO QUADRADO,
 * então erro aqui dobra na resposta. Rodando o mesmo pool (WBTC/USDC) com
 * densidades diferentes em 28/08/2026, contra a referência independente de
 * 1,8%-2,0%/dia medida sobre 37 dias do nosso banco:
 *
 *      9 amostras (9,0h)   σ 1,31%/dia   custo  53%/ano   <- subestima feio
 *     17 amostras (4,5h)   σ 1,21%/dia   custo  45%/ano
 *     25 amostras (3,0h)   σ 1,77%/dia   custo  96%/ano
 *     49 amostras (1,5h)   σ 1,95%/dia   custo 117%/ano   <- converge aqui
 *     73 amostras (1,0h)   σ 2,16%/dia   custo 143%/ano
 *    145 amostras (0,5h)   σ 1,93%/dia   custo 115%/ano
 *
 * Poucas amostras é erro de amostra pequena, não conservadorismo: com 8
 * retornos o σ saía quase 40% abaixo do real, e o bot dizia que a pool sobrava
 * +44%/ano quando na verdade estava perto do zero a zero.
 *
 * Todos os pools da mesma chain são lidos nos MESMOS blocos, num multicall por
 * bloco — o custo é por chain, não por pool (~4,7s pra 21 pools na Arbitrum).
 */
const TICK_SAMPLES = 49;

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

// Preço de token1 em dólares, pra converter a referência de USD pras unidades
// em que a liquidez é definida. Duas rotas, nessa ordem:
//   1. direto (token1 -> USDC), que resolve stable e majors;
//   2. derivado do token0, usando o preço DESTE pool. Cobre o caso comum de
//      um par major/alt onde o alt não tem pool contra USDC — foi exatamente o
//      caso do EVA, que só tem par com WBTC, ETH e USDT.
// Sem nenhuma das duas, devolve null e a pool não é medida: sem escala não dá
// pra calcular diluição, e assumir "sem diluição" é o erro que isso corrige.
async function token1UsdPrice(
  resolver: TokenPriceResolver,
  info: { token0: { address: Address; symbol: string }; token1: { address: Address; symbol: string } },
  poolPrice: number
): Promise<number | null> {
  const direto = await resolver(info.token1.address, info.token1.symbol);
  if (direto !== null && direto > 0) return direto;

  const token0Usd = await resolver(info.token0.address, info.token0.symbol);
  if (token0Usd === null || token0Usd <= 0 || poolPrice <= 0) return null;
  return token0Usd / poolPrice; // poolPrice = quantos token1 por token0
}

async function measureOne(
  r: Resolved,
  toBlock: bigint,
  fromBlock: bigint,
  ref: ReferencePosition,
  located: Located[],
  resolver: TokenPriceResolver
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

  // A referência é em DÓLARES e precisa virar unidades de token1 — senão a
  // diluição é calculada na escala errada (ver REFERENCE_USD).
  const usdPorToken1 = await token1UsdPrice(resolver, info, price);
  if (usdPorToken1 === null) return null;
  const refEmToken1: ReferencePosition = { ...ref, valueToken1: REFERENCE_USD / usdPorToken1 };

  const measured = measureYield(window, rawSqrtRatio(info.sqrtPriceX96), price, info.token1.decimals, refEmToken1, activeLiquidity);
  if (!measured) return null;
  located.push({ ref: r, poolRef: info.poolAddress });
  // volatilidade (e portanto o custo) entram depois, num passo por chain
  return { ...measured, feeTier: r.fee, dailyVolatility: null, daysInRange: null, lvrApr: null, netApr: null };
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
  // Um resolver por chain, com cache interno — vários pools compartilham os
  // mesmos tokens (WBTC, WETH, USDC) e cada resolução custa até 4 RPCs.
  const resolvers = new Map(chainKeys.map((k) => [k, createTokenPriceResolver(k)]));
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
      const m = await measureOne(r, blocks.to, blocks.from, ref, located, resolvers.get(r.chainKey)!);
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
          const liquido = netYield(medida, sigma, ref);
          out.set(l.ref.poolId, {
            ...medida,
            dailyVolatility: sigma,
            daysInRange: daysToLeaveRange(sigma, ref.halfWidthLog),
            lvrApr: liquido?.lvrApr ?? null,
            netApr: liquido?.netApr ?? null,
          });
        });
      } catch (err) {
        console.error(`[measure-pool-yield] falha ao amostrar ticks em ${chainKey}:`, err);
      }
    })
  );
}

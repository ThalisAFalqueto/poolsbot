import { parseAbi, type Address, type Hash } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import type { FeeGrowthWindow } from "../../domain/market/fee-per-liquidity.js";
import { getPublicClient } from "./client.js";

// Leitura de feeGrowthGlobal — a taxa acumulada POR UNIDADE DE LIQUIDEZ desde
// que o pool existe. Sozinho o número não diz nada (é um contador que só
// cresce); o que vale é a DIFERENÇA entre dois blocos dividida pelo tempo.
// Ver domain/market/fee-per-liquidity.ts pro porquê dessa métrica e não do
// apyBase da DefiLlama.

const v3PoolAbi = parseAbi([
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
]);

const v4StateViewAbi = parseAbi([
  "function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)",
]);

const Q128 = 2 ** 128;

/** Iterações da secante. Converge em 2-4 na prática; 8 é teto de segurança. */
const MAX_SEARCH_STEPS = 8;
/** Perto o bastante: erro de 2min numa janela de dias é irrelevante, e insistir
 *  além disso só gasta chamada de RPC. */
const BLOCK_TOLERANCE_SECONDS = 120;
/** Amostra usada pra estimar o tempo médio de bloco da chain. */
const BLOCK_TIME_SAMPLE = 100_000n;

const blockCache = new Map<string, bigint>();

// Acha o bloco mais próximo de um timestamp por SECANTE (estima o tempo médio
// de bloco e corrige o chute), não por busca binária pura: a Arbitrum tem
// ~500M blocos, e bissecção do zero custaria ~29 chamadas de RPC por chain
// contra as 3-5 daqui. Alternativas descartadas: tempo médio fixo por chain
// (a Arbitrum varia o ritmo e o erro acumula em dias) e API de terceiro
// (dependência externa pra algo que a própria RPC responde).
export async function findBlockNearTimestamp(chainKey: ChainKey, targetSeconds: number): Promise<bigint> {
  const cacheKey = `${chainKey}:${Math.round(targetSeconds / 600)}`; // baldes de 10min
  const cached = blockCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const client = getPublicClient(chainKey);
  const latest = await client.getBlock();
  const latestNumber = latest.number!;
  const latestTs = Number(latest.timestamp);
  if (latestTs <= targetSeconds) return latestNumber;

  const sampleNumber = latestNumber > BLOCK_TIME_SAMPLE ? latestNumber - BLOCK_TIME_SAMPLE : 1n;
  const sample = await client.getBlock({ blockNumber: sampleNumber });
  const spanBlocks = Number(latestNumber - sampleNumber);
  const secondsPerBlock = spanBlocks > 0 ? (latestTs - Number(sample.timestamp)) / spanBlocks : 12;

  let guess = latestNumber - BigInt(Math.round((latestTs - targetSeconds) / Math.max(secondsPerBlock, 1e-6)));
  if (guess < 1n) guess = 1n;

  for (let i = 0; i < MAX_SEARCH_STEPS; i++) {
    const block = await client.getBlock({ blockNumber: guess });
    const drift = Number(block.timestamp) - targetSeconds;
    if (Math.abs(drift) <= BLOCK_TOLERANCE_SECONDS) break;
    let next = guess - BigInt(Math.round(drift / Math.max(secondsPerBlock, 1e-6)));
    if (next < 1n) next = 1n;
    if (next > latestNumber) next = latestNumber;
    if (next === guess) break; // já não anda mais
    guess = next;
  }

  blockCache.set(cacheKey, guess);
  return guess;
}

async function readGrowth(chainKey: ChainKey, isV4: boolean, poolRef: string, blockNumber: bigint): Promise<[bigint, bigint]> {
  const client = getPublicClient(chainKey);
  if (isV4) {
    const v4 = chains[chainKey].uniswapV4;
    if (!v4) throw new Error(`chain ${chainKey} sem Uniswap V4 configurado`);
    const r = await client.readContract({
      address: v4.stateView,
      abi: v4StateViewAbi,
      functionName: "getFeeGrowthGlobals",
      args: [poolRef as Hash],
      blockNumber,
    });
    return [r[0], r[1]];
  }
  const [g0, g1] = await Promise.all([
    client.readContract({ address: poolRef as Address, abi: v3PoolAbi, functionName: "feeGrowthGlobal0X128", blockNumber }),
    client.readContract({ address: poolRef as Address, abi: v3PoolAbi, functionName: "feeGrowthGlobal1X128", blockNumber }),
  ]);
  return [g0, g1];
}

export type FeeGrowthQuery = {
  chainKey: ChainKey;
  isV4: boolean;
  /** Endereço do pool (V3) ou PoolId (V4) — mesma convenção de PoolInfo.poolAddress. */
  poolRef: string;
  decimals0: number;
  decimals1: number;
};

/**
 * Taxa acumulada por unidade de liquidez entre `fromBlock` e `toBlock`, já
 * convertida pra unidades humanas de cada token.
 *
 * Devolve null (nunca zero) quando a leitura falha: pool antigo demais pro nó,
 * PoolId inexistente, RPC fora. Zero é um valor REAL (pool sem swap nenhum) e
 * não pode se confundir com "não consegui medir".
 */
export async function fetchFeeGrowthWindow(
  query: FeeGrowthQuery,
  fromBlock: bigint,
  toBlock: bigint,
  days: number
): Promise<FeeGrowthWindow | null> {
  try {
    const [before, after] = await Promise.all([
      readGrowth(query.chainKey, query.isV4, query.poolRef, fromBlock),
      readGrowth(query.chainKey, query.isV4, query.poolRef, toBlock),
    ]);
    // feeGrowthGlobal é uint256 que dá overflow e volta a crescer do zero por
    // design (o contrato conta com isso). Diferença negativa = deu a volta;
    // corrigir é possível, mas é raríssimo e um número errado aqui vira
    // recomendação errada — prefiro não medir.
    const d0 = Number(after[0] - before[0]);
    const d1 = Number(after[1] - before[1]);
    if (d0 < 0 || d1 < 0) return null;

    return {
      perLiquidity0: d0 / Q128 / 10 ** query.decimals0,
      perLiquidity1: d1 / Q128 / 10 ** query.decimals1,
      days,
    };
  } catch (err) {
    console.error(`[fee-growth] falha ao ler ${query.chainKey} ${query.poolRef.slice(0, 12)}:`, err);
    return null;
  }
}

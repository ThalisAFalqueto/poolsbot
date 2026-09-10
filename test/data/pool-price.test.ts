import { describe, expect, it, vi } from "vitest";
import { readPoolPrices, type PoolInfoReader } from "../../src/data/onchain/pool-price.js";
import type { MeasurablePool } from "../../src/data/onchain/measure-pool-yield.js";

const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const POOL = "0x0E4831319A50228B9e450861297aB92dee15B44F";

const wbtcUsdc: MeasurablePool = {
  poolId: "7127db96",
  chain: "Arbitrum",
  project: "uniswap-v3",
  poolMeta: "0.05%",
  underlyingTokens: [WBTC, USDC],
};

// slot0 REAL do pool WBTC/USDC 0,05% da Arbitrum (0x0E48...B44F), lido em
// 10/09/2026: tick 66453, preço $76.897,57. Fixo de propósito — se
// sqrtPriceX96ToPrice mudar de convenção, este teste falha, em vez de o
// histórico passar a gravar outro número em silêncio.
const SQRT_ARBITRUM_WBTC_USDC = 2197029459405720754489701433344n;

const info = (poolAddress: string) => ({
  poolAddress: poolAddress as `0x${string}`,
  sqrtPriceX96: SQRT_ARBITRUM_WBTC_USDC,
  currentTick: 66453,
  token0: { address: WBTC as `0x${string}`, decimals: 8, symbol: "WBTC" },
  token1: { address: USDC as `0x${string}`, decimals: 6, symbol: "USDC" },
});

const lendo = (poolAddress = POOL): PoolInfoReader => vi.fn(async () => info(poolAddress));

describe("readPoolPrices", () => {
  it("converte o preço com os decimais do par", async () => {
    const [row] = await readPoolPrices([wbtcUsdc], { activeChains: ["arbitrum"], readInfo: lendo() });
    expect(row!.price).toBeCloseTo(76_897.57, 1);
    expect(row!.poolAddress).toBe(POOL);
    expect(row!.source).toBe("onchain_ingest");
  });

  // O erro silencioso que isso trava. O check-positions grava chain="arbitrum";
  // a DefiLlama chama a mesma chain de "Arbitrum", e getPriceHistorySince casa
  // por igualdade exata. Gravar o nome da DefiLlama criaria uma segunda série
  // paralela que nunca se junta à primeira — sem erro, sem aviso, só um
  // histórico que parece curto pra sempre.
  it("grava a ChainKey interna, não o nome da DefiLlama", async () => {
    const [row] = await readPoolPrices([wbtcUsdc], { activeChains: ["arbitrum"], readInfo: lendo() });
    expect(row!.chain).toBe("arbitrum");
  });

  it("omite pool de chain sem RPC configurado", async () => {
    const readInfo = lendo();
    expect(await readPoolPrices([wbtcUsdc], { activeChains: ["base"], readInfo })).toEqual([]);
    expect(readInfo).not.toHaveBeenCalled();
  });

  it("omite protocolo que não é Uniswap V3/V4", async () => {
    const pool = { ...wbtcUsdc, project: "aerodrome-slipstream" };
    expect(await readPoolPrices([pool], { activeChains: ["arbitrum"], readInfo: lendo() })).toEqual([]);
  });

  // Um ponto inventado é pior que um buraco: o backtest reconhece buraco (ver
  // MAX_GAP_DAYS) e descarta a janela; um preço errado ele usa.
  it("uma leitura que falha não derruba as outras", async () => {
    const outra: MeasurablePool = { ...wbtcUsdc, poolId: "outra", poolMeta: "0.30%" };
    const readInfo: PoolInfoReader = vi.fn(async (r) => {
      if (r.fee === 500) throw new Error("rpc down");
      return info("0x6fc4f4dd425f4f18a6833e31ada1bc9100000000");
    });
    const rows = await readPoolPrices([wbtcUsdc, outra], { activeChains: ["arbitrum"], readInfo });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.poolAddress).toBe("0x6fc4f4dd425f4f18a6833e31ada1bc9100000000");
  });

  it("pool sem par de tokens é omitida", async () => {
    const pool = { ...wbtcUsdc, underlyingTokens: null };
    expect(await readPoolPrices([pool], { activeChains: ["arbitrum"], readInfo: lendo() })).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findUniswapV3Pool, parseFeeTierLabel, type DefiLlamaPool } from "../../../src/data/defillama/client.js";

function makePool(overrides: Partial<DefiLlamaPool> = {}): DefiLlamaPool {
  return {
    pool: "pool-a",
    chain: "Arbitrum",
    project: "uniswap-v3",
    symbol: "WBTC-USDC",
    tvlUsd: 1_000_000,
    apyBase: 1,
    apyReward: null,
    apy: 1,
    apyPct1D: null,
    apyPct7D: null,
    apyPct30D: null,
    stablecoin: false,
    ilRisk: "yes",
    il7d: null,
    sigma: null,
    apyMean30d: null,
    apyBase7d: null,
    outlier: false,
    volumeUsd1d: 500_000,
    volumeUsd7d: null,
    poolMeta: "0.05%",
    underlyingTokens: ["0xAAAA000000000000000000000000000000AAAA", "0xBBBB000000000000000000000000000000BBBB"],
    ...overrides,
  };
}

describe("parseFeeTierLabel", () => {
  it("reconhece os 4 fee tiers padrão do Uniswap V3", () => {
    expect(parseFeeTierLabel("0.01%")).toBe(100);
    expect(parseFeeTierLabel("0.05%")).toBe(500);
    expect(parseFeeTierLabel("0.3%")).toBe(3000);
    expect(parseFeeTierLabel("1%")).toBe(10000);
  });

  it("retorna null pra rótulo desconhecido", () => {
    expect(parseFeeTierLabel("0.5%")).toBeNull();
  });

  it("retorna null pra poolMeta ausente", () => {
    expect(parseFeeTierLabel(null)).toBeNull();
  });

  it("tolera espaço em volta do rótulo", () => {
    expect(parseFeeTierLabel(" 0.05% ")).toBe(500);
  });
});

describe("findUniswapV3Pool", () => {
  const pools = [
    makePool(),
    makePool({ pool: "pool-b", chain: "Base", poolMeta: "0.3%", underlyingTokens: ["0xCCCC", "0xDDDD"] }),
    makePool({ pool: "pool-c", project: "balancer-v2" }),
  ];

  it("acha o pool casando chain+fee+tokens, case-insensitive e em qualquer ordem", () => {
    const found = findUniswapV3Pool(
      pools,
      "arbitrum",
      500,
      "0xbbbb000000000000000000000000000000bbbb",
      "0xaaaa000000000000000000000000000000aaaa"
    );
    expect(found?.pool).toBe("pool-a");
  });

  it("retorna undefined se o fee tier não bater", () => {
    const found = findUniswapV3Pool(pools, "Arbitrum", 3000, "0xAAAA000000000000000000000000000000AAAA", "0xBBBB000000000000000000000000000000BBBB");
    expect(found).toBeUndefined();
  });

  it("ignora pools de outro projeto mesmo com tokens/chain/fee batendo", () => {
    const found = findUniswapV3Pool(pools, "Arbitrum", 500, "0xAAAA000000000000000000000000000000AAAA", "0xBBBB000000000000000000000000000000BBBB");
    expect(found?.project).toBe("uniswap-v3");
  });

  it("retorna undefined quando nenhum pool bate", () => {
    const found = findUniswapV3Pool(pools, "Polygon", 500, "0xAAAA000000000000000000000000000000AAAA", "0xBBBB000000000000000000000000000000BBBB");
    expect(found).toBeUndefined();
  });
});

describe("fetchAllPools", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("tenta de novo com cache-buster se a 1ª resposta não for JSON válido (achado real: Cloudflare servindo corpo cacheado errado)", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async (url: string | URL) => {
      callCount += 1;
      if (callCount === 1) {
        expect(String(url)).not.toContain("?");
        return new Response("GET,HEAD", { status: 200 });
      }
      expect(String(url)).toContain("_cb=");
      return new Response(JSON.stringify({ status: "success", data: [makePool()] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { fetchAllPools } = await import("../../../src/data/defillama/client.js");
    const pools = await fetchAllPools();
    expect(callCount).toBe(2);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.pool).toBe("pool-a");
  });

  it("propaga o erro se a 2ª tentativa (com cache-buster) também falhar", async () => {
    global.fetch = vi.fn(async () => new Response("GET,HEAD", { status: 200 })) as unknown as typeof fetch;

    const { fetchAllPools } = await import("../../../src/data/defillama/client.js");
    await expect(fetchAllPools()).rejects.toThrow();
  });
});

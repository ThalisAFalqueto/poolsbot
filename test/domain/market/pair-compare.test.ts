import { describe, expect, it } from "vitest";
import { comparePoolsForPair, normalizePairKey, type ComparablePool } from "../../../src/domain/market/pair-compare.js";

function pool(overrides: Partial<ComparablePool> = {}): ComparablePool {
  return {
    poolId: "id-1",
    chain: "Arbitrum",
    project: "uniswap-v3",
    symbol: "WBTC-USDC",
    tvlUsd: 9_400_000,
    volumeUsd1d: 10_400_000,
    apyBase: 20.3,
    apy: 20.3,
    poolMeta: "0.05%",
    ...overrides,
  };
}

describe("normalizePairKey", () => {
  it("é insensível à ordem em que o protocolo lista o par", () => {
    expect(normalizePairKey("WBTC-USDC")).toBe(normalizePairKey("USDC-WBTC"));
  });

  it("é insensível a maiúsculas/minúsculas", () => {
    expect(normalizePairKey("wbtc-usdc")).toBe(normalizePairKey("WBTC-USDC"));
  });

  it("trata WETH e ETH como o mesmo ativo", () => {
    expect(normalizePairKey("WETH-USDC")).toBe(normalizePairKey("ETH-USDC"));
  });

  // Estes NÃO podem ser apelidos: são contratos, liquidez e risco distintos.
  // Tratá-los como iguais misturaria pools diferentes no mesmo ranking e o
  // usuário decidiria com base numa comparação falsa.
  it("USDC.e NÃO é o mesmo que USDC (ponte, não o nativo)", () => {
    expect(normalizePairKey("WBTC-USDC.E")).not.toBe(normalizePairKey("WBTC-USDC"));
  });

  it("USDT NÃO é o mesmo que USDC", () => {
    expect(normalizePairKey("WBTC-USDT")).not.toBe(normalizePairKey("WBTC-USDC"));
  });

  it("pool de 3+ ativos não é par comparável", () => {
    expect(normalizePairKey("DAI-USDC-USDT")).toBeNull();
  });

  it("símbolo de um token só não identifica par", () => {
    expect(normalizePairKey("USDC")).toBeNull();
  });
});

describe("comparePoolsForPair", () => {
  const key = normalizePairKey("WBTC-USDC")!;

  it("traz só as pools do par pedido", () => {
    const result = comparePoolsForPair(
      [pool(), pool({ poolId: "outro", symbol: "WETH-USDC" })],
      key,
      ["Arbitrum"]
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.poolId).toBe("id-1");
  });

  it("acha o mesmo par escrito na ordem inversa em outra chain", () => {
    const result = comparePoolsForPair(
      [pool({ poolId: "poly", chain: "Polygon", symbol: "USDC-WBTC" })],
      key,
      ["Polygon"]
    );
    expect(result).toHaveLength(1);
  });

  it("calcula giro como volume 24h sobre TVL", () => {
    const [r] = comparePoolsForPair([pool({ tvlUsd: 1000, volumeUsd1d: 500 })], key, []);
    expect(r?.turnover).toBeCloseTo(0.5, 10);
  });

  // null e 0 significam coisas diferentes: "a DefiLlama não reportou" não é
  // "o pool está parado". Zerar apagaria essa distinção no ranking.
  it("giro é null (não zero) quando não há volume reportado", () => {
    const [r] = comparePoolsForPair([pool({ volumeUsd1d: null })], key, []);
    expect(r?.turnover).toBeNull();
  });

  it("giro é null quando o TVL é zero, em vez de dividir por zero", () => {
    const [r] = comparePoolsForPair([pool({ tvlUsd: 0 })], key, []);
    expect(r?.turnover).toBeNull();
  });

  // Recomendar uma pool numa chain que o bot não consegue acompanhar seria
  // armadilha — o texto precisa poder marcar isso.
  it("marca se a chain é monitorável pelo bot", () => {
    const result = comparePoolsForPair(
      [pool({ chain: "Arbitrum" }), pool({ poolId: "x", chain: "Solana" })],
      key,
      ["Arbitrum", "Base"]
    );
    expect(result.find((r) => r.chain === "Arbitrum")?.isMonitorable).toBe(true);
    expect(result.find((r) => r.chain === "Solana")?.isMonitorable).toBe(false);
  });

  it("comparação de chain monitorável é insensível a maiúsculas", () => {
    const [r] = comparePoolsForPair([pool({ chain: "Arbitrum" })], key, ["arbitrum"]);
    expect(r?.isMonitorable).toBe(true);
  });
});

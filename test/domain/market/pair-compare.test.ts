import { describe, expect, it } from "vitest";
import {
  comparePoolsForPair,
  measuredSpread,
  normalizePairKey,
  rankPools,
  type ComparablePool,
  type ComparedPool,
} from "../../../src/domain/market/pair-compare.js";

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
    underlyingTokens: ["0x2f2a", "0xaf88"],
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

// ---------------------------------------------------------------------

function comparada(overrides: Partial<ComparedPool> = {}): ComparedPool {
  return { ...pool(), turnover: 1.1, isMonitorable: true, ...overrides };
}

const medida = (apr: number, netApr: number | null = null) => ({ aprInRange: apr, perLiquidityPerDay: 2.3e-9, days: 3, netApr });

describe("rankPools", () => {
  // O ponto da mudança de 28/08/2026: medido e estimado são grandezas
  // DIFERENTES. Ordenar os dois juntos por um número só foi o que fez o
  // ranking antigo errar por ~2x.
  it("põe pools medidas na frente das não medidas, mesmo com giro menor", () => {
    const medidaFraca = comparada({ poolId: "medida", turnover: 0.1 });
    const estimadaForte = comparada({ poolId: "estimada", turnover: 99 });
    const r = rankPools([estimadaForte, medidaFraca], new Map([["medida", medida(0.5)]]));
    expect(r[0]!.poolId).toBe("medida");
    expect(r[1]!.measured).toBeNull();
  });

  it("ordena as medidas por retorno medido", () => {
    const r = rankPools(
      [comparada({ poolId: "a" }), comparada({ poolId: "b" }), comparada({ poolId: "c" })],
      new Map([
        ["a", medida(0.9)],
        ["b", medida(1.4)],
        ["c", medida(1.1)],
      ])
    );
    expect(r.map((p) => p.poolId)).toEqual(["b", "c", "a"]);
  });

  it("ordena as não medidas por giro entre si", () => {
    const r = rankPools([comparada({ poolId: "x", turnover: 0.3 }), comparada({ poolId: "y", turnover: 2.0 })], new Map());
    expect(r.map((p) => p.poolId)).toEqual(["y", "x"]);
  });

  it("giro nulo vai pro fim em vez de liderar", () => {
    const r = rankPools([comparada({ poolId: "sem", turnover: null }), comparada({ poolId: "com", turnover: 0.01 })], new Map());
    expect(r.map((p) => p.poolId)).toEqual(["com", "sem"]);
  });
});

describe("measuredSpread", () => {
  it("precisa de pelo menos duas medições", () => {
    expect(measuredSpread(rankPools([comparada({ poolId: "a" })], new Map([["a", medida(1.0)]])))).toBeNull();
    expect(measuredSpread(rankPools([comparada({ poolId: "a" })], new Map()))).toBeNull();
  });

  // Caso real (28/08/2026): 4 pools do WBTC-USDC medidas entre 96,6% e 104,9%
  // — razão 1,09, ou seja "tanto faz qual pool". O apyBase das MESMAS pools
  // ia de 10,9% a 30,1% (razão 2,76) e teria mandado trocar de pool à toa.
  it("reproduz o spread medido no WBTC-USDC", () => {
    const r = rankPools(
      [comparada({ poolId: "a" }), comparada({ poolId: "b" }), comparada({ poolId: "c" }), comparada({ poolId: "d" })],
      new Map([
        ["a", medida(1.049)],
        ["b", medida(1.017)],
        ["c", medida(1.007)],
        ["d", medida(0.966)],
      ])
    );
    expect(measuredSpread(r)).toBeCloseTo(1.086, 2);
  });

  it("ignora as não medidas no cálculo do spread", () => {
    const r = rankPools(
      [comparada({ poolId: "a" }), comparada({ poolId: "b" }), comparada({ poolId: "z" })],
      new Map([
        ["a", medida(1.0)],
        ["b", medida(2.0)],
      ])
    );
    expect(measuredSpread(r)).toBeCloseTo(2, 6);
  });
});

describe("rankPools com custo descontado", () => {
  // O achado que motivou descontar o LVR: receita bruta premia par volátil
  // duas vezes — volatilidade gera volume (mais taxa) E gera arbitragem
  // (mais custo). Medido na Arbitrum em 28/08/2026, a ordem INVERTIA.
  it("ordena pelo líquido, não pela receita", () => {
    const r = rankPools(
      [comparada({ poolId: "volatil" }), comparada({ poolId: "calma" })],
      new Map([
        ["volatil", medida(1.35, 0.04)], // 135% de taxa, sobra 4%
        ["calma", medida(0.94, 0.71)], // 94% de taxa, sobra 71%
      ])
    );
    expect(r.map((p) => p.poolId)).toEqual(["calma", "volatil"]);
  });

  it("pool sem custo medido não disputa com quem tem", () => {
    const r = rankPools(
      [comparada({ poolId: "sem" }), comparada({ poolId: "com" })],
      new Map([
        ["sem", medida(9.99, null)],
        ["com", medida(0.5, 0.3)],
      ])
    );
    expect(r[0]!.poolId).toBe("com");
  });

  it("sem nenhum custo medido, cai pra receita", () => {
    const r = rankPools(
      [comparada({ poolId: "a" }), comparada({ poolId: "b" })],
      new Map([
        ["a", medida(0.5, null)],
        ["b", medida(1.2, null)],
      ])
    );
    expect(r[0]!.poolId).toBe("b");
  });
});

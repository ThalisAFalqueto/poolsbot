import { beforeEach, describe, expect, it } from "vitest";
import { getHistorySince, insertSnapshots } from "../../src/persistence/repositories/apy-history.repository.js";
import { truncateAll } from "./db-helper.js";

function snapshot(poolId: string, apy: number, recordedAtOverride?: Date) {
  return {
    poolId,
    chain: "Arbitrum",
    apyBase: apy,
    apyReward: null,
    apy,
    tvlUsd: 1_000_000,
    ilRisk: "no",
    il7d: null,
    ...(recordedAtOverride ? { recordedAt: recordedAtOverride } : {}),
  };
}

describe("apy-history.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("insertSnapshots com array vazio não lança erro nem grava nada", async () => {
    await insertSnapshots([]);
    const history = await getHistorySince(["pool-a"], new Date(0));
    expect(history.size).toBe(0);
  });

  it("getHistorySince filtra por data e agrupa por poolId em ordem ascendente", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 48 * 3600 * 1000); // fora da janela
    const recent1 = new Date(now.getTime() - 10 * 3600 * 1000);
    const recent2 = new Date(now.getTime() - 1 * 3600 * 1000);

    await insertSnapshots([
      { ...snapshot("pool-a", 5), recordedAt: old } as any,
      { ...snapshot("pool-a", 10), recordedAt: recent1 } as any,
      { ...snapshot("pool-a", 12), recordedAt: recent2 } as any,
      { ...snapshot("pool-b", 7), recordedAt: recent1 } as any,
    ]);

    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    const history = await getHistorySince(["pool-a", "pool-b"], since);

    expect(history.size).toBe(2);
    const poolAHistory = history.get("pool-a");
    expect(poolAHistory).toHaveLength(2); // "old" ficou de fora da janela
    expect(poolAHistory?.[0]?.apy).toBe(10); // ordem ascendente
    expect(poolAHistory?.[1]?.apy).toBe(12);
    expect(history.get("pool-b")).toHaveLength(1);
  });

  it("getHistorySince com lista de poolIds vazia retorna Map vazio sem tocar o banco", async () => {
    const history = await getHistorySince([], new Date(0));
    expect(history.size).toBe(0);
  });
});

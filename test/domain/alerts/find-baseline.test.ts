import { describe, expect, it } from "vitest";
import { findClosestBefore } from "../../../src/domain/alerts/find-baseline.js";
import type { PoolSnapshot } from "../../../src/domain/alerts/types.js";

function snap(hoursAgo: number, apy = 10): PoolSnapshot {
  return {
    apy,
    apyBase: apy,
    apyReward: null,
    tvlUsd: 1_000_000,
    ilRisk: "no",
    il7d: null,
    recordedAt: new Date(Date.now() - hoursAgo * 3600 * 1000),
  };
}

describe("findClosestBefore", () => {
  it("retorna o snapshot mais recente <= targetTime", () => {
    const history = [snap(48), snap(30), snap(20), snap(1)];
    const target = new Date(Date.now() - 24 * 3600 * 1000);
    const result = findClosestBefore(history, target);
    expect(result).not.toBeNull();
    expect(result!.recordedAt.getTime()).toBe(history[1].recordedAt.getTime());
  });

  it("retorna null quando não há snapshot antigo o suficiente", () => {
    const history = [snap(1), snap(0.5)];
    const target = new Date(Date.now() - 24 * 3600 * 1000);
    expect(findClosestBefore(history, target)).toBeNull();
  });

  it("retorna null pra histórico vazio", () => {
    expect(findClosestBefore([], new Date())).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { formatReason } from "../../../src/domain/alerts/format-reason.js";
import type { AlertRuleConfig, PoolSnapshot } from "../../../src/domain/alerts/types.js";

function makeRule(overrides: Partial<AlertRuleConfig> = {}): AlertRuleConfig {
  return { id: 1, metric: "apy_drop_relative", thresholdValue: 0.2, windowHours: 24, reminderIntervalHours: 12, ...overrides };
}

function makeSnapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return { apy: 10, apyBase: 10, apyReward: null, tvlUsd: 1_000_000, ilRisk: null, il7d: null, volumeUsd: null, recordedAt: new Date(), ...overrides };
}

describe("formatReason", () => {
  // Achado real em produção (23/08/2026): um alerta "recovered" de
  // apy_drop_relative disparou com APY 16.24% -> 21.29% (uma ALTA de 31%, não
  // queda) e a mensagem dizia "APY caiu -31.0%" — texto contraditório com os
  // próprios números mostrados. "recovered" só exige cruzar de volta o
  // threshold com folga de histerese (ver evaluate-rule.ts), não voltar perto
  // do baseline, então o valor pode virar bem positivo do outro lado.
  it("apy_drop_relative: descreve como alta quando o baseline é MENOR que o atual (drop negativo)", () => {
    const reason = formatReason(makeRule(), makeSnapshot({ apy: 21.29 }), makeSnapshot({ apy: 16.24 }), "recovered");
    expect(reason).toContain("APY subiu 31.1% em 24h (16.24% → 21.29%)");
    expect(reason).not.toContain("caiu");
  });

  it("apy_drop_relative: descreve como queda quando o baseline é MAIOR que o atual (drop positivo)", () => {
    const reason = formatReason(makeRule(), makeSnapshot({ apy: 8 }), makeSnapshot({ apy: 20 }), "triggered");
    expect(reason).toContain("APY caiu 60.0% em 24h (20.00% → 8.00%)");
    expect(reason).not.toContain("subiu");
  });

  it("tvl_drop_relative: descreve como alta quando o TVL atual é maior que o baseline", () => {
    const reason = formatReason(
      makeRule({ metric: "tvl_drop_relative" }),
      makeSnapshot({ tvlUsd: 2_000_000 }),
      makeSnapshot({ tvlUsd: 1_000_000 }),
      "recovered"
    );
    expect(reason).toContain("TVL subiu 100.0%");
  });

  it("volume_spike_relative: descreve como disparo quando o volume sobe", () => {
    const reason = formatReason(
      makeRule({ metric: "volume_spike_relative" }),
      makeSnapshot({ volumeUsd: 500_000 }),
      makeSnapshot({ volumeUsd: 100_000 }),
      "triggered"
    );
    expect(reason).toContain("Volume disparou 400.0%");
  });

  it("volume_spike_relative: descreve como queda quando o volume cai (recovered de um pico anterior)", () => {
    const reason = formatReason(
      makeRule({ metric: "volume_spike_relative" }),
      makeSnapshot({ volumeUsd: 50_000 }),
      makeSnapshot({ volumeUsd: 100_000 }),
      "recovered"
    );
    expect(reason).toContain("Volume caiu 50.0%");
  });

  it("reward_apy_ending: usa 'voltou a subir' (sem o aviso de fim de incentivo) quando o valor atual supera o baseline", () => {
    const reason = formatReason(
      makeRule({ metric: "reward_apy_ending" }),
      makeSnapshot({ apyReward: 8 }),
      makeSnapshot({ apyReward: 5 }),
      "recovered"
    );
    expect(reason).toContain("APY de recompensa voltou a subir de 5.00% para 8.00%.");
    expect(reason).not.toContain("possível fim de incentivo");
  });

  it("reward_apy_ending: mantém 'caiu ... possível fim de incentivo' quando o valor atual é menor ou igual ao baseline", () => {
    const reason = formatReason(
      makeRule({ metric: "reward_apy_ending" }),
      makeSnapshot({ apyReward: 1 }),
      makeSnapshot({ apyReward: 5 }),
      "triggered"
    );
    expect(reason).toContain("APY de recompensa caiu de 5.00% para 1.00% — possível fim de incentivo.");
  });
});

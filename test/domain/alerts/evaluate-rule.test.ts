import { describe, expect, it } from "vitest";
import { evaluateRule } from "../../../src/domain/alerts/evaluate-rule.js";
import type { AlertRuleConfig, AlertRuleState, PoolSnapshot } from "../../../src/domain/alerts/types.js";

const NOW = new Date("2026-08-15T12:00:00Z");

function makeRule(overrides: Partial<AlertRuleConfig> = {}): AlertRuleConfig {
  return {
    id: 1,
    metric: "apy_drop_relative",
    thresholdValue: 0.2,
    windowHours: 24,
    reminderIntervalHours: 6,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    apy: 10,
    apyBase: 10,
    apyReward: null,
    tvlUsd: 1_000_000,
    ilRisk: "no",
    il7d: null,
    recordedAt: NOW,
    ...overrides,
  };
}

const OK_STATE: AlertRuleState = { status: "ok", lastValue: null, triggeredAt: null, lastNotifiedAt: null };

describe("evaluateRule — apy_drop_relative", () => {
  it("ok -> ok quando a queda fica abaixo do threshold", () => {
    const rule = makeRule({ thresholdValue: 0.2 });
    const baseline = makeSnapshot({ apy: 10 });
    const current = makeSnapshot({ apy: 9 }); // queda de 10%
    const { nextState, notification } = evaluateRule({ rule, state: OK_STATE, current, baseline, now: NOW });
    expect(nextState.status).toBe("ok");
    expect(notification).toBeNull();
  });

  it("ok -> triggered na borda exata do threshold (edge-triggered)", () => {
    const rule = makeRule({ thresholdValue: 0.2 });
    const baseline = makeSnapshot({ apy: 10 });
    const current = makeSnapshot({ apy: 8 }); // queda de exatamente 20%
    const { nextState, notification } = evaluateRule({ rule, state: OK_STATE, current, baseline, now: NOW });
    expect(nextState.status).toBe("triggered");
    expect(nextState.triggeredAt).toEqual(NOW);
    expect(nextState.lastNotifiedAt).toEqual(NOW);
    expect(notification?.kind).toBe("triggered");
    expect(notification?.reason).toContain("APY caiu");
  });

  it("triggered -> triggered sem notificação quando o lembrete não venceu", () => {
    const rule = makeRule({ thresholdValue: 0.2, reminderIntervalHours: 6 });
    const triggeredAt = new Date(NOW.getTime() - 2 * 3600 * 1000);
    const state: AlertRuleState = { status: "triggered", lastValue: 0.2, triggeredAt, lastNotifiedAt: triggeredAt };
    const baseline = makeSnapshot({ apy: 10 });
    const current = makeSnapshot({ apy: 7.5 }); // ainda em queda, 2h desde o último aviso (< 6h)
    const { nextState, notification } = evaluateRule({ rule, state, current, baseline, now: NOW });
    expect(nextState.status).toBe("triggered");
    expect(notification).toBeNull();
    expect(nextState.lastNotifiedAt).toEqual(triggeredAt); // não avança
  });

  it("triggered -> triggered com lembrete quando o intervalo venceu", () => {
    const rule = makeRule({ thresholdValue: 0.2, reminderIntervalHours: 6 });
    const triggeredAt = new Date(NOW.getTime() - 7 * 3600 * 1000);
    const state: AlertRuleState = { status: "triggered", lastValue: 0.2, triggeredAt, lastNotifiedAt: triggeredAt };
    const baseline = makeSnapshot({ apy: 10 });
    const current = makeSnapshot({ apy: 7.5 }); // ainda em queda, 7h desde o último aviso (>= 6h)
    const { nextState, notification } = evaluateRule({ rule, state, current, baseline, now: NOW });
    expect(nextState.status).toBe("triggered");
    expect(notification?.kind).toBe("reminder");
    expect(nextState.lastNotifiedAt).toEqual(NOW);
  });

  it("triggered -> ok só quando recupera além da margem de histerese", () => {
    const rule = makeRule({ thresholdValue: 0.2 });
    const triggeredAt = new Date(NOW.getTime() - 3600 * 1000);
    const state: AlertRuleState = { status: "triggered", lastValue: 0.2, triggeredAt, lastNotifiedAt: triggeredAt };
    const baseline = makeSnapshot({ apy: 10 });

    // drop de 17% (0.17): ainda dentro da zona de histerese (threshold 0.2 - 0.05 = 0.15), não recupera
    const stillTriggered = evaluateRule({ rule, state, current: makeSnapshot({ apy: 8.3 }), baseline, now: NOW });
    expect(stillTriggered.nextState.status).toBe("triggered");

    // drop de 14% (0.14): abaixo de 0.15, recupera
    const recovered = evaluateRule({ rule, state, current: makeSnapshot({ apy: 8.6 }), baseline, now: NOW });
    expect(recovered.nextState.status).toBe("ok");
    expect(recovered.notification?.kind).toBe("recovered");
    expect(recovered.nextState.triggeredAt).toBeNull();
  });

  it("baseline null (dado insuficiente) não muda o estado", () => {
    const rule = makeRule();
    const current = makeSnapshot({ apy: 5 });
    const { nextState, notification } = evaluateRule({ rule, state: OK_STATE, current, baseline: null, now: NOW });
    expect(nextState).toEqual(OK_STATE);
    expect(notification).toBeNull();
  });
});

describe("evaluateRule — reward_apy_ending", () => {
  it("não dispara quando o baseline de reward é 0/null", () => {
    const rule = makeRule({ metric: "reward_apy_ending", thresholdValue: 0.9, windowHours: null });
    const baseline = makeSnapshot({ apyReward: 0 });
    const current = makeSnapshot({ apyReward: 0 });
    const { nextState, notification } = evaluateRule({ rule, state: OK_STATE, current, baseline, now: NOW });
    expect(nextState).toEqual(OK_STATE);
    expect(notification).toBeNull();
  });

  it("dispara quando o reward cai >=90% em relação ao snapshot anterior", () => {
    const rule = makeRule({ metric: "reward_apy_ending", thresholdValue: 0.9, windowHours: null });
    const baseline = makeSnapshot({ apyReward: 20 });
    const current = makeSnapshot({ apyReward: 1 }); // queda de 95%
    const { nextState, notification } = evaluateRule({ rule, state: OK_STATE, current, baseline, now: NOW });
    expect(nextState.status).toBe("triggered");
    expect(notification?.reason).toContain("recompensa");
  });
});

describe("evaluateRule — il_risk_proxy", () => {
  it("não dispara quando ilRisk é 'no'", () => {
    const rule = makeRule({ metric: "il_risk_proxy", thresholdValue: 0.05, windowHours: null });
    const current = makeSnapshot({ ilRisk: "no", il7d: 0.1 });
    const { nextState, notification } = evaluateRule({ rule, state: OK_STATE, current, baseline: null, now: NOW });
    expect(nextState.status).toBe("ok");
    expect(notification).toBeNull();
  });

  it("dispara via fallback categórico quando ilRisk='yes' e il7d é null", () => {
    const rule = makeRule({ metric: "il_risk_proxy", thresholdValue: 0.05, windowHours: null });
    const current = makeSnapshot({ ilRisk: "yes", il7d: null });
    const { nextState, notification } = evaluateRule({ rule, state: OK_STATE, current, baseline: null, now: NOW });
    expect(nextState.status).toBe("triggered");
    expect(notification?.confidence).toBe(0.4);
    expect(notification?.reason).toContain("sem magnitude");
  });

  it("dispara com magnitude quando il7d está presente e cruza o threshold", () => {
    const rule = makeRule({ metric: "il_risk_proxy", thresholdValue: 0.05, windowHours: null });
    const current = makeSnapshot({ ilRisk: "yes", il7d: -0.08 });
    const { nextState, notification } = evaluateRule({ rule, state: OK_STATE, current, baseline: null, now: NOW });
    expect(nextState.status).toBe("triggered");
    expect(notification?.confidence).toBe(0.6);
  });
});

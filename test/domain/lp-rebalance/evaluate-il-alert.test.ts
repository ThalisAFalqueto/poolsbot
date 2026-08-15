import { describe, expect, it } from "vitest";
import { evaluateIlAlert } from "../../../src/domain/lp-rebalance/evaluate-il-alert.js";
import type { IlAlertState } from "../../../src/domain/lp-rebalance/evaluate-il-alert.js";
import type { ImpermanentLossResult } from "../../../src/domain/lp-rebalance/calculate-il.js";
import type { OnchainPosition } from "../../../src/domain/lp-rebalance/types.js";

const NOW = new Date("2026-08-15T12:00:00Z");

const POSITION: OnchainPosition = {
  tokenId: 1n,
  poolAddress: "0x0000000000000000000000000000000000000001",
  fee: 3000,
  tickLower: -6931,
  tickUpper: 6931,
  currentTick: 0,
  sqrtPriceX96: 2n ** 96n,
  liquidity: 1_000_000_000n,
  token0: { address: "0x0000000000000000000000000000000000000002", decimals: 18, symbol: "WETH" },
  token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDC" },
};

function makeIl(ilPct: number): ImpermanentLossResult {
  return {
    ilPct,
    hodlValueToken1: 1000,
    positionValueToken1: 1000 * (1 + ilPct),
    baselineAmount0: 1,
    baselineAmount1: 500,
    currentAmount0: 1,
    currentAmount1: 500,
    since: new Date("2026-08-01T00:00:00Z"),
  };
}

const OK_STATE: IlAlertState = { status: "ok", triggeredAt: null, lastNotifiedAt: null };

describe("evaluateIlAlert", () => {
  it("ok -> ok quando IL está acima do threshold de disparo", () => {
    const { nextState, notification } = evaluateIlAlert({ position: POSITION, il: makeIl(-0.02), state: OK_STATE, now: NOW });
    expect(nextState.status).toBe("ok");
    expect(notification).toBeNull();
  });

  it("ok -> triggered quando IL cruza -5% (edge-triggered)", () => {
    const { nextState, notification } = evaluateIlAlert({ position: POSITION, il: makeIl(-0.06), state: OK_STATE, now: NOW });
    expect(nextState.status).toBe("triggered");
    expect(nextState.triggeredAt).toEqual(NOW);
    expect(notification?.kind).toBe("triggered");
    expect(notification?.reason).toContain("IL alto");
  });

  it("triggered -> triggered sem notificação quando o lembrete não venceu", () => {
    const triggeredAt = new Date(NOW.getTime() - 2 * 3600 * 1000);
    const state: IlAlertState = { status: "triggered", triggeredAt, lastNotifiedAt: triggeredAt };
    const { nextState, notification } = evaluateIlAlert({ position: POSITION, il: makeIl(-0.06), state, now: NOW });
    expect(nextState.status).toBe("triggered");
    expect(notification).toBeNull();
  });

  it("triggered -> lembrete quando o intervalo de 6h venceu", () => {
    const triggeredAt = new Date(NOW.getTime() - 7 * 3600 * 1000);
    const state: IlAlertState = { status: "triggered", triggeredAt, lastNotifiedAt: triggeredAt };
    const { nextState, notification } = evaluateIlAlert({ position: POSITION, il: makeIl(-0.06), state, now: NOW });
    expect(nextState.status).toBe("triggered");
    expect(notification?.kind).toBe("reminder");
  });

  it("triggered -> ok só com histerese (recupera além de -3.5%)", () => {
    const triggeredAt = new Date(NOW.getTime() - 3600 * 1000);
    const state: IlAlertState = { status: "triggered", triggeredAt, lastNotifiedAt: triggeredAt };

    // -4%: ainda na zona de histerese (entre -5% e -3.5%), não recupera
    const stillTriggered = evaluateIlAlert({ position: POSITION, il: makeIl(-0.04), state, now: NOW });
    expect(stillTriggered.nextState.status).toBe("triggered");

    // -3%: além da margem, recupera de verdade
    const recovered = evaluateIlAlert({ position: POSITION, il: makeIl(-0.03), state, now: NOW });
    expect(recovered.nextState.status).toBe("ok");
    expect(recovered.notification?.kind).toBe("recovered");
    expect(recovered.nextState.triggeredAt).toBeNull();
  });
});

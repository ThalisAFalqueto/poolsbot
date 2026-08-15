import { describe, expect, it } from "vitest";
import { evaluatePosition } from "../../../src/domain/lp-rebalance/evaluate-position.js";
import type { OnchainPosition, PositionState } from "../../../src/domain/lp-rebalance/types.js";

const NOW = new Date("2026-08-15T12:00:00Z");

function makePosition(overrides: Partial<OnchainPosition> = {}): OnchainPosition {
  return {
    tokenId: 1n,
    poolAddress: "0x0000000000000000000000000000000000000001",
    fee: 3000,
    tickLower: 1000,
    tickUpper: 2000, // largura 1000, margem de recuperação = 100
    currentTick: 1500,
    sqrtPriceX96: 2n ** 96n,
    liquidity: 1_000_000_000n,
    token0: { address: "0x0000000000000000000000000000000000000002", decimals: 18, symbol: "WETH" },
    token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDC" },
    ...overrides,
  };
}

const IN_RANGE_STATE: PositionState = { status: "in_range", outOfRangeSince: null, lastNotifiedAt: null };

describe("evaluatePosition", () => {
  it("in_range -> in_range sem notificação quando o tick continua dentro", () => {
    const position = makePosition({ currentTick: 1500 });
    const { nextState, notification } = evaluatePosition({ position, state: IN_RANGE_STATE, now: NOW });
    expect(nextState.status).toBe("in_range");
    expect(notification).toBeNull();
  });

  it("in_range -> out_of_range assim que o tick sai (edge-triggered, sem margem)", () => {
    const position = makePosition({ currentTick: 2000 }); // >= tickUpper
    const { nextState, notification } = evaluatePosition({ position, state: IN_RANGE_STATE, now: NOW });
    expect(nextState.status).toBe("out_of_range");
    expect(nextState.outOfRangeSince).toEqual(NOW);
    expect(nextState.lastNotifiedAt).toEqual(NOW);
    expect(notification?.kind).toBe("out_of_range");
    expect(notification?.reason).toContain("fora da faixa");
  });

  it("out_of_range -> out_of_range sem notificação quando o lembrete não venceu", () => {
    const outOfRangeSince = new Date(NOW.getTime() - 2 * 3600 * 1000);
    const state: PositionState = { status: "out_of_range", outOfRangeSince, lastNotifiedAt: outOfRangeSince };
    const position = makePosition({ currentTick: 2100 }); // ainda fora, 2h desde o aviso (<6h)
    const { nextState, notification } = evaluatePosition({ position, state, now: NOW });
    expect(nextState.status).toBe("out_of_range");
    expect(notification).toBeNull();
    expect(nextState.lastNotifiedAt).toEqual(outOfRangeSince);
  });

  it("out_of_range -> lembrete quando o intervalo de 6h venceu", () => {
    const outOfRangeSince = new Date(NOW.getTime() - 7 * 3600 * 1000);
    const state: PositionState = { status: "out_of_range", outOfRangeSince, lastNotifiedAt: outOfRangeSince };
    const position = makePosition({ currentTick: 2100 });
    const { nextState, notification } = evaluatePosition({ position, state, now: NOW });
    expect(nextState.status).toBe("out_of_range");
    expect(notification?.kind).toBe("reminder");
    expect(nextState.lastNotifiedAt).toEqual(NOW);
  });

  it("out_of_range -> in_range só com margem de segurança (histerese)", () => {
    const outOfRangeSince = new Date(NOW.getTime() - 3600 * 1000);
    const state: PositionState = { status: "out_of_range", outOfRangeSince, lastNotifiedAt: outOfRangeSince };

    // margem = 10% de 1000 = 100. tick 1050: dentro do range (>=1000,<2000) mas
    // ainda na zona de margem (1000+100=1100), não conta como "seguro" ainda.
    const stillFlagged = evaluatePosition({ position: makePosition({ currentTick: 1050 }), state, now: NOW });
    expect(stillFlagged.nextState.status).toBe("out_of_range");

    // tick 1150: além da margem de segurança, recupera de verdade.
    const recovered = evaluatePosition({ position: makePosition({ currentTick: 1150 }), state, now: NOW });
    expect(recovered.nextState.status).toBe("in_range");
    expect(recovered.notification?.kind).toBe("back_in_range");
    expect(recovered.nextState.outOfRangeSince).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { evaluatePosition } from "../../../src/domain/lp-rebalance/evaluate-position.js";
import type { OnchainPosition, PositionRangeSuggestion, PositionState } from "../../../src/domain/lp-rebalance/types.js";

const NOW = new Date("2026-08-15T12:00:00Z");

// Usado nos testes que esperam notificação out_of_range/reminder. NÃO é
// obrigatório: format-reason.ts tolera null e só omite a linha da sugestão
// (ver o teste de zona morta no fim deste arquivo).
const HEURISTIC_SUGGESTION: PositionRangeSuggestion = {
  range: { tickLower: -1000, tickUpper: 1000 },
  source: "heuristic",
  volatilityWindowSeconds: null,
};

function makePosition(overrides: Partial<OnchainPosition> = {}): OnchainPosition {
  return {
    chain: "arbitrum",
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
    const { nextState, notification } = evaluatePosition({ position, state: IN_RANGE_STATE, now: NOW, gasCost: null, suggestedRange: null });
    expect(nextState.status).toBe("in_range");
    expect(notification).toBeNull();
  });

  it("in_range -> out_of_range assim que o tick sai (edge-triggered, sem margem)", () => {
    const position = makePosition({ currentTick: 2000 }); // >= tickUpper
    const { nextState, notification } = evaluatePosition({
      position,
      state: IN_RANGE_STATE,
      now: NOW,
      gasCost: null,
      suggestedRange: HEURISTIC_SUGGESTION,
    });
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
    const { nextState, notification } = evaluatePosition({ position, state, now: NOW, gasCost: null, suggestedRange: null });
    expect(nextState.status).toBe("out_of_range");
    expect(notification).toBeNull();
    expect(nextState.lastNotifiedAt).toEqual(outOfRangeSince);
  });

  it("out_of_range -> lembrete quando o intervalo de 6h venceu", () => {
    const outOfRangeSince = new Date(NOW.getTime() - 7 * 3600 * 1000);
    const state: PositionState = { status: "out_of_range", outOfRangeSince, lastNotifiedAt: outOfRangeSince };
    const position = makePosition({ currentTick: 2100 });
    const { nextState, notification } = evaluatePosition({
      position,
      state,
      now: NOW,
      gasCost: null,
      suggestedRange: HEURISTIC_SUGGESTION,
    });
    expect(nextState.status).toBe("out_of_range");
    expect(notification?.kind).toBe("reminder");
    expect(nextState.lastNotifiedAt).toEqual(NOW);
  });

  it("out_of_range -> in_range só com margem de segurança (histerese)", () => {
    const outOfRangeSince = new Date(NOW.getTime() - 3600 * 1000);
    const state: PositionState = { status: "out_of_range", outOfRangeSince, lastNotifiedAt: outOfRangeSince };

    // margem = 10% de 1000 = 100. tick 1050: dentro do range (>=1000,<2000) mas
    // ainda na zona de margem (1000+100=1100), não conta como "seguro" ainda.
    const stillFlagged = evaluatePosition({ position: makePosition({ currentTick: 1050 }), state, now: NOW, gasCost: null, suggestedRange: null });
    expect(stillFlagged.nextState.status).toBe("out_of_range");

    // tick 1150: além da margem de segurança, recupera de verdade.
    const recovered = evaluatePosition({ position: makePosition({ currentTick: 1150 }), state, now: NOW, gasCost: null, suggestedRange: null });
    expect(recovered.nextState.status).toBe("in_range");
    expect(recovered.notification?.kind).toBe("back_in_range");
    expect(recovered.nextState.outOfRangeSince).toBeNull();
  });

  it("gasCost, quando fornecido, aparece na reason da notificação out_of_range", () => {
    const position = makePosition({ currentTick: 2000 });
    const gasCost = { costEth: 0.001, costToken1: 2.5 };
    const { notification } = evaluatePosition({ position, state: IN_RANGE_STATE, now: NOW, gasCost, suggestedRange: HEURISTIC_SUGGESTION });
    expect(notification?.reason).toContain("Custo estimado de rebalance");
  });

  // REGRESSÃO — bug real de produção (27/08/2026). O job decidia se calculava
  // a faixa sugerida com `isInRange` (borda crua) e esta máquina de estado só
  // considera recuperado com margem de histerese. Na faixa entre os dois
  // critérios ("zona morta"), o job mandava null e o lembrete era emitido
  // mesmo assim — o formatter estourava com TypeError e derrubava o ciclo
  // INTEIRO da wallet (histórico de preço e alerta de IL junto).
  describe("zona morta da histerese (regressão)", () => {
    // Faixa 1000-2000, margem 10% = 100. Zona morta: [1000,1100) e [1900,2000).
    const OUT_OF_RANGE_STATE: PositionState = {
      status: "out_of_range",
      outOfRangeSince: new Date("2026-08-15T00:00:00Z"),
      lastNotifiedAt: new Date("2026-08-15T00:00:00Z"), // >6h atrás: lembrete devido
    };

    it("tick dentro da borda mas dentro da margem NÃO é considerado recuperado", () => {
      const position = makePosition({ currentTick: 1050 }); // dentro de 1000-2000, mas < 1100
      const { nextState, notification } = evaluatePosition({
        position,
        state: OUT_OF_RANGE_STATE,
        now: NOW,
        gasCost: null,
        suggestedRange: HEURISTIC_SUGGESTION,
      });
      expect(nextState.status).toBe("out_of_range");
      expect(notification?.kind).toBe("reminder");
    });

    it("emite o lembrete sem estourar quando a sugestão vem null", () => {
      const position = makePosition({ currentTick: 1050 });
      expect(() =>
        evaluatePosition({ position, state: OUT_OF_RANGE_STATE, now: NOW, gasCost: null, suggestedRange: null })
      ).not.toThrow();
    });

    it("sem sugestão, a mensagem omite a linha de faixa em vez de quebrar", () => {
      const position = makePosition({ currentTick: 1050 });
      const { notification } = evaluatePosition({
        position,
        state: OUT_OF_RANGE_STATE,
        now: NOW,
        gasCost: null,
        suggestedRange: null,
      });
      expect(notification?.reason).toContain("continua fora da faixa");
      expect(notification?.reason).not.toContain("Faixa sugerida");
    });

    it("aviso inicial de saída também tolera sugestão null", () => {
      const position = makePosition({ currentTick: 2500 }); // fora de verdade
      const { notification } = evaluatePosition({
        position,
        state: IN_RANGE_STATE,
        now: NOW,
        gasCost: null,
        suggestedRange: null,
      });
      expect(notification?.kind).toBe("out_of_range");
      expect(notification?.reason).toContain("fora da faixa");
    });
  });
});

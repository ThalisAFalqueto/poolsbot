import { describe, expect, it } from "vitest";
import { edgeProximity, isNearEdge, NEAR_EDGE_FRACTION } from "../../../src/domain/lp-rebalance/near-edge.js";

// Faixa real da posição de ETH/USDC do usuário: ticks -198570 a -197960
// ($2.380,38 – $2.530,09), largura 610 ticks.
const LO = -198570;
const HI = -197960;
const MEIO = (LO + HI) / 2;

describe("edgeProximity", () => {
  it("no meio da faixa, está a meia largura de qualquer borda", () => {
    const p = edgeProximity(MEIO, LO, HI)!;
    expect(p.fraction).toBeCloseTo(0.5, 10);
  });

  it("identifica a borda mais próxima", () => {
    expect(edgeProximity(LO + 10, LO, HI)!.side).toBe("lower");
    expect(edgeProximity(HI - 10, LO, HI)!.side).toBe("upper");
  });

  it("encostado na borda dá fração zero", () => {
    expect(edgeProximity(LO, LO, HI)!.fraction).toBeCloseTo(0, 10);
    expect(edgeProximity(HI, LO, HI)!.fraction).toBeCloseTo(0, 10);
  });

  // Fora da faixa a fração fica negativa — é o que permite distinguir "perto"
  // de "já saiu" sem uma segunda função dizendo a mesma coisa de outro jeito.
  it("fora da faixa dá fração negativa", () => {
    expect(edgeProximity(LO - 100, LO, HI)!.fraction).toBeLessThan(0);
    expect(edgeProximity(HI + 100, LO, HI)!.fraction).toBeLessThan(0);
  });

  it("faixa degenerada devolve null em vez de dividir por zero", () => {
    expect(edgeProximity(100, 100, 100)).toBeNull();
    expect(edgeProximity(100, 200, 100)).toBeNull();
  });
});

describe("isNearEdge", () => {
  it("no meio da faixa não avisa", () => {
    expect(isNearEdge(MEIO, LO, HI)).toBe(false);
  });

  it("avisa dentro dos 15% de cada ponta", () => {
    const largura = HI - LO;
    expect(isNearEdge(LO + largura * 0.1, LO, HI)).toBe(true);
    expect(isNearEdge(HI - largura * 0.1, LO, HI)).toBe(true);
  });

  it("não avisa logo antes do limiar", () => {
    const largura = HI - LO;
    expect(isNearEdge(LO + largura * (NEAR_EDGE_FRACTION + 0.01), LO, HI)).toBe(false);
  });

  // Fora de faixa já tem o alerta de out_of_range. Mandar os dois é ruído
  // duplicado no mesmo evento.
  it("fora da faixa NÃO conta como perto da borda", () => {
    expect(isNearEdge(LO - 1, LO, HI)).toBe(false);
    expect(isNearEdge(HI + 1, LO, HI)).toBe(false);
  });

  // Caso real que motivou o alerta: em 05/09 a posição estava a 1,63% do teto
  // numa faixa de 6,3% — ou seja, ~26% da largura. NÃO dispara ainda, e é o
  // comportamento certo: 15% é onde vira acionável.
  it("a posição real do usuário em 05/09 ainda não dispara", () => {
    const largura = HI - LO;
    // 74% do caminho de baixo pra cima => 26% de folga até o teto
    const tick = LO + largura * 0.74;
    expect(isNearEdge(tick, LO, HI)).toBe(false);
    expect(edgeProximity(tick, LO, HI)!.side).toBe("upper");
  });

  it("faixa degenerada não avisa", () => {
    expect(isNearEdge(100, 100, 100)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { decideClose, validateBounds } from "../../../src/domain/lp-rebalance/close-trigger.js";

// Preços reais do WBTC/USDC pra ancorar: a posição do usuário tinha piso em
// $78.029 e o preço rodou entre $76.8k e $81k na primeira semana.
const PRECO = 77_000;

describe("decideClose", () => {
  it("não dispara com o preço entre os limites", () => {
    expect(decideClose({ belowPrice: 70_000, abovePrice: 90_000 }, PRECO)).toEqual({ fire: false });
  });

  it("dispara quando o preço cai até o piso", () => {
    expect(decideClose({ belowPrice: 78_000, abovePrice: null }, PRECO)).toEqual({
      fire: true,
      side: "below",
      limit: 78_000,
    });
  });

  it("dispara quando o preço sobe até o teto", () => {
    expect(decideClose({ belowPrice: null, abovePrice: 76_000 }, PRECO)).toEqual({
      fire: true,
      side: "above",
      limit: 76_000,
    });
  });

  // O limite é o ponto de saída, não um valor a ultrapassar: "feche em
  // $70.000" com o preço exatamente em $70.000 tem que fechar.
  it("dispara exatamente no limite, não só depois dele", () => {
    expect(decideClose({ belowPrice: PRECO, abovePrice: null }, PRECO).fire).toBe(true);
    expect(decideClose({ belowPrice: null, abovePrice: PRECO }, PRECO).fire).toBe(true);
  });

  it("lado não armado nunca dispara", () => {
    expect(decideClose({ belowPrice: null, abovePrice: null }, PRECO)).toEqual({ fire: false });
    expect(decideClose({ belowPrice: 1, abovePrice: null }, PRECO)).toEqual({ fire: false });
  });

  // Leitura de preço quebrada não pode virar ordem de fechar. Zero, NaN e
  // Infinity chegariam aqui se um cálculo de preço falhasse silenciosamente.
  it("preço inválido não dispara nada", () => {
    for (const p of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decideClose({ belowPrice: 90_000, abovePrice: null }, p)).toEqual({ fire: false });
    }
  });
});

describe("validateBounds", () => {
  it("aceita limites dos dois lados do preço atual", () => {
    expect(validateBounds({ belowPrice: 70_000, abovePrice: 90_000 }, PRECO)).toEqual({ ok: true });
  });

  it("aceita só um lado", () => {
    expect(validateBounds({ belowPrice: 70_000, abovePrice: null }, PRECO).ok).toBe(true);
    expect(validateBounds({ belowPrice: null, abovePrice: 90_000 }, PRECO).ok).toBe(true);
  });

  it("recusa configuração sem limite nenhum", () => {
    expect(validateBounds({ belowPrice: null, abovePrice: null }, PRECO).ok).toBe(false);
  });

  it("recusa número não positivo", () => {
    expect(validateBounds({ belowPrice: 0, abovePrice: null }, PRECO).ok).toBe(false);
    expect(validateBounds({ belowPrice: null, abovePrice: -5 }, PRECO).ok).toBe(false);
  });

  // Limites cruzados não deixam preço nenhum sobreviver — a posição fecharia
  // no ciclo seguinte, doa o que doer.
  it("recusa piso maior ou igual ao teto", () => {
    expect(validateBounds({ belowPrice: 90_000, abovePrice: 70_000 }, PRECO).ok).toBe(false);
    expect(validateBounds({ belowPrice: 80_000, abovePrice: 80_000 }, PRECO).ok).toBe(false);
  });

  // A proteção que mais importa: armar um gatilho já satisfeito fecharia a
  // posição em minutos sem o usuário entender que foi ele quem pediu.
  it("recusa limite que o preço atual já cruzou", () => {
    const abaixo = validateBounds({ belowPrice: 80_000, abovePrice: null }, PRECO);
    expect(abaixo.ok).toBe(false);
    expect(abaixo.ok === false && abaixo.reason).toContain("abaixo");

    const acima = validateBounds({ belowPrice: null, abovePrice: 76_000 }, PRECO);
    expect(acima.ok).toBe(false);
    expect(acima.ok === false && acima.reason).toContain("acima");
  });
});

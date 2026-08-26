import { describe, expect, it } from "vitest";
import { composeNav } from "../../../src/domain/portfolio/nav.js";

describe("composeNav", () => {
  it("soma tokens parados, capital em pool e fees não coletadas", () => {
    const nav = composeNav({
      idle: [
        { symbol: "USDC", amount: 5.46, priceUsdc: 1 },
        { symbol: "ETH", amount: 0.002428, priceUsdc: 2440 },
      ],
      positionsUsdc: 46.24,
      feesUsdc: 0.48,
    });

    expect(nav.idleUsdc).toBeCloseTo(11.384, 2);
    expect(nav.navUsdc).toBeCloseTo(58.104, 2);
  });

  // O número que o /positions não mostra: quanto do capital está fora de pool,
  // sem render. Fees contam como "rendendo" — já foram geradas, só não sacadas.
  it("calcula a fração parada do patrimônio", () => {
    const nav = composeNav({
      idle: [{ symbol: "USDC", amount: 25, priceUsdc: 1 }],
      positionsUsdc: 74,
      feesUsdc: 1,
    });
    expect(nav.idleFraction).toBeCloseTo(0.25, 10);
  });

  it("carteira sem nada não quebra nem devolve NaN", () => {
    const nav = composeNav({ idle: [], positionsUsdc: 0, feesUsdc: 0 });
    expect(nav.navUsdc).toBe(0);
    expect(nav.idleFraction).toBe(0);
  });

  it("carteira só com capital em pool tem fração parada zero", () => {
    const nav = composeNav({ idle: [], positionsUsdc: 100, feesUsdc: 0 });
    expect(nav.idleFraction).toBe(0);
    expect(nav.navUsdc).toBe(100);
  });
});

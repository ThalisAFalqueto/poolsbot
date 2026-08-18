import { describe, expect, it } from "vitest";
import { parseFeeTierLabel } from "../../../src/data/defillama/client.js";

describe("parseFeeTierLabel", () => {
  it("reconhece os 4 fee tiers padrão do Uniswap V3", () => {
    expect(parseFeeTierLabel("0.01%")).toBe(100);
    expect(parseFeeTierLabel("0.05%")).toBe(500);
    expect(parseFeeTierLabel("0.3%")).toBe(3000);
    expect(parseFeeTierLabel("1%")).toBe(10000);
  });

  it("retorna null pra rótulo desconhecido", () => {
    expect(parseFeeTierLabel("0.5%")).toBeNull();
  });

  it("retorna null pra poolMeta ausente", () => {
    expect(parseFeeTierLabel(null)).toBeNull();
  });

  it("tolera espaço em volta do rótulo", () => {
    expect(parseFeeTierLabel(" 0.05% ")).toBe(500);
  });
});

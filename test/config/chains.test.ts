import { describe, expect, it } from "vitest";
import { chainKeyFromDefillamaName } from "../../src/config/chains.js";

describe("chainKeyFromDefillamaName", () => {
  it("resolve o nome usado pela DefiLlama pra nossa chave interna", () => {
    expect(chainKeyFromDefillamaName("Arbitrum")).toBe("arbitrum");
    expect(chainKeyFromDefillamaName("Base")).toBe("base");
    expect(chainKeyFromDefillamaName("Optimism")).toBe("optimism");
    expect(chainKeyFromDefillamaName("Polygon")).toBe("polygon");
  });

  it("é case-insensitive", () => {
    expect(chainKeyFromDefillamaName("arbitrum")).toBe("arbitrum");
    expect(chainKeyFromDefillamaName("BASE")).toBe("base");
    expect(chainKeyFromDefillamaName("optimism")).toBe("optimism");
    expect(chainKeyFromDefillamaName("POLYGON")).toBe("polygon");
  });

  it("retorna undefined pra chain não suportada", () => {
    expect(chainKeyFromDefillamaName("Ethereum")).toBeUndefined();
  });
});

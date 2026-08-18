import { describe, expect, it } from "vitest";
import { chainKeyFromDefillamaName } from "../../src/config/chains.js";

describe("chainKeyFromDefillamaName", () => {
  it("resolve o nome usado pela DefiLlama pra nossa chave interna", () => {
    expect(chainKeyFromDefillamaName("Arbitrum")).toBe("arbitrum");
    expect(chainKeyFromDefillamaName("Base")).toBe("base");
  });

  it("é case-insensitive", () => {
    expect(chainKeyFromDefillamaName("arbitrum")).toBe("arbitrum");
    expect(chainKeyFromDefillamaName("BASE")).toBe("base");
  });

  it("retorna undefined pra chain não suportada", () => {
    expect(chainKeyFromDefillamaName("Ethereum")).toBeUndefined();
  });
});

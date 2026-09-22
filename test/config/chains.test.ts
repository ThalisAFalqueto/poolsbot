import { describe, expect, it } from "vitest";
import { chains, chainKeyFromDefillamaName } from "../../src/config/chains.js";

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

  it("resolve a Robinhood Chain e mede patrimônio em USDG", () => {
    expect(chainKeyFromDefillamaName("Robinhood Chain")).toBe("robinhood");
    expect(chains.robinhood.viemChain.id).toBe(4663);
    expect(chains.robinhood.nativeGasSymbol).toBe("ETH");
    // Essa chain não tem USDC; a moeda de conta é a USDG (6 casas).
    expect(chains.robinhood.quoteStableAddress?.toLowerCase()).toBe("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  });

  // A factory canônica do V3 NÃO existe nessa chain (getPool revertia) — os
  // endereços foram achados varrendo PoolCreated e os Mint do pool. Se alguém
  // "padronizar" isso, o bot deixa de achar as posições lá.
  it("Robinhood Chain usa endereços próprios do Uniswap V3", () => {
    expect(chains.robinhood.uniswapV3.factory).not.toBe(chains.arbitrum.uniswapV3.factory);
    expect(chains.robinhood.uniswapV3.nonfungiblePositionManager).not.toBe(chains.arbitrum.uniswapV3.nonfungiblePositionManager);
  });
});

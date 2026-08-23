import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { convertNativeGasToToken1 } from "../../../src/domain/lp-rebalance/gas-cost-token1.js";

const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC = "0x0000000000000000000000000000000000000009";
const LINK = "0x0000000000000000000000000000000000000010";

const GAS_NATIVE = 0.00042; // ETH

describe("convertNativeGasToToken1", () => {
  it("token1 é WETH -> conversão 1:1", () => {
    const result = convertNativeGasToToken1(GAS_NATIVE, WETH, USDC, WETH, 2000);
    expect(result).toBe(GAS_NATIVE);
  });

  it("token0 é WETH -> multiplica pelo preço atual (token1 por token0)", () => {
    const currentPrice = 2000; // 2000 USDC por WETH
    const result = convertNativeGasToToken1(GAS_NATIVE, WETH, WETH, USDC, currentPrice);
    expect(result).toBeCloseTo(GAS_NATIVE * currentPrice, 10);
  });

  it("nenhum dos dois tokens é WETH -> null", () => {
    const result = convertNativeGasToToken1(GAS_NATIVE, WETH, USDC, LINK, 15);
    expect(result).toBeNull();
  });

  it("comparação de endereço é case-insensitive", () => {
    const result = convertNativeGasToToken1(GAS_NATIVE, WETH.toUpperCase() as Address, WETH.toLowerCase(), USDC, 2000);
    expect(result).not.toBeNull();
  });
});

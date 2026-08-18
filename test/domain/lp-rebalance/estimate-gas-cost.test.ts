import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { estimateRebalanceCost } from "../../../src/domain/lp-rebalance/estimate-gas-cost.js";
import type { OnchainPosition } from "../../../src/domain/lp-rebalance/types.js";

const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC = "0x0000000000000000000000000000000000000009";
const LINK = "0x0000000000000000000000000000000000000010";

function makePosition(overrides: Partial<OnchainPosition> = {}): OnchainPosition {
  return {
    chain: "arbitrum",
    walletAddress: "0x0000000000000000000000000000000000000001",
    tokenId: 1n,
    poolAddress: "0x0000000000000000000000000000000000000002",
    fee: 3000,
    tickLower: -1000,
    tickUpper: 1000,
    currentTick: 0,
    sqrtPriceX96: 2n ** 96n,
    liquidity: 1_000_000_000n,
    token0: { address: WETH, decimals: 18, symbol: "WETH" },
    token1: { address: USDC, decimals: 6, symbol: "USDC" },
    ...overrides,
  };
}

const GAS_PRICE = 100_000_000n; // 0.1 gwei

describe("estimateRebalanceCost", () => {
  it("token1 é WETH -> conversão 1:1 (costToken1 === costEth)", () => {
    const position = makePosition({
      token0: { address: USDC, decimals: 6, symbol: "USDC" },
      token1: { address: WETH, decimals: 18, symbol: "WETH" },
    });
    const result = estimateRebalanceCost(GAS_PRICE, position, WETH, 2000);

    expect(result.costEth).toBeGreaterThan(0);
    expect(result.costToken1).toBe(result.costEth);
  });

  it("token0 é WETH -> multiplica pelo preço atual (token1 por token0)", () => {
    const position = makePosition({
      token0: { address: WETH, decimals: 18, symbol: "WETH" },
      token1: { address: USDC, decimals: 6, symbol: "USDC" },
    });
    const currentPrice = 2000; // 2000 USDC por WETH
    const result = estimateRebalanceCost(GAS_PRICE, position, WETH, currentPrice);

    expect(result.costToken1).toBeCloseTo(result.costEth * currentPrice, 10);
  });

  it("nenhum dos dois tokens é WETH -> costToken1 null, costEth continua calculado", () => {
    const position = makePosition({
      token0: { address: USDC, decimals: 6, symbol: "USDC" },
      token1: { address: LINK, decimals: 18, symbol: "LINK" },
    });
    const result = estimateRebalanceCost(GAS_PRICE, position, WETH, 15);

    expect(result.costToken1).toBeNull();
    expect(result.costEth).toBeGreaterThan(0);
  });

  it("comparação de endereço é case-insensitive", () => {
    const position = makePosition({
      token0: { address: WETH.toLowerCase(), decimals: 18, symbol: "WETH" },
      token1: { address: USDC, decimals: 6, symbol: "USDC" },
    });
    const result = estimateRebalanceCost(GAS_PRICE, position, WETH.toUpperCase() as Address, 2000);

    expect(result.costToken1).not.toBeNull();
  });
});

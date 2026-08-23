import { describe, expect, it } from "vitest";
import { calculateFeesOwedFromGrowth, decodePositionInfo } from "../../../src/domain/lp-rebalance/position-info-v4.js";

describe("decodePositionInfo", () => {
  it("decodifica tickLower/tickUpper de um valor real (posição WBTC/USDC real, tokenId 198755, Arbitrum, 23/08/2026)", () => {
    // Lido ao vivo via PositionManager.getPoolAndPositionInfo antes de
    // escrever esse código — tickLower/tickUpper esperados conferidos
    // contra a faixa real da posição (74970-79526 USD, "faixa 75000-79000"
    // que o usuário mencionou).
    const packed = 58248018305078878027476358357310527316555226332786738539351216877149536557056n;
    const result = decodePositionInfo(packed);
    expect(result.tickLower).toBe(66200);
    expect(result.tickUpper).toBe(66790);
  });

  it("decodifica ticks negativos corretamente (sign extension)", () => {
    // tickLower = -100, tickUpper = 100, hasSubscriber = 0
    const tickLowerBits = (BigInt.asUintN(24, -100n) << 8n);
    const tickUpperBits = (BigInt.asUintN(24, 100n) << 32n);
    const packed = tickLowerBits | tickUpperBits;
    const result = decodePositionInfo(packed);
    expect(result.tickLower).toBe(-100);
    expect(result.tickUpper).toBe(100);
  });

  it("decodifica ticks zero", () => {
    const result = decodePositionInfo(0n);
    expect(result.tickLower).toBe(0);
    expect(result.tickUpper).toBe(0);
  });
});

describe("calculateFeesOwedFromGrowth", () => {
  it("calcula fees a partir de valores reais (mesma posição real acima)", () => {
    const liquidity = 56666324n;
    const feeGrowthInside0Last = 187533116423946905087530644914454395n;
    const feeGrowthInside1Last = 177165601380851759067087916660821611666n;
    const feeGrowthInside0 = 187567709256973583402808116035076431n;
    const feeGrowthInside1 = 177197731352477326828422550297203322669n;

    const fees0 = calculateFeesOwedFromGrowth(feeGrowthInside0Last, feeGrowthInside0, liquidity);
    const fees1 = calculateFeesOwedFromGrowth(feeGrowthInside1Last, feeGrowthInside1, liquidity);

    // valores pequenos e positivos — posição recém-aberta, pouco tempo de fee acumulado
    expect(fees0).toBeGreaterThan(0n);
    expect(fees1).toBeGreaterThan(0n);
    expect(Number(fees1) / 1e6).toBeCloseTo(0.00535, 5);
  });

  it("retorna 0 quando não houve crescimento de fee desde o último snapshot", () => {
    const result = calculateFeesOwedFromGrowth(1000n, 1000n, 500000n);
    expect(result).toBe(0n);
  });

  it("escala com a liquidez", () => {
    const growthDelta = 2n ** 100n; // delta arbitrário de feeGrowthInsideX128
    const small = calculateFeesOwedFromGrowth(0n, growthDelta, 1000n);
    const large = calculateFeesOwedFromGrowth(0n, growthDelta, 2000n);
    expect(large).toBe(small * 2n);
  });
});

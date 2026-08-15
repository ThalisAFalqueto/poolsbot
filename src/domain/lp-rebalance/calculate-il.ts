import { getAmountsForLiquidity } from "./liquidity-math.js";
import { sqrtPriceX96ToPrice } from "./price-math.js";

export type CalculateImpermanentLossInput = {
  liquidity: bigint; // mesma liquidez em baseline E atual — quem chama garante
                      // essa invariante (ver il-baseline.ts/decideBaseline);
                      // se a liquidez mudou, o baseline já deveria ter sido
                      // resetado antes desta chamada.
  tickLower: number;
  tickUpper: number;
  decimals0: number;
  decimals1: number;
  baselineSqrtPriceX96: bigint;
  baselineRecordedAt: Date;
  currentSqrtPriceX96: bigint;
};

export type ImpermanentLossResult = {
  ilPct: number; // <= 0 (ou ~0); ex. -0.0234 = -2.34%
  hodlValueToken1: number;
  positionValueToken1: number;
  baselineAmount0: number;
  baselineAmount1: number;
  currentAmount0: number;
  currentAmount1: number;
  since: Date;
};

export function calculateImpermanentLoss(input: CalculateImpermanentLossInput): ImpermanentLossResult {
  const { liquidity, tickLower, tickUpper, decimals0, decimals1 } = input;

  const baselineAmounts = getAmountsForLiquidity({
    liquidity,
    sqrtPriceX96: input.baselineSqrtPriceX96,
    tickLower,
    tickUpper,
    decimals0,
    decimals1,
  });
  const currentAmounts = getAmountsForLiquidity({
    liquidity,
    sqrtPriceX96: input.currentSqrtPriceX96,
    tickLower,
    tickUpper,
    decimals0,
    decimals1,
  });

  // CRÍTICO: as duas cestas (HODL e posição) são valoradas no preço ATUAL,
  // nunca no preço do baseline — senão o IL zeraria artificialmente sempre
  // (essa é a armadilha clássica de implementar isso errado).
  const currentPrice = sqrtPriceX96ToPrice(input.currentSqrtPriceX96, decimals0, decimals1);

  const hodlValueToken1 = baselineAmounts.amount0 * currentPrice + baselineAmounts.amount1;
  const positionValueToken1 = currentAmounts.amount0 * currentPrice + currentAmounts.amount1;

  const ilPct = hodlValueToken1 > 0 ? positionValueToken1 / hodlValueToken1 - 1 : 0;

  return {
    ilPct,
    hodlValueToken1,
    positionValueToken1,
    baselineAmount0: baselineAmounts.amount0,
    baselineAmount1: baselineAmounts.amount1,
    currentAmount0: currentAmounts.amount0,
    currentAmount1: currentAmounts.amount1,
    since: input.baselineRecordedAt,
  };
}

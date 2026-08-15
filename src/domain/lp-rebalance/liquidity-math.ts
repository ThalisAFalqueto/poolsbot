import { rawSqrtRatio, sqrtRatioAtTick } from "./price-math.js";

export type Amounts = { amount0: number; amount1: number }; // unidades humanas (já /10^decimals)

export type GetAmountsForLiquidityInput = {
  liquidity: bigint;
  sqrtPriceX96: bigint; // preço de referência a usar (baseline OU atual — chamador decide)
  tickLower: number;
  tickUpper: number;
  decimals0: number;
  decimals1: number;
};

// Portada de LiquidityAmounts.sol (getAmount0Delta/getAmount1Delta) do
// Uniswap V3 pra ponto flutuante — mesmo espírito pragmático de price-math.ts
// (não é bit-exact Q64.96, é pra exibição/análise, não execução on-chain).
export function getAmountsForLiquidity(input: GetAmountsForLiquidityInput): Amounts {
  const { liquidity, sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1 } = input;
  const sLower = sqrtRatioAtTick(tickLower);
  const sUpper = sqrtRatioAtTick(tickUpper);
  const s = rawSqrtRatio(sqrtPriceX96);
  const L = Number(liquidity);

  let amount0Raw: number;
  let amount1Raw: number;

  if (s <= sLower) {
    // preço abaixo do range: posição inteira em token0
    amount0Raw = (L * (sUpper - sLower)) / (sLower * sUpper);
    amount1Raw = 0;
  } else if (s >= sUpper) {
    // preço acima do range: posição inteira em token1
    amount0Raw = 0;
    amount1Raw = L * (sUpper - sLower);
  } else {
    // preço dentro do range: mix dos dois
    amount0Raw = (L * (sUpper - s)) / (s * sUpper);
    amount1Raw = L * (s - sLower);
  }

  return { amount0: amount0Raw / 10 ** decimals0, amount1: amount1Raw / 10 ** decimals1 };
}

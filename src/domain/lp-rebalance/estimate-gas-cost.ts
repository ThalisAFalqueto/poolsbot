import type { Address } from "viem";
import type { OnchainPosition } from "./types.js";

// decreaseLiquidity + collect + mint — estimativa aproximada (não simulada
// via eth_estimateGas, pra não gastar mais uma chamada de RPC por posição
// fora de range). Mesma filosofia pragmática de price-math.ts: não é
// bit-exato, é suficiente pra decisão/exibição.
const REBALANCE_GAS_UNITS = 500_000n;

export type GasCostEstimate = {
  costEth: number; // custo no token de gas NATIVO da chain — "ETH" no nome, mas mal rotulado pra chains que não pagam gas em ETH (ex: Polygon paga em POL)
  costToken1: number | null; // null quando o par não envolve WETH — sem oráculo de preço, não dá pra converter
};

export function estimateRebalanceCost(
  gasPriceWei: bigint,
  position: OnchainPosition,
  wethAddress: Address,
  currentPriceToken1PerToken0: number
): GasCostEstimate {
  const costEth = Number(gasPriceWei * REBALANCE_GAS_UNITS) / 1e18;

  const weth = wethAddress.toLowerCase();
  if (position.token1.address.toLowerCase() === weth) {
    return { costEth, costToken1: costEth }; // token1 já é WETH, conversão 1:1
  }
  if (position.token0.address.toLowerCase() === weth) {
    return { costEth, costToken1: costEth * currentPriceToken1PerToken0 };
  }
  return { costEth, costToken1: null };
}

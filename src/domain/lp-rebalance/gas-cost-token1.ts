import type { Address } from "viem";

// Mesmo padrão de conversão de estimate-gas-cost.ts (custo em ETH -> token1
// só quando um dos dois lados do par É WETH), mas separado num arquivo
// próprio de propósito: aquele é uma estimativa PRA FRENTE (calibra faixa
// sugerida), este converte um custo de gas REAL já pago. Sem oráculo de
// preço USD geral — mesma postura já estabelecida no projeto.
export function convertNativeGasToToken1(
  gasNative: number,
  wethAddress: Address,
  token0Address: Address,
  token1Address: Address,
  currentPriceToken1PerToken0: number
): number | null {
  const weth = wethAddress.toLowerCase();
  if (token1Address.toLowerCase() === weth) {
    return gasNative; // token1 já é WETH, conversão 1:1
  }
  if (token0Address.toLowerCase() === weth) {
    return gasNative * currentPriceToken1PerToken0;
  }
  return null;
}

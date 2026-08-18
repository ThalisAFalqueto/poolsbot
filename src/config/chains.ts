import type { Chain } from "viem";
import { arbitrum, base } from "viem/chains";
import { env } from "./env.js";

// Endereços do Uniswap V3 são determinísticos (CREATE2) e idênticos em
// Ethereum mainnet, Arbitrum, Optimism e Polygon — MAS NÃO na Base, que usa
// um deploy com endereços próprios (confirmado via docs oficiais da Uniswap).
// Por isso cada chain do registry abaixo declara seus próprios endereços em
// vez de todas apontarem pra uma constante global — nunca assumir
// portabilidade de endereço entre chains sem checar.
const ARBITRUM_UNISWAP_V3 = {
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  nonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
} as const;

const BASE_UNISWAP_V3 = {
  factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  nonfungiblePositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
} as const;

// viemChain tipado como Chain (não o literal específico de cada objeto de
// viem/chains) — evita que o registry fique com N tipos de PublicClient
// mutuamente incompatíveis (um por chain), o que quebraria getPublicClient
// tentando guardar clients de chains diferentes num Map de tipo único.
export const chains = {
  arbitrum: {
    viemChain: arbitrum as Chain,
    defillamaChainName: "Arbitrum",
    uniswapV3: ARBITRUM_UNISWAP_V3,
    // WETH nativo/canônico da chain — usado só pra converter custo de gas
    // (sempre pago em ETH) pra token1 quando o par envolve WETH, sem
    // precisar de oráculo de preço externo (ver estimate-gas-cost.ts).
    wethAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    rpcUrl: env.arbitrumRpcUrl as string | undefined,
  },
  base: {
    viemChain: base as Chain,
    defillamaChainName: "Base",
    uniswapV3: BASE_UNISWAP_V3,
    wethAddress: "0x4200000000000000000000000000000000000006", // confirmado via teste on-chain real desta sessão
    rpcUrl: env.baseRpcUrl,
  },
} as const;

export type ChainKey = keyof typeof chains;

// Só chains com RPC configurado entram no fan-out de leitura on-chain —
// permite ativar uma chain nova (ex. Base) só adicionando a env var, sem
// quebrar o bot enquanto ela não estiver configurada.
export function getActiveChains(): ChainKey[] {
  return (Object.keys(chains) as ChainKey[]).filter((key) => chains[key].rpcUrl !== undefined);
}

// Resolve o nome de chain usado pela DefiLlama (ex: "Arbitrum") de volta
// pra nossa chave interna — usado quando o ponto de partida é um pool da
// DefiLlama (que não conhece nosso ChainKey) e precisamos decidir se dá
// pra ler on-chain nele.
export function chainKeyFromDefillamaName(name: string): ChainKey | undefined {
  return (Object.keys(chains) as ChainKey[]).find((key) => chains[key].defillamaChainName.toLowerCase() === name.toLowerCase());
}

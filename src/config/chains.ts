import { arbitrum } from "viem/chains";

// Endereços do Uniswap V3 são determinísticos (CREATE2) e idênticos em
// Ethereum mainnet, Arbitrum, Optimism e Polygon.
export const UNISWAP_V3 = {
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  nonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
} as const;

export const chains = {
  arbitrum: {
    viemChain: arbitrum,
    defillamaChainName: "Arbitrum",
    uniswapV3: UNISWAP_V3,
  },
} as const;

export type ChainKey = keyof typeof chains;

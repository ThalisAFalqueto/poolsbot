import type { Chain } from "viem";
import { arbitrum, base, optimism, polygon } from "viem/chains";
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

// Idênticos aos da Arbitrum (mesmo deploy determinístico) — confirmado via
// docs oficiais da Uniswap (developers.uniswap.org/contracts/v3/reference/
// deployments/{optimism,polygon}-deployments) e cruzado com Etherscan/
// PolygonScan antes de usar.
const OPTIMISM_UNISWAP_V3 = {
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  nonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
} as const;

const POLYGON_UNISWAP_V3 = {
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  nonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
} as const;

// Uniswap V4 usa um contrato SINGLETON (PoolManager guarda todos os pools,
// não 1 contrato por pool como o V3) — arquitetura completamente diferente,
// ver src/data/onchain/client-v4.ts. Só a Arbitrum tem endereço configurado
// por enquanto (confirmado AO VIVO contra a RPC real em 23/08/2026: os 3
// contratos abaixo concordam entre si via `.poolManager()`, não é só doc).
// undefined nas outras chains até confirmar os endereços lá — mesma
// disciplina do resto desse arquivo, nunca assumir portabilidade sem checar.
const ARBITRUM_UNISWAP_V4 = {
  poolManager: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32",
  positionManager: "0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869",
  stateView: "0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990",
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
    // pra token1 quando o par envolve WETH, sem precisar de oráculo de
    // preço externo (ver estimate-gas-cost.ts). Assume que o gas da chain é
    // pago em ETH — vale pra Arbitrum/Base/Optimism, NÃO pra Polygon (ver
    // ressalva na entrada dela abaixo).
    wethAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    rpcUrl: env.arbitrumRpcUrl as string | undefined,
    nativeGasSymbol: "ETH",
    uniswapV4: ARBITRUM_UNISWAP_V4 as typeof ARBITRUM_UNISWAP_V4 | undefined,
  },
  base: {
    viemChain: base as Chain,
    defillamaChainName: "Base",
    uniswapV3: BASE_UNISWAP_V3,
    wethAddress: "0x4200000000000000000000000000000000000006", // confirmado via teste on-chain real desta sessão
    rpcUrl: env.baseRpcUrl,
    nativeGasSymbol: "ETH",
    uniswapV4: undefined as typeof ARBITRUM_UNISWAP_V4 | undefined,
  },
  optimism: {
    viemChain: optimism as Chain,
    defillamaChainName: "Optimism",
    uniswapV3: OPTIMISM_UNISWAP_V3,
    // Predeploy padrão OP Stack — mesmo endereço da Base (ambas L2s OP
    // Stack), gas pago em ETH nativo, assunção de estimate-gas-cost.ts
    // continua válida aqui.
    wethAddress: "0x4200000000000000000000000000000000000006",
    rpcUrl: env.optimismRpcUrl,
    nativeGasSymbol: "ETH",
    uniswapV4: undefined as typeof ARBITRUM_UNISWAP_V4 | undefined,
  },
  polygon: {
    viemChain: polygon as Chain,
    defillamaChainName: "Polygon",
    uniswapV3: POLYGON_UNISWAP_V3,
    // ATENÇÃO: gas na Polygon é pago em POL (token nativo), não em ETH — a
    // assunção "gas sempre em ETH" de estimate-gas-cost.ts NÃO vale aqui.
    // Este endereço é o WETH bridged (token ERC-20 comum em pares como
    // WETH/USDC), não o token de gas. Resultado prático: costToken1 só é
    // preenchido pra posições Polygon que envolvem esse WETH bridged
    // especificamente — a maioria das posições Polygon (que não usam WETH
    // como par) vai ver a linha de custo de gas omitida, igual a qualquer
    // par sem WETH nas outras chains hoje. Limitação aceita, não é bug —
    // corrigir de verdade exigiria buscar o preço de POL em algum lugar
    // (oráculo externo), fora de escopo até alguém pedir.
    wethAddress: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    rpcUrl: env.polygonRpcUrl,
    nativeGasSymbol: "POL",
    uniswapV4: undefined as typeof ARBITRUM_UNISWAP_V4 | undefined,
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

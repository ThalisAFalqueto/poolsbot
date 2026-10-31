import { defineChain, type Chain } from "viem";
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

// Robinhood Chain (L2 Arbitrum Orbit, chain id 4663, gas em ETH). NÃO está em
// viem/chains, então é definida aqui; RPC e id conferidos na doc oficial
// (docs.robinhood.com/chain/connecting) em 22/09/2026.
//
// Os endereços do Uniswap V3 aqui NÃO são os canônicos: a factory canônica
// simplesmente não existe nessa chain (getPool revertia). Foram achados
// ON-CHAIN, não em doc: varrendo PoolCreated(WETH, USDG) apareceu a factory
// abaixo, e os eventos Mint do pool ETH/USDG mostram que o dono das 2.708
// posições é o PositionManager abaixo — cujo NFT tem símbolo UNI-V3-POS e
// cujo .factory() aponta de volta pra mesma factory. Ou seja: deploy V3
// padrão, só com endereços próprios.
const ROBINHOOD_UNISWAP_V3 = {
  factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  nonfungiblePositionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
} as const;

const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  // Sem isto, todo multicall do bot falha ("chain does not support contract
  // multicall3") e as posições nunca são lidas — viem só agrega quando a chain
  // declara o endereço. Confirmado ON-CHAIN em 22/09/2026: o Multicall3
  // canônico está deployado aqui (3.808 bytes) e responde.
  //
  // Ele devolve getBlockNumber() = 26.033.393 com a chain em 69.698.378, e
  // isso está CERTO: em chain Arbitrum Orbit, block.number dentro da EVM é o
  // bloco da L1 Ethereum, não o da L2. Não confundir com contrato errado.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

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
    // Moeda de conta do NAV (ver domain/portfolio/) — o patrimônio da carteira
    // é medido NESTE token, não em "dólar": a conversão sai de pool Uniswap
    // on-chain, nunca de oráculo externo de USD. USDC NATIVO da Arbitrum
    // (não o USDC.e bridged, que é outro contrato). Confirmado on-chain antes
    // de escrever aqui — name "USD Coin", symbol "USDC", 6 decimais —, não
    // digitado de memória (ver feedback_never_type_addresses_from_memory).
    quoteStableAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as `0x${string}` | undefined,
    // Tokens aceitos no patrimônio/fluxo de caixa mesmo que NUNCA tenham
    // aparecido numa posição — tipicamente a moeda com que o usuário aporta.
    // Achado testando com dado real: o primeiro aporte dele foi em USD₮0 e
    // foi DESCARTADO em silêncio, porque a allowlist só conhecia tokens de
    // posições; sem esta lista, um aporte assim vira "lucro" no /mes.
    // Manter CURTA e por ENDEREÇO (nunca por símbolo): um token de scam pode
    // se chamar "USDT", mas não pode forjar o endereço do contrato real.
    // Confirmado on-chain: name/symbol "USD₮0", 6 decimais.
    trustedTokens: ["0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"] as readonly `0x${string}`[],
    rpcUrl: env.arbitrumRpcUrl as string | undefined,
    nativeGasSymbol: "ETH",
    uniswapV4: ARBITRUM_UNISWAP_V4 as typeof ARBITRUM_UNISWAP_V4 | undefined,
  },
  base: {
    viemChain: base as Chain,
    defillamaChainName: "Base",
    uniswapV3: BASE_UNISWAP_V3,
    wethAddress: "0x4200000000000000000000000000000000000006", // confirmado via teste on-chain real desta sessão
    // Sem NAV nesta chain até o endereço do USDC ser confirmado ON-CHAIN aqui
    // (mesma disciplina de uniswapV4 abaixo: nunca assumir portabilidade de
    // endereço entre chains). O snapshot de patrimônio simplesmente pula
    // chains sem esse campo.
    quoteStableAddress: undefined as `0x${string}` | undefined,
    trustedTokens: [] as readonly `0x${string}`[],
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
    // Sem NAV nesta chain até o endereço do USDC ser confirmado ON-CHAIN aqui
    // (mesma disciplina de uniswapV4 abaixo: nunca assumir portabilidade de
    // endereço entre chains). O snapshot de patrimônio simplesmente pula
    // chains sem esse campo.
    quoteStableAddress: undefined as `0x${string}` | undefined,
    trustedTokens: [] as readonly `0x${string}`[],
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
    // Sem NAV nesta chain até o endereço do USDC ser confirmado ON-CHAIN aqui
    // (mesma disciplina de uniswapV4 abaixo: nunca assumir portabilidade de
    // endereço entre chains). O snapshot de patrimônio simplesmente pula
    // chains sem esse campo.
    quoteStableAddress: undefined as `0x${string}` | undefined,
    trustedTokens: [] as readonly `0x${string}`[],
    rpcUrl: env.polygonRpcUrl,
    nativeGasSymbol: "POL",
    uniswapV4: undefined as typeof ARBITRUM_UNISWAP_V4 | undefined,
  },
  robinhood: {
    viemChain: robinhoodChain,
    defillamaChainName: "Robinhood Chain",
    uniswapV3: ROBINHOOD_UNISWAP_V3,
    // WETH da chain — confirmado on-chain (symbol "WETH", 18 casas); é o
    // token0 do pool ETH/USDG.
    wethAddress: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    // AQUI A MOEDA DE CONTA NÃO É USDC: essa chain não tem USDC. Varri os 34
    // tokens das pools listadas (22/09/2026) e os únicos dólares são USDG,
    // USDe, syrupUSDG e spUSDG. O patrimônio nesta chain é medido em USDG
    // (Paxos, lastro 1:1 com atestado mensal). Confirmado on-chain: symbol
    // "USDG", 6 casas.
    quoteStableAddress: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as `0x${string}` | undefined,
    trustedTokens: [] as readonly `0x${string}`[],
    rpcUrl: env.robinhoodRpcUrl,
    nativeGasSymbol: "ETH",
    // Sem V4 confirmado nessa chain — mesma disciplina das outras.
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

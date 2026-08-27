import { createPublicClient, http, zeroAddress, type Address, type PublicClient } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import { erc20Abi, nonfungiblePositionManagerAbi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from "./abis.js";
import { tickSpacingForFee } from "../../domain/lp-rebalance/price-math.js";
import type { OnchainPosition } from "../../domain/lp-rebalance/types.js";

// Um client por chain, criado sob demanda e reaproveitado — evita recriar a
// conexão HTTP a cada chamada.
const clientCache = new Map<ChainKey, PublicClient>();

export function getPublicClient(chainKey: ChainKey): PublicClient {
  let client = clientCache.get(chainKey);
  if (!client) {
    const def = chains[chainKey];
    if (!def.rpcUrl) throw new Error(`Chain "${chainKey}" sem RPC configurado`);
    client = createPublicClient({ chain: def.viemChain, transport: http(def.rpcUrl) });
    clientCache.set(chainKey, client);
  }
  return client;
}

export async function getGasPrice(chainKey: ChainKey): Promise<bigint> {
  return getPublicClient(chainKey).getGasPrice();
}

// client.multicall usa o contrato multicall3, já pré-configurado em
// viem/chains pras chains suportadas — nenhuma config extra necessária.
export async function fetchPositionsForWallet(chainKey: ChainKey, owner: Address): Promise<OnchainPosition[]> {
  const publicClient = getPublicClient(chainKey);
  const npm = {
    address: chains[chainKey].uniswapV3.nonfungiblePositionManager,
    abi: nonfungiblePositionManagerAbi,
  } as const;

  const balance = await publicClient.readContract({ ...npm, functionName: "balanceOf", args: [owner] });
  if (balance === 0n) return [];

  const indexResults = await publicClient.multicall({
    contracts: Array.from(
      { length: Number(balance) },
      (_, i) => ({ ...npm, functionName: "tokenOfOwnerByIndex", args: [owner, BigInt(i)] }) as const
    ),
    allowFailure: true,
  });
  const tokenIds = indexResults
    .filter((r): r is Extract<typeof r, { status: "success" }> => r.status === "success")
    .map((r) => r.result);
  if (tokenIds.length === 0) return [];

  const positionResults = await publicClient.multicall({
    contracts: tokenIds.map((tokenId) => ({ ...npm, functionName: "positions", args: [tokenId] }) as const),
    allowFailure: true,
  });

  // liquidity === 0n => posição fechada/vazia (ainda existe como NFT, mas
  // não representa capital em risco de sair de range). liquidity é o
  // índice 7 da tupla retornada por positions().
  const active = tokenIds
    .map((tokenId, i) => ({ tokenId, result: positionResults[i] }))
    .filter(
      (
        p
      ): p is { tokenId: bigint; result: Extract<(typeof positionResults)[number], { status: "success" }> } =>
        p.result?.status === "success" && p.result.result[7] > 0n
    )
    .map(({ tokenId, result }) => {
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = result.result;
      return { tokenId, token0, token1, fee, tickLower, tickUpper, liquidity };
    });

  if (active.length === 0) return [];

  // Dedup de (token0,token1,fee) para getPool, e de tokens para decimals/symbol.
  // Nenhum dos dois depende do outro — vão em multicalls paralelos.
  const poolKeys = [...new Map(active.map((p) => [`${p.token0}-${p.token1}-${p.fee}`, p])).values()];
  const tokenAddrs = [...new Set(active.flatMap((p) => [p.token0, p.token1]))] as Address[];

  const factory = { address: chains[chainKey].uniswapV3.factory, abi: uniswapV3FactoryAbi } as const;
  const [poolResults, tokenResults] = await Promise.all([
    publicClient.multicall({
      contracts: poolKeys.map(
        (p) => ({ ...factory, functionName: "getPool", args: [p.token0, p.token1, p.fee] }) as const
      ),
      allowFailure: true,
    }),
    publicClient.multicall({
      contracts: tokenAddrs.flatMap((addr) => [
        { address: addr, abi: erc20Abi, functionName: "decimals" } as const,
        { address: addr, abi: erc20Abi, functionName: "symbol" } as const,
      ]),
      allowFailure: true,
    }),
  ]);

  const poolAddrByKey = new Map<string, Address | null>(
    poolKeys.map((p, i) => {
      const key = `${p.token0}-${p.token1}-${p.fee}`;
      const r = poolResults[i];
      return [key, r?.status === "success" ? r.result : null];
    })
  );
  const tokenMeta = new Map(
    tokenAddrs.map((addr, i) => {
      const decimalsResult = tokenResults[i * 2];
      const symbolResult = tokenResults[i * 2 + 1];
      // O array de contracts intercala decimals()/symbol(), então viem tipa
      // cada .result como `string | number` (união dos dois outputs
      // possíveis do erc20Abi) sem distinguir por posição — sabemos pela
      // construção do array qual índice é qual.
      const decimals = decimalsResult?.status === "success" ? (decimalsResult.result as number) : 18;
      const symbol = symbolResult?.status === "success" ? (symbolResult.result as string) : "???";
      return [addr, { decimals, symbol }];
    })
  );

  const uniquePools = [...new Set([...poolAddrByKey.values()].filter((a): a is Address => a !== null))];
  const slot0Results = await publicClient.multicall({
    contracts: uniquePools.map((address) => ({ address, abi: uniswapV3PoolAbi, functionName: "slot0" }) as const),
    allowFailure: true,
  });
  const slot0ByPool = new Map(
    uniquePools.map((addr, i) => {
      const r = slot0Results[i];
      return [addr, r?.status === "success" ? r.result : null];
    })
  );

  return active
    .map((p): OnchainPosition | null => {
      const poolAddress = poolAddrByKey.get(`${p.token0}-${p.token1}-${p.fee}`);
      const slot0 = poolAddress ? slot0ByPool.get(poolAddress) : null;
      if (!poolAddress || !slot0) return null; // pool não encontrado ou slot0 falhou

      const [sqrtPriceX96, currentTick] = slot0;
      const t0 = tokenMeta.get(p.token0);
      const t1 = tokenMeta.get(p.token1);
      if (!t0 || !t1) return null;

      return {
        chain: chainKey,
        walletAddress: owner,
        tokenId: p.tokenId,
        protocol: "v3",
        poolAddress,
        fee: p.fee,
        tickSpacing: tickSpacingForFee(p.fee),
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        currentTick,
        sqrtPriceX96,
        liquidity: p.liquidity,
        token0: { address: p.token0, decimals: t0.decimals, symbol: t0.symbol },
        token1: { address: p.token1, decimals: t1.decimals, symbol: t1.symbol },
      };
    })
    .filter((p): p is OnchainPosition => p !== null);
}

const MAX_UINT128 = 2n ** 128n - 1n; // convenção Uniswap pra "colete tudo que houver"

export type UncollectedFees = { amount0: bigint; amount1: bigint };

// Simula collect() (eth_call puro, sem enviar transação nem precisar de
// chave privada) pra cada posição, em paralelo. Não dá pra agregar via
// multicall3 como o resto deste arquivo: collect() exige msg.sender
// autorizado (dono/operador) via isAuthorizedForToken, e dentro de um
// multicall msg.sender seria o próprio contrato Multicall3, não o dono —
// autorização falharia. Por isso são N eth_calls independentes.
// Promise.allSettled (não Promise.all) garante que uma simulação falhando
// (timeout, revert) não derruba as outras.
export async function fetchUncollectedFees(
  chainKey: ChainKey,
  owner: Address,
  positions: OnchainPosition[]
): Promise<Map<string, UncollectedFees>> {
  const publicClient = getPublicClient(chainKey);
  const npm = {
    address: chains[chainKey].uniswapV3.nonfungiblePositionManager,
    abi: nonfungiblePositionManagerAbi,
  } as const;

  const settled = await Promise.allSettled(
    positions.map((p) =>
      publicClient.simulateContract({
        ...npm,
        functionName: "collect",
        args: [{ tokenId: p.tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
        account: owner,
      })
    )
  );

  const fees = new Map<string, UncollectedFees>();
  settled.forEach((r, i) => {
    const tokenId = positions[i]!.tokenId.toString();
    if (r.status === "fulfilled") {
      const [amount0, amount1] = r.value.result;
      fees.set(tokenId, { amount0, amount1 });
    } else {
      console.error(`[fetchUncollectedFees] falha ao simular collect() da posição #${tokenId}:`, r.reason);
    }
  });
  // posição ausente do Map = simulação falhou; quem chama deve mostrar
  // "indisponível", nunca assumir 0 disfarçado (0 é um valor real e
  // diferente de "não sei").
  return fees;
}

export type PositionsByChain = { chain: ChainKey; positions: OnchainPosition[] };

// Busca V3 e (se a chain tiver uniswapV4 configurado) V4 em paralelo e
// junta num array só — import de client-v4.ts aqui (e client-v4.ts
// importando getPublicClient/UncollectedFees deste arquivo) é circular de
// propósito: os dois lados só usam o import dentro de corpo de função,
// nunca no nível do módulo, então o ESM resolve sem problema (padrão
// seguro, evita duplicar getPublicClient/tipos só pra quebrar o ciclo).
async function fetchAllProtocolPositionsForWallet(chainKey: ChainKey, owner: Address): Promise<OnchainPosition[]> {
  const { fetchV4PositionsForWallet } = await import("./client-v4.js");
  const [v3, v4] = await Promise.all([fetchPositionsForWallet(chainKey, owner), fetchV4PositionsForWallet(chainKey, owner)]);
  return [...v3, ...v4];
}

// Busca as posições de uma wallet em todas as chains ativas em paralelo,
// isolando falha por chain (uma RPC fora do ar não derruba as outras) —
// mesmo padrão de Promise.allSettled já usado em fetchUncollectedFees acima.
export async function fetchPositionsAcrossChains(
  owner: Address,
  activeChains: ChainKey[]
): Promise<PositionsByChain[]> {
  const settled = await Promise.allSettled(
    activeChains.map(async (chain) => ({ chain, positions: await fetchAllProtocolPositionsForWallet(chain, owner) }))
  );
  return settled.flatMap((r, i) => {
    if (r.status === "fulfilled") return [r.value];
    console.error(`[fetchPositionsAcrossChains] falha na chain ${activeChains[i]}:`, r.reason);
    return [];
  });
}

// Busca posições de VÁRIAS wallets do mesmo usuário, em todas as chains
// ativas, e junta o resultado por chain — cada OnchainPosition já carrega
// sua própria walletAddress, então o merge é seguro mesmo com wallets
// diferentes tendo posições na mesma chain. Reaproveitado pelo job de 15min
// e por /positions, pra não duplicar esse fan-out em dois lugares.
export async function fetchPositionsForWallets(
  owners: Address[],
  activeChains: ChainKey[]
): Promise<PositionsByChain[]> {
  const perWallet = await Promise.all(owners.map((owner) => fetchPositionsAcrossChains(owner, activeChains)));

  const positionsByChain = new Map<ChainKey, OnchainPosition[]>();
  for (const walletResult of perWallet) {
    for (const { chain, positions } of walletResult) {
      positionsByChain.set(chain, [...(positionsByChain.get(chain) ?? []), ...positions]);
    }
  }
  return [...positionsByChain.entries()].map(([chain, positions]) => ({ chain, positions }));
}

export type PoolInfo = {
  poolAddress: Address;
  sqrtPriceX96: bigint;
  currentTick: number;
  token0: { address: Address; decimals: number; symbol: string };
  token1: { address: Address; decimals: number; symbol: string };
};

// Resolve um pool Uniswap V3 a partir de dois endereços de token (ordem não
// importa — getPool() é simétrico na factory real) + fee tier. Diferente de
// fetchPositionsForWallet (que lê token0/token1 já resolvidos de uma posição
// NFT existente), aqui NÃO existe posição nenhuma ainda — por isso lê
// token0()/token1() diretamente do pool em vez de assumir que a ordem dos
// endereços de entrada bate com a ordem canônica (ordenada por endereço)
// que o Uniswap usa internamente. Usado por /range, que sugere faixa ANTES
// de abrir a posição.
export async function getPoolInfo(chainKey: ChainKey, tokenA: Address, tokenB: Address, fee: number): Promise<PoolInfo | null> {
  const publicClient = getPublicClient(chainKey);
  const poolAddress = await publicClient.readContract({
    address: chains[chainKey].uniswapV3.factory,
    abi: uniswapV3FactoryAbi,
    functionName: "getPool",
    args: [tokenA, tokenB, fee],
  });
  if (poolAddress === zeroAddress) return null; // sem pool criado pra esse par/fee

  const poolContract = { address: poolAddress, abi: uniswapV3PoolAbi } as const;
  const [slot0Result, token0Result, token1Result] = await publicClient.multicall({
    contracts: [
      { ...poolContract, functionName: "slot0" } as const,
      { ...poolContract, functionName: "token0" } as const,
      { ...poolContract, functionName: "token1" } as const,
    ],
    allowFailure: true,
  });
  if (slot0Result?.status !== "success" || token0Result?.status !== "success" || token1Result?.status !== "success") {
    return null;
  }
  const [sqrtPriceX96, currentTick] = slot0Result.result;
  const token0Address = token0Result.result;
  const token1Address = token1Result.result;

  const tokenResults = await publicClient.multicall({
    contracts: [token0Address, token1Address].flatMap(
      (addr) =>
        [
          { address: addr, abi: erc20Abi, functionName: "decimals" } as const,
          { address: addr, abi: erc20Abi, functionName: "symbol" } as const,
        ] as const
    ),
    allowFailure: true,
  });
  const decimals0 = tokenResults[0]?.status === "success" ? (tokenResults[0].result as number) : 18;
  const symbol0 = tokenResults[1]?.status === "success" ? (tokenResults[1].result as string) : "???";
  const decimals1 = tokenResults[2]?.status === "success" ? (tokenResults[2].result as number) : 18;
  const symbol1 = tokenResults[3]?.status === "success" ? (tokenResults[3].result as string) : "???";

  return {
    poolAddress,
    sqrtPriceX96,
    currentTick,
    token0: { address: token0Address, decimals: decimals0, symbol: symbol0 },
    token1: { address: token1Address, decimals: decimals1, symbol: symbol1 },
  };
}

// Busca os checkpoints de tickCumulative do oráculo nativo do pool — 1
// chamada de RPC pra qualquer quantidade de checkpoints (não escala com o
// tamanho da janela de tempo, diferente de amostrar blocos históricos um
// por um). Retorna null se o pool não tiver histórico suficiente pra essa
// janela (observe() reverte com "OLD") — quem chama decide o que fazer
// (tentar uma janela menor, cair pra um heurístico sem dado histórico).
export async function fetchTickCumulatives(
  chainKey: ChainKey,
  poolAddress: Address,
  secondsAgos: number[]
): Promise<readonly bigint[] | null> {
  try {
    const [tickCumulatives] = await getPublicClient(chainKey).readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "observe",
      args: [secondsAgos],
    });
    return tickCumulatives;
  } catch (err) {
    // O revert mais comum aqui é "OLD": o timestamp pedido é mais antigo que
    // a observação mais velha guardada no buffer circular do pool. Isso NÃO
    // significa pool parado — significa o contrário: pool muito ativo
    // sobrescreve o buffer (tamanho fixo) rápido e o alcance encolhe. Logar a
    // razão evita o diagnóstico errado (o erro era engolido em silêncio, e a
    // mensagem genérica de "sem histórico" mandava investigar o lado errado).
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.warn(`[onchain] observe() falhou em ${poolAddress} (${secondsAgos[0]}s atrás): ${reason}`);
    return null;
  }
}

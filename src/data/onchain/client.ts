import { createPublicClient, http, type Address } from "viem";
import { chains, UNISWAP_V3 } from "../../config/chains.js";
import { env } from "../../config/env.js";
import { erc20Abi, nonfungiblePositionManagerAbi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from "./abis.js";
import type { OnchainPosition } from "../../domain/lp-rebalance/types.js";

export const publicClient = createPublicClient({
  chain: chains.arbitrum.viemChain,
  transport: http(env.arbitrumRpcUrl),
});

// client.multicall usa o contrato multicall3, já pré-configurado em
// viem/chains para arbitrum — nenhuma config extra necessária.
export async function fetchPositionsForWallet(owner: Address): Promise<OnchainPosition[]> {
  const npm = { address: UNISWAP_V3.nonfungiblePositionManager, abi: nonfungiblePositionManagerAbi } as const;

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

  const factory = { address: UNISWAP_V3.factory, abi: uniswapV3FactoryAbi } as const;
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
        tokenId: p.tokenId,
        poolAddress,
        fee: p.fee,
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

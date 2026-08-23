import { encodeAbiParameters, encodePacked, keccak256, pad, toHex, zeroAddress, type Address, type Hash } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import { calculateFeesOwedFromGrowth, decodePositionInfo } from "../../domain/lp-rebalance/position-info-v4.js";
import { tickSpacingForFee } from "../../domain/lp-rebalance/price-math.js";
import type { OnchainPosition } from "../../domain/lp-rebalance/types.js";
import { erc20Abi } from "./abis.js";
import { getPublicClient, type PoolInfo, type UncollectedFees } from "./client.js";
import { uniswapV4PositionManagerAbi, uniswapV4StateViewAbi } from "./v4-abis.js";

type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

// PoolId = keccak256(abi.encode(PoolKey)) — o V4 não guarda o PoolKey
// completo on-chain em lugar acessível, tem que recalcular no cliente pra
// consultar o StateView. Confirmado ao vivo: bate com o prefixo do PoolId
// truncado que vem embutido em PositionInfo (cross-check independente).
function computePoolId(poolKey: PoolKey): Hash {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
      ],
      [poolKey]
    )
  );
}

// ATENÇÃO: encodePacked, não encode — confirmado ao vivo (23/08/2026): com
// encode "normal" a leitura volta zerada silenciosamente (positionId errado,
// não existe no storage do PoolManager, sem erro nenhum). O "dono" da
// posição dentro do PoolManager é o próprio contrato PositionManager, com
// salt = bytes32(tokenId).
function computePositionId(positionManager: Address, tickLower: number, tickUpper: number, tokenId: bigint): Hash {
  const salt = pad(toHex(tokenId), { size: 32 });
  return keccak256(encodePacked(["address", "int24", "int24", "bytes32"], [positionManager, tickLower, tickUpper, salt]));
}

type ActiveV4Position = { tokenId: bigint; poolKey: PoolKey; tickLower: number; tickUpper: number; liquidity: bigint };

// Descoberta de tokenIds de uma wallet: o PositionManager do V4 NÃO é
// ERC721Enumerable (tokenOfOwnerByIndex reverte, confirmado ao vivo) — acha
// candidatos via evento Transfer(to=owner) (tokenId indexado, igual ERC-721
// padrão) e confirma posse ATUAL via ownerOf (um NFT recebido pode ter sido
// transferido pra fora depois). Sem chunking: range de eth_getLogs
// ilimitado desde o upgrade da Alchemy pra Pay As You Go.
async function findOwnedTokenIds(chainKey: ChainKey, positionManager: Address, owner: Address): Promise<bigint[]> {
  const publicClient = getPublicClient(chainKey);
  const pm = { address: positionManager, abi: uniswapV4PositionManagerAbi } as const;

  const balance = await publicClient.readContract({ ...pm, functionName: "balanceOf", args: [owner] });
  if (balance === 0n) return [];

  const transferLogs = await publicClient.getContractEvents({
    ...pm,
    eventName: "Transfer",
    args: { to: owner },
    fromBlock: 0n,
    toBlock: "latest",
  });
  const candidateTokenIds = [...new Set(transferLogs.map((log) => log.args.id).filter((id): id is bigint => id !== undefined))];
  if (candidateTokenIds.length === 0) return [];

  const ownerResults = await publicClient.multicall({
    contracts: candidateTokenIds.map((tokenId) => ({ ...pm, functionName: "ownerOf", args: [tokenId] }) as const),
    allowFailure: true,
  });
  return candidateTokenIds.filter((_, i) => {
    const r = ownerResults[i];
    return r?.status === "success" && r.result.toLowerCase() === owner.toLowerCase();
  });
}

export async function fetchV4PositionsForWallet(chainKey: ChainKey, owner: Address): Promise<OnchainPosition[]> {
  const v4 = chains[chainKey].uniswapV4;
  if (!v4) return [];

  const publicClient = getPublicClient(chainKey);
  const pm = { address: v4.positionManager, abi: uniswapV4PositionManagerAbi } as const;

  const ownedTokenIds = await findOwnedTokenIds(chainKey, v4.positionManager, owner);
  if (ownedTokenIds.length === 0) return [];

  const [poolAndInfoResults, liquidityResults] = await Promise.all([
    publicClient.multicall({
      contracts: ownedTokenIds.map((tokenId) => ({ ...pm, functionName: "getPoolAndPositionInfo", args: [tokenId] }) as const),
      allowFailure: true,
    }),
    publicClient.multicall({
      contracts: ownedTokenIds.map((tokenId) => ({ ...pm, functionName: "getPositionLiquidity", args: [tokenId] }) as const),
      allowFailure: true,
    }),
  ]);

  // liquidity === 0n => posição fechada/vazia (mesmo critério do V3) — não
  // representa capital em risco, fica de fora.
  const active: ActiveV4Position[] = [];
  ownedTokenIds.forEach((tokenId, i) => {
    const poolInfo = poolAndInfoResults[i];
    const liq = liquidityResults[i];
    if (poolInfo?.status !== "success" || liq?.status !== "success" || liq.result === 0n) return;
    const [poolKey, packed] = poolInfo.result;
    const { tickLower, tickUpper } = decodePositionInfo(packed);
    active.push({ tokenId, poolKey, tickLower, tickUpper, liquidity: liq.result });
  });
  if (active.length === 0) return [];

  const tokenAddrs = [...new Set(active.flatMap((p) => [p.poolKey.currency0, p.poolKey.currency1]))];
  const tokenResults = await publicClient.multicall({
    contracts: tokenAddrs.flatMap((addr) => [
      { address: addr, abi: erc20Abi, functionName: "decimals" } as const,
      { address: addr, abi: erc20Abi, functionName: "symbol" } as const,
    ]),
    allowFailure: true,
  });
  const tokenMeta = new Map(
    tokenAddrs.map((addr, i) => {
      const decimalsResult = tokenResults[i * 2];
      const symbolResult = tokenResults[i * 2 + 1];
      const decimals = decimalsResult?.status === "success" ? (decimalsResult.result as number) : 18;
      const symbol = symbolResult?.status === "success" ? (symbolResult.result as string) : "???";
      return [addr, { decimals, symbol }];
    })
  );

  const poolIdByIndex = active.map((p) => computePoolId(p.poolKey));
  const uniquePoolIds = [...new Set(poolIdByIndex)];
  const slot0Results = await publicClient.multicall({
    contracts: uniquePoolIds.map((poolId) => ({ address: v4.stateView, abi: uniswapV4StateViewAbi, functionName: "getSlot0", args: [poolId] }) as const),
    allowFailure: true,
  });
  const slot0ByPoolId = new Map(
    uniquePoolIds.map((poolId, i) => {
      const r = slot0Results[i];
      return [poolId, r?.status === "success" ? r.result : null];
    })
  );

  const positions: OnchainPosition[] = [];
  active.forEach((p, i) => {
    const poolId = poolIdByIndex[i]!;
    const slot0 = slot0ByPoolId.get(poolId);
    if (!slot0) return; // slot0 falhou pra esse pool, pula
    const [sqrtPriceX96, currentTick] = slot0;
    const t0 = tokenMeta.get(p.poolKey.currency0);
    const t1 = tokenMeta.get(p.poolKey.currency1);
    if (!t0 || !t1) return;

    positions.push({
      chain: chainKey,
      walletAddress: owner,
      tokenId: p.tokenId,
      protocol: "v4",
      // Pra V4 é o PoolId, não um endereço de contrato real — ver
      // comentário em domain/lp-rebalance/types.ts.
      poolAddress: poolId,
      fee: p.poolKey.fee,
      tickSpacing: p.poolKey.tickSpacing,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      currentTick,
      sqrtPriceX96,
      liquidity: p.liquidity,
      token0: { address: p.poolKey.currency0, decimals: t0.decimals, symbol: t0.symbol },
      token1: { address: p.poolKey.currency1, decimals: t1.decimals, symbol: t1.symbol },
    });
  });

  return positions;
}

// Equivalente V4 de fetchUncollectedFees (V3) — mas SEM simular collect():
// StateView expõe os 2 valores de feeGrowthInside (o último GRAVADO na
// posição, e o atual recalculado ao vivo) via chamadas view puras. Só
// aceita posições V4 (chama o mesmo positionId/PoolId já resolvidos em
// fetchV4PositionsForWallet) — quem chama passa as OnchainPosition já
// buscadas, evita recalcular tudo de novo.
export async function fetchV4UncollectedFees(chainKey: ChainKey, positions: OnchainPosition[]): Promise<Map<string, UncollectedFees>> {
  const v4Positions = positions.filter((p) => p.protocol === "v4");
  const fees = new Map<string, UncollectedFees>();
  if (v4Positions.length === 0) return fees;

  const v4 = chains[chainKey].uniswapV4;
  if (!v4) return fees;

  const publicClient = getPublicClient(chainKey);
  const stateView = { address: v4.stateView, abi: uniswapV4StateViewAbi } as const;

  const positionIds = v4Positions.map((p) => computePositionId(v4.positionManager, p.tickLower, p.tickUpper, p.tokenId));
  // poolAddress guarda o PoolId pra posições V4 (ver types.ts).
  const poolIds = v4Positions.map((p) => p.poolAddress);

  const [positionInfoResults, feeGrowthResults] = await Promise.all([
    publicClient.multicall({
      contracts: v4Positions.map((p, i) => ({ ...stateView, functionName: "getPositionInfo", args: [poolIds[i]!, positionIds[i]!] }) as const),
      allowFailure: true,
    }),
    publicClient.multicall({
      contracts: v4Positions.map((p, i) => ({ ...stateView, functionName: "getFeeGrowthInside", args: [poolIds[i]!, p.tickLower, p.tickUpper] }) as const),
      allowFailure: true,
    }),
  ]);

  v4Positions.forEach((p, i) => {
    const posInfo = positionInfoResults[i];
    const growth = feeGrowthResults[i];
    if (posInfo?.status !== "success" || growth?.status !== "success") {
      console.error(`[fetchV4UncollectedFees] falha ao ler fees da posição #${p.tokenId}`);
      return;
    }
    const [, feeGrowthInside0Last, feeGrowthInside1Last] = posInfo.result;
    const [feeGrowthInside0, feeGrowthInside1] = growth.result;
    const amount0 = calculateFeesOwedFromGrowth(feeGrowthInside0Last, feeGrowthInside0, p.liquidity);
    const amount1 = calculateFeesOwedFromGrowth(feeGrowthInside1Last, feeGrowthInside1, p.liquidity);
    fees.set(p.tokenId.toString(), { amount0, amount1 });
  });

  return fees;
}

// Equivalente V4 de getPoolInfo (V3, em client.ts) — usado por /range, ANTES
// de existir qualquer posição. Diferente da leitura de uma posição existente
// (que traz o PoolKey completo pronto via getPoolAndPositionInfo), aqui só
// se tem tokenA/tokenB/fee (da DefiLlama) — falta tickSpacing e hooks pra
// montar o PoolKey e calcular o PoolId. Assume o par "vanilla" mais comum:
// tickSpacing = mesmo valor padrão do V3 pra esse fee tier, hooks = endereço
// zero (sem hook customizado) — confirmado ao vivo (23/08/2026) que é
// exatamente essa combinação que a posição real do usuário usa (fee 500 ->
// tickSpacing 10, hooks zero). Se o pool de verdade usa tickSpacing/hooks
// diferentes do padrão, o PoolId calculado aqui não bate com nenhum pool
// real e getSlot0 falha — retorna null nesse caso (sem fingir ter achado
// algo), quem chama decide como avisar o usuário.
export async function getV4PoolInfo(chainKey: ChainKey, tokenA: Address, tokenB: Address, fee: number): Promise<PoolInfo | null> {
  const v4 = chains[chainKey].uniswapV4;
  if (!v4) return null;

  // PoolKey exige currency0 < currency1 (ordem canônica por endereço) —
  // mesma convenção que o V3 aplica dentro do próprio contrato de pool,
  // mas aqui precisa ser feita no cliente já que estamos montando a chave.
  const [currency0, currency1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  const poolKey: PoolKey = { currency0, currency1, fee, tickSpacing: tickSpacingForFee(fee), hooks: zeroAddress };
  const poolId = computePoolId(poolKey);

  const publicClient = getPublicClient(chainKey);
  const slot0Result = await publicClient.readContract({
    address: v4.stateView,
    abi: uniswapV4StateViewAbi,
    functionName: "getSlot0",
    args: [poolId],
  });
  const [sqrtPriceX96, currentTick] = slot0Result;
  if (sqrtPriceX96 === 0n) return null; // pool não inicializado (não existe com essa config)

  const tokenResults = await publicClient.multicall({
    contracts: [currency0, currency1].flatMap(
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
    // Pra V4 é o PoolId, não um endereço de contrato real — mesma convenção
    // de OnchainPosition.poolAddress (ver types.ts).
    poolAddress: poolId,
    sqrtPriceX96,
    currentTick,
    token0: { address: currency0, decimals: decimals0, symbol: symbol0 },
    token1: { address: currency1, decimals: decimals1, symbol: symbol1 },
  };
}

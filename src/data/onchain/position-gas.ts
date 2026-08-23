import { pad, toHex, zeroAddress, type Hash, type Hex } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import { nonfungiblePositionManagerAbi } from "./abis.js";
import { getPublicClient } from "./client.js";
import { uniswapV4PoolManagerAbi, uniswapV4PositionManagerAbi } from "./v4-abis.js";

// Só usado pra limitar o tamanho da janela de busca de eventos (quantos
// blocos representam N horas), não pra nenhum cálculo financeiro —
// aproximado é suficiente aqui.
const APPROX_BLOCK_TIME_SECONDS: Record<ChainKey, number> = {
  arbitrum: 0.25,
  base: 2,
  optimism: 2,
  polygon: 2,
};

// Histórico: o free tier da Alchemy só aceitava até 10 blocos por chamada
// de eth_getLogs (confirmado ao vivo, 23/08/2026), o que forçava um scan em
// chunks minúsculos e podia levar 1-2min no caso "não achou nada". Depois
// do upgrade pra Pay As You Go (mesmo dia), esse limite virou ILIMITADO —
// confirmado na doc oficial da Alchemy (eth_getLogs, Arbitrum/Ethereum/
// Base/Optimism: Free = 10 blocos, Pay As You Go = ilimitado). Por isso a
// busca agora é 1 chamada só por evento, sem chunking — muito mais rápida
// e simples. Se algum dia voltar pro free tier (ou trocar de provedor sem
// esse limite liberado), essa função vai começar a falhar com "range grande
// demais" — nesse caso, reintroduzir o chunking (ver histórico do git).
const LOG_SCAN_MAX_LOOKBACK_HOURS = 24;

export type MintGasResult = { gasNative: number; txHash: Hash };
export type CloseGasResult = { gasNative: number; txHashes: Hash[] };

async function computeTxGasCostNative(chainKey: ChainKey, txHash: Hash): Promise<number> {
  const publicClient = getPublicClient(chainKey);
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  return Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18;
}

// 1 chamada só, cobrindo a janela inteira — retorna vazio (não lança) se
// não achar nada dentro do teto de lookback; quem chama trata isso como
// "gas não disponível", nunca cai pra um escaneio sem limite.
async function findEventsForTokenId(
  chainKey: ChainKey,
  eventName: "IncreaseLiquidity" | "DecreaseLiquidity" | "Collect",
  tokenId: bigint
): Promise<Hash[]> {
  const publicClient = getPublicClient(chainKey);
  const npmAddress = chains[chainKey].uniswapV3.nonfungiblePositionManager;
  const latestBlock = await publicClient.getBlockNumber();

  const blockTime = APPROX_BLOCK_TIME_SECONDS[chainKey];
  const maxLookbackBlocks = BigInt(Math.ceil((LOG_SCAN_MAX_LOOKBACK_HOURS * 3600) / blockTime));
  const oldestBlock = latestBlock > maxLookbackBlocks ? latestBlock - maxLookbackBlocks : 0n;

  const logs = await publicClient.getContractEvents({
    address: npmAddress,
    abi: nonfungiblePositionManagerAbi,
    eventName,
    args: { tokenId },
    fromBlock: oldestBlock,
    toBlock: latestBlock,
  });

  return logs.map((log) => log.transactionHash).filter((hash): hash is Hash => hash !== null);
}

// mint() da Uniswap V3 não emite um evento "Mint" próprio — dispara
// IncreaseLiquidity, igual a um add de liquidez numa posição existente.
// Só é chamado no momento em que upsertPositions sinaliza isNew (1ª vez
// que o bot vê esse tokenId), então o match mais recente encontrado É o
// mint na prática — não tenta distinguir pelo conteúdo do evento em si.
export async function findMintGasCost(chainKey: ChainKey, tokenId: bigint): Promise<MintGasResult | null> {
  const txHashes = await findEventsForTokenId(chainKey, "IncreaseLiquidity", tokenId);
  if (txHashes.length === 0) return null;
  const txHash = txHashes[txHashes.length - 1]!; // mais recente
  const gasNative = await computeTxGasCostNative(chainKey, txHash);
  return { gasNative, txHash };
}

// V4: mint() não emite IncreaseLiquidity (esse evento nem existe no V4) —
// a transação de mint é o Transfer ERC-721 padrão com from=address(0),
// que o próprio PositionManager já emite (mesmo evento usado em
// client-v4.ts pra descobrir tokenIds de uma wallet). "id" (tokenId) é
// indexado, igual "from" — dá pra filtrar pelos dois de uma vez, sem
// precisar saber o owner.
export async function findV4MintGasCost(chainKey: ChainKey, tokenId: bigint): Promise<MintGasResult | null> {
  const v4 = chains[chainKey].uniswapV4;
  if (!v4) return null;

  const publicClient = getPublicClient(chainKey);
  const latestBlock = await publicClient.getBlockNumber();
  const blockTime = APPROX_BLOCK_TIME_SECONDS[chainKey];
  const maxLookbackBlocks = BigInt(Math.ceil((LOG_SCAN_MAX_LOOKBACK_HOURS * 3600) / blockTime));
  const oldestBlock = latestBlock > maxLookbackBlocks ? latestBlock - maxLookbackBlocks : 0n;

  const logs = await publicClient.getContractEvents({
    address: v4.positionManager,
    abi: uniswapV4PositionManagerAbi,
    eventName: "Transfer",
    args: { from: zeroAddress, id: tokenId },
    fromBlock: oldestBlock,
    toBlock: latestBlock,
  });
  if (logs.length === 0) return null;

  const txHash = logs[logs.length - 1]!.transactionHash;
  if (!txHash) return null;
  const gasNative = await computeTxGasCostNative(chainKey, txHash);
  return { gasNative, txHash };
}

// O fluxo "Remove Liquidity" do app da Uniswap costuma emitir
// DecreaseLiquidity + Collect na MESMA transação (multicall) — dedupe por
// hash antes de somar, senão contaria o gas da mesma transação 2x.
export async function findCloseGasCost(chainKey: ChainKey, tokenId: bigint): Promise<CloseGasResult | null> {
  const [decreaseHashes, collectHashes] = await Promise.all([
    findEventsForTokenId(chainKey, "DecreaseLiquidity", tokenId),
    findEventsForTokenId(chainKey, "Collect", tokenId),
  ]);

  const uniqueHashes = [...new Set([...decreaseHashes, ...collectHashes])];
  if (uniqueHashes.length === 0) return null;

  const costs = await Promise.all(uniqueHashes.map((hash) => computeTxGasCostNative(chainKey, hash)));
  const gasNative = costs.reduce((sum, cost) => sum + cost, 0);
  return { gasNative, txHashes: uniqueHashes };
}

// V4: não existe DecreaseLiquidity/Collect próprios — todo modifyLiquidity
// (add OU remove) do PoolManager emite o MESMO evento `ModifyLiquidity`
// (confirmado ao vivo, 23/08/2026, via comparação de topics/keccak256 —
// ver comentário em v4-abis.ts). `sender` é sempre o PositionManager (não
// dá pra filtrar por wallet), e o único campo indexado é `id` (PoolId) —
// por isso filtra por pool e decodifica `salt` no cliente pra achar a
// posição certa. `salt = bytes32(tokenId)` é a mesma convenção usada em
// computePositionId (client-v4.ts), então dá pra comparar direto sem
// precisar de tickLower/tickUpper. liquidityDelta < 0 identifica um
// decréscimo (remove), não um add.
export async function findV4CloseGasCost(chainKey: ChainKey, poolId: Hex, tokenId: bigint): Promise<CloseGasResult | null> {
  const v4 = chains[chainKey].uniswapV4;
  if (!v4) return null;

  const publicClient = getPublicClient(chainKey);
  const latestBlock = await publicClient.getBlockNumber();
  const blockTime = APPROX_BLOCK_TIME_SECONDS[chainKey];
  const maxLookbackBlocks = BigInt(Math.ceil((LOG_SCAN_MAX_LOOKBACK_HOURS * 3600) / blockTime));
  const oldestBlock = latestBlock > maxLookbackBlocks ? latestBlock - maxLookbackBlocks : 0n;

  const logs = await publicClient.getContractEvents({
    address: v4.poolManager,
    abi: uniswapV4PoolManagerAbi,
    eventName: "ModifyLiquidity",
    args: { id: poolId },
    fromBlock: oldestBlock,
    toBlock: latestBlock,
  });

  const wantedSalt = pad(toHex(tokenId), { size: 32 });
  const matches = logs.filter((log) => log.args.salt === wantedSalt && (log.args.liquidityDelta ?? 0n) < 0n);
  const uniqueHashes = [...new Set(matches.map((log) => log.transactionHash).filter((hash): hash is Hash => hash !== null))];
  if (uniqueHashes.length === 0) return null;

  const costs = await Promise.all(uniqueHashes.map((hash) => computeTxGasCostNative(chainKey, hash)));
  const gasNative = costs.reduce((sum, cost) => sum + cost, 0);
  return { gasNative, txHashes: uniqueHashes };
}

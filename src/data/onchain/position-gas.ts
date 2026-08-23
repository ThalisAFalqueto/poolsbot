import type { Hash } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import { nonfungiblePositionManagerAbi } from "./abis.js";
import { getPublicClient } from "./client.js";

// Só usado pra limitar o tamanho da janela de busca de eventos (quantos
// blocos representam N horas), não pra nenhum cálculo financeiro —
// aproximado é suficiente aqui.
const APPROX_BLOCK_TIME_SECONDS: Record<ChainKey, number> = {
  arbitrum: 0.25,
  base: 2,
  optimism: 2,
  polygon: 2,
};

// Alchemy free tier (RPC configurado nesse projeto) só aceita até 10 blocos
// por chamada de eth_getLogs — confirmado ao vivo contra a RPC real (não é
// suposição): a 1ª tentativa com um chunk de 2000 blocos foi rejeitada com
// "Under the Free tier plan, you can make eth_getLogs requests with up to a
// 10 block range". 10 é o valor que a própria Alchemy sugeriu na resposta.
const LOG_SCAN_CHUNK_BLOCKS = 10n;

// Com chunk de só 10 blocos, uma janela de horas exigiria centenas/milhares
// de chamadas sequenciais — inviável (achado real acima). 15min casa com o
// ciclo do job automático: cobre o caso comum (evento detectado no mesmo
// ciclo em que aconteceu) sem explodir o número de chamadas no caso raro de
// não achar nada. Fora dessa janela, gas fica honestamente "não
// disponível" — não é um bug, é o limite real do free tier.
const LOG_SCAN_MAX_LOOKBACK_HOURS = 0.25;

export type MintGasResult = { gasNative: number; txHash: Hash };
export type CloseGasResult = { gasNative: number; txHashes: Hash[] };

async function computeTxGasCostNative(chainKey: ChainKey, txHash: Hash): Promise<number> {
  const publicClient = getPublicClient(chainKey);
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  return Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18;
}

// Escaneia pra trás em chunks, do bloco mais recente até o teto de
// lookback, parando no 1º chunk com match — assume que o evento procurado
// é RECENTE (mint acabou de ser detectado via isNew, close acabou de ser
// detectado pela posição sumir do fetch), então isso cobre o caso comum
// com poucas chamadas de RPC. Retorna vazio (não lança) se não achar nada
// dentro do teto — quem chama trata como "gas não disponível", nunca cai
// pra um escaneio sem limite.
async function scanRecentEventsForTokenId(
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

  let toBlock = latestBlock;
  while (toBlock >= oldestBlock) {
    const chunkStart = toBlock - LOG_SCAN_CHUNK_BLOCKS + 1n;
    const fromBlock = chunkStart > oldestBlock ? chunkStart : oldestBlock;

    const logs = await publicClient.getContractEvents({
      address: npmAddress,
      abi: nonfungiblePositionManagerAbi,
      eventName,
      args: { tokenId },
      fromBlock,
      toBlock,
    });

    if (logs.length > 0) {
      return logs.map((log) => log.transactionHash).filter((hash): hash is Hash => hash !== null);
    }

    if (fromBlock === oldestBlock) break; // já cobriu toda a janela permitida
    toBlock = fromBlock - 1n;
  }

  return [];
}

// mint() da Uniswap V3 não emite um evento "Mint" próprio — dispara
// IncreaseLiquidity, igual a um add de liquidez numa posição existente.
// Só é chamado no momento em que upsertPositions sinaliza isNew (1ª vez
// que o bot vê esse tokenId), então o match mais recente encontrado É o
// mint na prática — não tenta distinguir pelo conteúdo do evento em si.
export async function findMintGasCost(chainKey: ChainKey, tokenId: bigint): Promise<MintGasResult | null> {
  const txHashes = await scanRecentEventsForTokenId(chainKey, "IncreaseLiquidity", tokenId);
  if (txHashes.length === 0) return null;
  const txHash = txHashes[0]!;
  const gasNative = await computeTxGasCostNative(chainKey, txHash);
  return { gasNative, txHash };
}

// O fluxo "Remove Liquidity" do app da Uniswap costuma emitir
// DecreaseLiquidity + Collect na MESMA transação (multicall) — dedupe por
// hash antes de somar, senão contaria o gas da mesma transação 2x. Os 2
// scans rodam em SEQUÊNCIA (não Promise.all) — janela de 10 blocos por
// chamada já é limitada o bastante, rodar em paralelo dobraria a taxa
// instantânea de chamadas contra o free tier à toa.
export async function findCloseGasCost(chainKey: ChainKey, tokenId: bigint): Promise<CloseGasResult | null> {
  const decreaseHashes = await scanRecentEventsForTokenId(chainKey, "DecreaseLiquidity", tokenId);
  const collectHashes = await scanRecentEventsForTokenId(chainKey, "Collect", tokenId);

  const uniqueHashes = [...new Set([...decreaseHashes, ...collectHashes])];
  if (uniqueHashes.length === 0) return null;

  const costs = await Promise.all(uniqueHashes.map((hash) => computeTxGasCostNative(chainKey, hash)));
  const gasNative = costs.reduce((sum, cost) => sum + cost, 0);
  return { gasNative, txHashes: uniqueHashes };
}

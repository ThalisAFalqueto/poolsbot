import { parseAbi, type Address, type Hash } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import { calculateCloseReceipt, type CloseReceipt, type LiquidityEvent } from "../../domain/lp-rebalance/close-receipt.js";
import { sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { nonfungiblePositionManagerAbi } from "./abis.js";
import { getPublicClient } from "./client.js";

// Lê da chain os eventos de uma posição V3 e monta o recibo de fechamento —
// ver domain/lp-rebalance/close-receipt.ts pro caso real que motivou isso.
//
// Só V3. No V4 não existem DecreaseLiquidity/Collect: todo modifyLiquidity
// emite o mesmo ModifyLiquidity, sem quantidades, e a taxa sai embutida no
// delta (ver findV4CloseGasCost). Posição V4 continua no recibo de snapshot,
// e o /closed avisa.

const slot0Abi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

type EventName = "IncreaseLiquidity" | "DecreaseLiquidity" | "Collect";
const EVENTOS: EventName[] = ["IncreaseLiquidity", "DecreaseLiquidity", "Collect"];
const KIND: Record<EventName, LiquidityEvent["kind"]> = {
  IncreaseLiquidity: "increase",
  DecreaseLiquidity: "decrease",
  Collect: "collect",
};

export type V3CloseReceiptInput = {
  chainKey: ChainKey;
  tokenId: bigint;
  poolAddress: Address;
  decimals0: number;
  decimals1: number;
  /** Hash do mint, se conhecido — só pra começar a busca no bloco certo. Sem
   *  ele a busca vai desde o bloco 0, o que funciona (o filtro por tokenId
   *  deixa a resposta pequena), só é mais lento. */
  mintTxHash?: string | null;
};

/**
 * Busca a vida INTEIRA da posição, não uma janela: um aporte ou uma coleta de
 * taxa feitos dias antes do fechamento mudam o recibo, e uma janela de 24h
 * (como a do gas de fechamento) os perderia em silêncio.
 *
 * Cada evento é valorado no preço do pool NO SEU BLOCO — lido do slot0
 * histórico, a mesma leitura que backfill-price-onchain.ts faz.
 *
 * Lança em falha de RPC; devolve null quando os eventos não formam um recibo
 * completo (ver calculateCloseReceipt). Nos dois casos quem chama cai no
 * snapshot — a diferença importa pro log, não pro fluxo.
 */
export async function readV3CloseReceipt(input: V3CloseReceiptInput): Promise<CloseReceipt | null> {
  const client = getPublicClient(input.chainKey);
  const npm = chains[input.chainKey].uniswapV3.nonfungiblePositionManager as Address;
  const fromBlock = input.mintTxHash
    ? (await client.getTransactionReceipt({ hash: input.mintTxHash as Hash })).blockNumber
    : 0n;

  const porEvento = await Promise.all(
    EVENTOS.map((eventName) =>
      client.getContractEvents({
        address: npm,
        abi: nonfungiblePositionManagerAbi,
        eventName,
        args: { tokenId: input.tokenId },
        fromBlock,
        toBlock: "latest",
      })
    )
  );
  const brutos = porEvento.flatMap((logs, i) => logs.map((log) => ({ kind: KIND[EVENTOS[i]!], log })));
  if (brutos.length === 0) return null;

  const blocos = [...new Set(brutos.map((b) => b.log.blockNumber))];
  const porBloco = new Map(
    await Promise.all(
      blocos.map(async (blockNumber) => {
        const [bloco, slot0] = await Promise.all([
          client.getBlock({ blockNumber }),
          client.readContract({ address: input.poolAddress, abi: slot0Abi, functionName: "slot0", blockNumber }),
        ]);
        return [
          blockNumber,
          { at: new Date(Number(bloco.timestamp) * 1000), price: sqrtPriceX96ToPrice(slot0[0], input.decimals0, input.decimals1) },
        ] as const;
      })
    )
  );

  const events: LiquidityEvent[] = brutos.map(({ kind, log }) => {
    const args = log.args as { amount0?: bigint; amount1?: bigint };
    const bloco = porBloco.get(log.blockNumber)!;
    return {
      kind,
      amount0: Number(args.amount0 ?? 0n) / 10 ** input.decimals0,
      amount1: Number(args.amount1 ?? 0n) / 10 ** input.decimals1,
      price: bloco.price,
      at: bloco.at,
      txHash: log.transactionHash ?? "",
    };
  });

  return calculateCloseReceipt(events);
}

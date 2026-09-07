import { parseAbi, type Address } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import { getPublicClient } from "./client.js";

// Confirma, LENDO O CONTRATO, que uma posição realmente foi fechada — antes de
// arquivá-la e apagá-la do banco.
//
// POR QUE ISSO EXISTE. O job decidia "fechou" por AUSÊNCIA: a posição sumiu da
// lista lida on-chain, logo foi fechada. Ausência é fraca demais pra sustentar
// uma escrita destrutiva — qualquer hipótese que faça a lista encolher (falha
// de RPC, timeout, nó atrás no bloco) vira arquivamento indevido.
//
// Aconteceu em 03/09/2026 com a posição WBTC/USDC do usuário: arquivada como
// fechada, recriada 15min depois, perdendo gas de mint, data de abertura e
// baseline de IL — e ganhando uma entrada falsa no /closed.
//
// `assertNoPartialFailure` (client.ts) fecha a causa conhecida. Isto aqui fecha
// a CLASSE: mesmo que apareça outro jeito de a lista encolher, nada é
// arquivado sem uma leitura direta dizendo que a liquidez é zero.

const v3Abi = parseAbi([
  "function positions(uint256 tokenId) view returns (uint96,address,address,address,uint24,int24,int24,uint128 liquidity,uint256,uint256,uint128,uint128)",
]);
const v4Abi = parseAbi(["function getPositionLiquidity(uint256 tokenId) view returns (uint128)"]);

export type ClosedConfirmation =
  | { closed: true }
  | { closed: false; reason: "ainda tem liquidez" }
  | { closed: null; reason: string };

/**
 * A posição está mesmo fechada?
 *
 * - `closed: true` — liquidez zero no contrato, pode arquivar.
 * - `closed: false` — ainda tem liquidez; a ausência na lista era falha de
 *   leitura, não fechamento.
 * - `closed: null` — não deu pra confirmar. Quem chama NÃO deve arquivar: na
 *   dúvida, manter o registro custa uma linha; apagar custa dado que não volta.
 *
 * O NFT some (burn) quando a posição é fechada e queimada — `positions()`
 * reverte nesse caso, e reverter É a confirmação de fechamento.
 */
/** Só a leitura de liquidez, isolada. Injetável pra o teste exercitar a
 *  DECISÃO (arquiva / não arquiva / na dúvida não mexe) sem mock de módulo —
 *  que aqui se mostrou frágil e escondia o próprio caminho de erro. */
export type LiquidityReader = (chainKey: ChainKey, protocol: string, tokenId: string) => Promise<bigint>;

const readLiquidityOnchain: LiquidityReader = async (chainKey, protocol, tokenId) => {
  const client = getPublicClient(chainKey);
  if (protocol === "v4") {
    const v4 = chains[chainKey].uniswapV4;
    if (!v4) throw new Error(`chain ${chainKey} sem Uniswap V4 configurado`);
    return client.readContract({ address: v4.positionManager, abi: v4Abi, functionName: "getPositionLiquidity", args: [BigInt(tokenId)] });
  }
  const pos = await client.readContract({
    address: chains[chainKey].uniswapV3.nonfungiblePositionManager as Address,
    abi: v3Abi,
    functionName: "positions",
    args: [BigInt(tokenId)],
  });
  return pos[7];
};

export async function confirmPositionClosed(
  chainKey: ChainKey,
  protocol: string,
  tokenId: string,
  readLiquidity: LiquidityReader = readLiquidityOnchain
): Promise<ClosedConfirmation> {
  try {
    const liquidez = await readLiquidity(chainKey, protocol, tokenId);
    return liquidez === 0n ? { closed: true } : { closed: false, reason: "ainda tem liquidez" };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
    // NFT queimado: o contrato reverte porque o tokenId não existe mais. É o
    // fechamento mais definitivo que existe.
    if (/nonexistent|invalid token|ERC721/i.test(msg)) return { closed: true };
    return { closed: null, reason: msg };
  }
}


import type { CommandContext, Context } from "grammy";
import type { Address } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import { getPoolInfo } from "../../data/onchain/client.js";
import { formatPrice } from "../../domain/lp-rebalance/format-reason.js";
import { sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { isStablecoinSymbol } from "../../domain/lp-rebalance/stablecoins.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { listClosedPositions, type ClosedPositionRow } from "../../persistence/repositories/lp-positions.repository.js";

// formatPrice usa .toFixed(2) — zeraria valores típicos de gas (ex: 0.0003
// ETH), mesmo raciocínio já documentado pra formatAmount em positions.ts.
function formatGasAmount(value: number): string {
  return value.toFixed(6);
}

// Fee tiers padrão do Uniswap V3 — tenta cada um até achar um pool WETH/
// {token1} com liquidez. Só chamado quando faz sentido (gas em ETH e token1
// é uma stablecoin reconhecida, ver buildEthPriceCache abaixo) — em caso de
// falha (nenhum pool achado), retorna null e a conversão fica de fora,
// nunca inventa um número.
const FEE_TIERS = [500, 3000, 10000];

async function findEthPriceInToken1(chain: ChainKey, wethAddress: Address, token1Address: Address): Promise<number | null> {
  const weth = wethAddress.toLowerCase();
  for (const fee of FEE_TIERS) {
    const pool = await getPoolInfo(chain, wethAddress, token1Address, fee);
    if (!pool) continue;
    const price = sqrtPriceX96ToPrice(pool.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
    // getPoolInfo devolve token0/token1 na ordem CANÔNICA (por endereço),
    // não necessariamente na ordem que foi pedida — preço pode sair
    // invertido dependendo de qual lado o WETH caiu.
    if (pool.token0.address.toLowerCase() === weth) return price; // já é token1 por WETH
    if (pool.token1.address.toLowerCase() === weth) return price > 0 ? 1 / price : null; // inverte: WETH por token1 -> token1 por WETH
  }
  return null;
}

// Um lookup on-chain por combinação (chain, token1Address) durante a
// execução do comando, não por posição — várias posições fechadas podem
// compartilhar o mesmo token1 (ex: várias posições em USDC na Arbitrum).
function buildEthPriceCache() {
  const cache = new Map<string, Promise<number | null>>();
  return async (chain: ChainKey, token1Address: Address): Promise<number | null> => {
    const key = `${chain}:${token1Address.toLowerCase()}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = findEthPriceInToken1(chain, chains[chain].wethAddress as Address, token1Address);
      cache.set(key, pending);
    }
    return pending;
  };
}

function formatGasLine(row: ClosedPositionRow, ethPriceInToken1: number | null): string {
  const symbol = row.nativeGasSymbol ?? "?";
  const mint = row.mintGasNative !== null ? `${formatGasAmount(row.mintGasNative)} ${symbol}` : "não disponível";
  const close = row.closeGasNative !== null ? `${formatGasAmount(row.closeGasNative)} ${symbol}` : "não disponível";

  const total = (row.mintGasNative ?? 0) + (row.closeGasNative ?? 0);
  const hasAnyGas = row.mintGasNative !== null || row.closeGasNative !== null;
  if (!hasAnyGas) return `Gas: abertura não disponível · fechamento não disponível`;

  const totalText = `${formatGasAmount(total)} ${symbol}`;
  // Aproximação ao vivo (preço de AGORA, não do momento real do gasto) —
  // só mostrada quando dá pra calcular, nunca inventada.
  const approxText = ethPriceInToken1 !== null ? ` (≈ ${formatPrice(total * ethPriceInToken1)} ${row.token1Symbol} no preço atual)` : "";

  return `Gas: abertura ${mint} · fechamento ${close} · total ${totalText}${approxText}`;
}

function buildClosedBlock(row: ClosedPositionRow, ethPriceInToken1: number | null): string {
  const name = row.label ?? `#${row.tokenId}`;
  const opened = row.openedAt.toLocaleDateString("pt-BR");
  const closed = row.closedAt.toLocaleDateString("pt-BR");
  const vsHold = row.ilToken1 + row.finalFeesValueToken1;

  return [
    `${row.token0Symbol}/${row.token1Symbol} (${name}) — ${opened} a ${closed}`,
    `   Entrada: ${formatPrice(row.entryValueToken1)} ${row.token1Symbol} · Final: ${formatPrice(row.finalPositionValueToken1)} ${row.token1Symbol} · Fees: ${formatPrice(row.finalFeesValueToken1)} ${row.token1Symbol}`,
    `   P&L total (com fees): ${row.totalPnlToken1 >= 0 ? "+" : ""}${formatPrice(row.totalPnlToken1)} ${row.token1Symbol} · vs HOLD: ${vsHold >= 0 ? "+" : ""}${formatPrice(vsHold)} ${row.token1Symbol}`,
    `   ${formatGasLine(row, ethPriceInToken1)}`,
  ].join("\n");
}

export async function closedCommand(ctx: CommandContext<Context>) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const rows = await listClosedPositions(user.id);

  if (rows.length === 0) {
    await ctx.reply(
      "Nenhuma posição fechada registrada ainda. Só fica registrado aqui o que foi arquivado a partir de um /positions rodado antes do fechamento — ver /status se uma posição sumiu sem aparecer aqui."
    );
    return;
  }

  const getEthPrice = buildEthPriceCache();
  const blocks = await Promise.all(
    rows.map(async (row) => {
      const chain = row.chain as ChainKey;
      const canApproximate = row.nativeGasSymbol === "ETH" && isStablecoinSymbol(row.token1Symbol);
      const ethPriceInToken1 = canApproximate ? await getEthPrice(chain, row.token1Address as Address).catch(() => null) : null;
      return buildClosedBlock(row, ethPriceInToken1);
    })
  );

  await ctx.reply(["Posições de LP fechadas:", "", ...blocks].join("\n\n"));
}

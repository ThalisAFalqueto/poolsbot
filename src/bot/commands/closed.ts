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

export function formatGasLine(row: ClosedPositionRow, ethPriceInToken1: number | null): string {
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

// Quantidade de token: 2 casas a partir de 1, 3 algarismos significativos
// abaixo — toFixed(2) zeraria 0,000373 WETH de taxa. Não usa toPrecision:
// abaixo de 1e-6 ele cai em notação científica, e taxa de WBTC vive lá
// ("3.30e-7 WBTC" saiu no /closed real em 11/09/2026).
function formatTokenAmount(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(2 - Math.floor(Math.log10(Math.abs(value))));
}

export function buildClosedBlock(row: ClosedPositionRow, ethPriceInToken1: number | null): string {
  const name = row.label ?? `#${row.tokenId}`;
  const opened = row.openedAt.toLocaleDateString("pt-BR");
  const closed = row.closedAt.toLocaleDateString("pt-BR");
  const vsHold = row.ilToken1 + row.finalFeesValueToken1;
  // Mesma convenção do /positions: só marca o V4, já que V3 é o caso comum.
  const protocolTag = row.protocol === "v4" ? " [V4]" : "";

  // Em quantidade de cada token, quando o recibo veio da chain — é o número
  // que dá pra conferir no explorer, na aba de tokens transferidos.
  const feesEmTokens =
    row.feesAmount0 !== null && row.feesAmount1 !== null
      ? ` (${formatTokenAmount(row.feesAmount0)} ${row.token0Symbol} + ${formatTokenAmount(row.feesAmount1)} ${row.token1Symbol})`
      : "";

  // Recibo de snapshot = valores do último /positions, não do fechamento. Foi
  // assim que a #5683732 saiu com final e fees defasados; onde ainda é o caso
  // (V4, ou leitura on-chain que falhou), o texto tem que dizer.
  const avisoFonte =
    row.receiptSource === "onchain"
      ? []
      : ["   ⚠️ Valores do último /positions antes do fechamento, não da transação de fechamento — podem estar defasados."];

  return [
    `${row.token0Symbol}/${row.token1Symbol}${protocolTag} (${name}) — ${opened} a ${closed}`,
    `   Entrada: ${formatPrice(row.entryValueToken1)} ${row.token1Symbol} · Final: ${formatPrice(row.finalPositionValueToken1)} ${row.token1Symbol}`,
    `   Fees recebidas: ${formatPrice(row.finalFeesValueToken1)} ${row.token1Symbol}${feesEmTokens}`,
    `   P&L total (com fees): ${row.totalPnlToken1 >= 0 ? "+" : ""}${formatPrice(row.totalPnlToken1)} ${row.token1Symbol} · vs HOLD: ${vsHold >= 0 ? "+" : ""}${formatPrice(vsHold)} ${row.token1Symbol}`,
    `   ${formatGasLine(row, ethPriceInToken1)}`,
    ...avisoFonte,
  ].join("\n");
}

/**
 * Soma das taxas de todas as posições fechadas, por token1 — somar USDC com
 * WETH não quer dizer nada. Responde "quanto de taxa eu já ganhei?", que
 * antes exigia somar bloco a bloco.
 */
export function formatFeesTotal(rows: ClosedPositionRow[]): string | null {
  const porToken = new Map<string, { soma: number; n: number; snapshot: number }>();
  for (const r of rows) {
    const t = porToken.get(r.token1Symbol) ?? { soma: 0, n: 0, snapshot: 0 };
    t.soma += r.finalFeesValueToken1;
    t.n += 1;
    if (r.receiptSource !== "onchain") t.snapshot += 1;
    porToken.set(r.token1Symbol, t);
  }
  if (porToken.size === 0) return null;
  return [...porToken]
    .map(
      ([simbolo, t]) =>
        `💰 Taxas recebidas no total: ${formatPrice(t.soma)} ${simbolo} em ${t.n} ${t.n === 1 ? "posição" : "posições"}` +
        (t.snapshot > 0 ? ` (${t.snapshot} com valor de snapshot, possivelmente defasado)` : "")
    )
    .join("\n");
}

export async function closedCommand(ctx: CommandContext<Context>) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const rows = await listClosedPositions(user.id);

  if (rows.length === 0) {
    await ctx.reply(
      "Nenhuma posição fechada registrada ainda. Posições V3 são registradas a partir da própria transação de fechamento; V4 só se houve um /positions antes de fechar — ver /status se uma posição sumiu sem aparecer aqui."
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

  const total = formatFeesTotal(rows);
  await ctx.reply(["Posições de LP fechadas:", "", ...blocks, ...(total ? [total] : [])].join("\n\n"));
}

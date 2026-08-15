import type { CommandContext, Context } from "grammy";
import type { Address } from "viem";
import { fetchPositionsForWallet } from "../../data/onchain/client.js";
import { formatBoundaryPrice, formatPrice } from "../../domain/lp-rebalance/format-reason.js";
import { isInRange, sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";

// Telegram limita mensagens a 4096 caracteres — corta e resume o excesso em
// vez de arriscar uma mensagem gigante (uma wallet pode ter dezenas).
const MAX_DISPLAYED = 20;

export async function positionsCommand(ctx: CommandContext<Context>) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  if (!user.walletAddress) {
    await ctx.reply("Nenhuma wallet vinculada ainda. Use /addwallet <endereço> primeiro.");
    return;
  }

  const positions = await fetchPositionsForWallet(user.walletAddress as Address);
  if (positions.length === 0) {
    await ctx.reply("Nenhuma posição de liquidez ativa encontrada nessa wallet em Arbitrum (Uniswap V3).");
    return;
  }

  const lines = positions.slice(0, MAX_DISPLAYED).map((p) => {
    const inRange = isInRange(p.currentTick, p.tickLower, p.tickUpper);
    const low = formatBoundaryPrice(p.tickLower, p.token0.decimals, p.token1.decimals);
    const high = formatBoundaryPrice(p.tickUpper, p.token0.decimals, p.token1.decimals);
    const current = formatPrice(sqrtPriceX96ToPrice(p.sqrtPriceX96, p.token0.decimals, p.token1.decimals));
    const status = inRange ? "✅" : "🚨";
    return `${status} ${p.token0.symbol}/${p.token1.symbol} ${(p.fee / 10000).toFixed(2)}% — faixa ${low}–${high}, atual ${current} ${p.token1.symbol} por ${p.token0.symbol} (#${p.tokenId})`;
  });

  const overflow =
    positions.length > MAX_DISPLAYED ? `\n\n... e mais ${positions.length - MAX_DISPLAYED} posição(ões).` : "";

  await ctx.reply([`Suas posições de LP em Arbitrum (${positions.length}):`, ...lines].join("\n") + overflow);
}

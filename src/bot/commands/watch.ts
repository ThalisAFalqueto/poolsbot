import type { CommandContext, Context } from "grammy";
import { getPoolById } from "../../data/defillama/client.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { watchPool } from "../../persistence/repositories/watched-pools.repository.js";

export async function watchCommand(ctx: CommandContext<Context>) {
  const poolId = ctx.match?.toString().trim();
  if (!poolId) {
    await ctx.reply("Uso: /watch <id>\nUse /find <chain> <symbol> para descobrir ids.");
    return;
  }

  const pool = await getPoolById(poolId);
  if (!pool) {
    await ctx.reply(`Pool "${poolId}" não encontrado na DefiLlama.`);
    return;
  }

  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const { isNew } = await watchPool(user.id, pool.pool, pool.chain);

  if (!isNew) {
    await ctx.reply(`Você já observa ${pool.project} — ${pool.symbol}. Use /alerts para ver as regras.`);
    return;
  }

  await ctx.reply(
    [
      `Observando ${pool.project} — ${pool.symbol} (${pool.chain}).`,
      "",
      "Alertas padrão criados:",
      "• Queda de APY ≥20% em 24h",
      "• Queda de TVL ≥20% em 24h",
      "",
      "Use /alerts para ver o estado, ou /unwatch para parar de observar.",
    ].join("\n")
  );
}

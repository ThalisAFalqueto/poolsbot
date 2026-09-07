import type { CommandContext, Context } from "grammy";
import { getPoolById } from "../../data/defillama/client.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { watchPool } from "../../persistence/repositories/watched-pools.repository.js";

export async function watchCommand(ctx: CommandContext<Context>) {
  const poolId = ctx.match?.toString().trim();
  if (!poolId) {
    await ctx.reply("Uso: /watch <id>\nPegue o id em /yield, ou em defillama.com/yields (ver /sites).");
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
    await ctx.reply(`Você já acompanha ${pool.project} — ${pool.symbol}.`);
    return;
  }

  await ctx.reply(
    [
      `Acompanhando ${pool.project} — ${pool.symbol} (${pool.chain}).`,
      "",
      "A partir de agora eu gravo o APY e o TVL dessa pool a cada 15min, e o histórico fica guardado — nenhum site faz isso pra você.",
      "",
      "Pra parar: /unwatch " + pool.pool,
    ].join("\n")
  );
}

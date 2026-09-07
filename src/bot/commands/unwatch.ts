import type { CommandContext, Context } from "grammy";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { unwatchPool } from "../../persistence/repositories/watched-pools.repository.js";

export async function unwatchCommand(ctx: CommandContext<Context>) {
  const poolId = ctx.match?.toString().trim();
  if (!poolId) {
    await ctx.reply("Uso: /unwatch <id>");
    return;
  }

  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const removed = await unwatchPool(user.id, poolId);

  await ctx.reply(
    removed
      ? "Parei de acompanhar essa pool. O histórico já gravado continua guardado."
      : "Você não observa esse pool."
  );
}

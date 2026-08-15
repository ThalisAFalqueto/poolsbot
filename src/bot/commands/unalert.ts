import type { CommandContext, Context } from "grammy";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { deleteRuleForUser } from "../../persistence/repositories/alert-rules.repository.js";

export async function unalertCommand(ctx: CommandContext<Context>) {
  const raw = ctx.match?.toString().trim();
  const alertId = raw ? Number(raw) : NaN;
  if (!raw || Number.isNaN(alertId)) {
    await ctx.reply("Uso: /unalert <id>\nUse /alerts para ver os ids.");
    return;
  }

  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const removed = await deleteRuleForUser(alertId, user.id);

  await ctx.reply(removed ? `Alerta #${alertId} removido.` : `Alerta #${alertId} não encontrado.`);
}

import type { CommandContext, Context } from "grammy";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { setPositionLabel } from "../../persistence/repositories/lp-positions.repository.js";

export async function labelPositionCommand(ctx: CommandContext<Context>) {
  const args = ctx.match?.toString().trim().split(/\s+/).filter(Boolean) ?? [];
  const [tokenId, ...nameParts] = args;
  const label = nameParts.join(" ");

  if (!tokenId || !label) {
    await ctx.reply(
      "Uso: /labelposition <tokenId> <nome>\nEx: /labelposition 5658859 p1\nPegue o tokenId em /positions (aparece como #123)."
    );
    return;
  }

  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const updated = await setPositionLabel(user.id, tokenId, label);

  await ctx.reply(
    updated
      ? `Posição #${tokenId} agora responde por "${label}" (ex: /graph ${label}).`
      : `Não achei a posição #${tokenId} vinculada a você — use /positions pra conferir o tokenId certo.`
  );
}

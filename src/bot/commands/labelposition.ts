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
  const updatedCount = await setPositionLabel(user.id, tokenId, label);

  if (updatedCount === 0) {
    await ctx.reply(`Não achei a posição #${tokenId} vinculada a você — use /positions pra conferir o tokenId certo.`);
    return;
  }

  // tokenId não é único sozinho (repete entre chains e entre V3/V4) — quando
  // bate em mais de uma, avisa em vez de deixar o usuário achar que rotulou só
  // a que ele tinha em mente.
  const ambiguityNote =
    updatedCount > 1 ? ` ATENÇÃO: ${updatedCount} posições suas têm esse mesmo tokenId (chains/protocolos diferentes) e todas receberam o apelido.` : "";
  await ctx.reply(`Posição #${tokenId} agora responde por "${label}" (ex: /graph ${label}).${ambiguityNote}`);
}

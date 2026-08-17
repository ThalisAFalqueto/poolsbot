import type { CommandContext, Context } from "grammy";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { listWallets } from "../../persistence/repositories/user-wallets.repository.js";

export async function walletsCommand(ctx: CommandContext<Context>) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const wallets = await listWallets(user.id);

  if (wallets.length === 0) {
    await ctx.reply("Nenhuma wallet vinculada ainda. Use /addwallet <endereço> primeiro.");
    return;
  }

  const lines = wallets.map((w) => {
    const since = w.createdAt.toLocaleDateString("pt-BR");
    return `• ${w.address}${w.label ? ` (${w.label})` : ""} — desde ${since}`;
  });

  await ctx.reply(["Suas wallets vinculadas:", ...lines, "", "Use /removewallet <endereço> pra desvincular uma."].join("\n"));
}

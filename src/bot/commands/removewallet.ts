import type { CommandContext, Context } from "grammy";
import { getAddress, isAddress } from "viem";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { removeWallet } from "../../persistence/repositories/user-wallets.repository.js";

export async function removeWalletCommand(ctx: CommandContext<Context>) {
  const raw = ctx.match?.toString().trim();
  if (!raw || !isAddress(raw)) {
    await ctx.reply("Uso: /removewallet <endereço>");
    return;
  }

  const address = getAddress(raw);
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const removed = await removeWallet(user.id, address);

  // As posições dessa wallet somem do /positions imediatamente (ele busca
  // fresh on-chain, nunca lê a lista salva) — o registro em lp_positions só
  // é limpo no próximo ciclo do job (até 15min), sem efeito visível pro
  // usuário nesse meio-tempo.
  await ctx.reply(removed ? `Wallet desvinculada: ${address}` : "Você não tinha essa wallet vinculada.");
}

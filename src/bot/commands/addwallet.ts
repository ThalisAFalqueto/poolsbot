import type { CommandContext, Context } from "grammy";
import { getAddress, isAddress } from "viem";
import { findOrCreateUserByTelegramChatId, setWalletAddress } from "../../persistence/repositories/users.repository.js";

export async function addWalletCommand(ctx: CommandContext<Context>) {
  const raw = ctx.match?.toString().trim();
  if (!raw || !isAddress(raw)) {
    await ctx.reply("Uso: /addwallet <endereço>\nEx: /addwallet 0x1234...5678\n\nSó o endereço público — nunca peça pra mim sua chave privada ou seed phrase.");
    return;
  }

  const address = getAddress(raw); // normaliza pro checksum EIP-55
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  await setWalletAddress(user.id, address);

  await ctx.reply(
    [
      `Wallet vinculada: ${address}`,
      "",
      "A partir do próximo ciclo (até 15min) vou monitorar suas posições de liquidez concentrada (Uniswap V3) em Arbitrum e avisar se alguma sair de range.",
      "Use /positions pra ver agora, sem esperar.",
    ].join("\n")
  );
}

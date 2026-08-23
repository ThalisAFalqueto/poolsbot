import type { CommandContext, Context } from "grammy";
import { getAddress, isAddress } from "viem";
import { chains, getActiveChains } from "../../config/chains.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { addWallet } from "../../persistence/repositories/user-wallets.repository.js";

export async function addWalletCommand(ctx: CommandContext<Context>) {
  const raw = ctx.match?.toString().trim() ?? "";
  const [rawAddress, ...labelParts] = raw.split(/\s+/).filter(Boolean);
  if (!rawAddress || !isAddress(rawAddress)) {
    await ctx.reply(
      "Uso: /addwallet <endereço> [rótulo]\nEx: /addwallet 0x1234...5678 principal\n\nSó o endereço público — nunca peça pra mim sua chave privada ou seed phrase. Você pode vincular mais de uma wallet."
    );
    return;
  }

  const address = getAddress(rawAddress); // normaliza pro checksum EIP-55
  const label = labelParts.length > 0 ? labelParts.join(" ") : undefined;
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const { wasNew } = await addWallet(user.id, address, label);

  if (!wasNew) {
    await ctx.reply(`Essa wallet já estava vinculada: ${address}`);
    return;
  }

  const activeChainNames = getActiveChains()
    .map((c) => chains[c].defillamaChainName)
    .join(", ");

  await ctx.reply(
    [
      `Wallet vinculada: ${address}${label ? ` (${label})` : ""}`,
      "",
      `A partir do próximo ciclo (até 15min) vou monitorar suas posições de liquidez concentrada (Uniswap V3/V4) em ${activeChainNames} e avisar se alguma sair de range.`,
      "Use /positions pra ver agora, sem esperar, ou /wallets pra listar suas wallets vinculadas.",
    ].join("\n")
  );
}

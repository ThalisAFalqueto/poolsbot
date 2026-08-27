import type { CommandContext, Context } from "grammy";
import { normalizePairKey } from "../../domain/market/pair-compare.js";
import { listWatchedPairs, unwatchPair, watchPair } from "../../persistence/repositories/market.repository.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";

// Lista de pares acompanhados no resumo diário, ALÉM dos que já vêm das
// posições do usuário (esses entram sozinhos, sem configurar nada).

const USAGE = ["Uso: /watchpair <par>", "Ex: /watchpair WETH-USDC", "", "Ver os acompanhados: /watchpair (sem argumento)."].join("\n");

export async function watchPairCommand(ctx: CommandContext<Context>) {
  const arg = ctx.match?.toString().trim();
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));

  if (!arg) {
    const pairs = await listWatchedPairs(user.id);
    await ctx.reply(
      pairs.length === 0
        ? ["Nenhum par acompanhado além dos que você tem em posição (esses entram sozinhos).", "", USAGE].join("\n")
        : [`Pares acompanhados (${pairs.length}):`, ...pairs.map((p) => `• ${p}`), "", "Remover: /unwatchpair <par>"].join("\n")
    );
    return;
  }

  // Guarda NORMALIZADO (símbolos ordenados) pra "WETH-USDC" e "USDC-WETH"
  // serem o mesmo par, e não duas entradas.
  const pairKey = normalizePairKey(arg);
  if (!pairKey) {
    await ctx.reply(["Não entendi esse par — precisa ser 2 tokens separados por hífen.", "", USAGE].join("\n"));
    return;
  }

  const { isNew } = await watchPair(user.id, pairKey);
  await ctx.reply(
    isNew
      ? `Passei a acompanhar ${pairKey}. Ele entra no resumo diário e no /comparar sem argumento.`
      : `${pairKey} já estava na sua lista.`
  );
}

export async function unwatchPairCommand(ctx: CommandContext<Context>) {
  const arg = ctx.match?.toString().trim();
  if (!arg) {
    await ctx.reply("Uso: /unwatchpair <par>\nEx: /unwatchpair WETH-USDC");
    return;
  }

  const pairKey = normalizePairKey(arg);
  if (!pairKey) {
    await ctx.reply("Não entendi esse par — precisa ser 2 tokens separados por hífen.");
    return;
  }

  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const removed = await unwatchPair(user.id, pairKey);
  await ctx.reply(
    removed
      ? `Parei de acompanhar ${pairKey}.`
      : `${pairKey} não estava na sua lista. Pares que vêm das suas posições não podem ser removidos por aqui — eles somem quando a posição é fechada e arquivada.`
  );
}

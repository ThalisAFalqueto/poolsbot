import type { CommandContext, Context } from "grammy";

export async function startCommand(ctx: CommandContext<Context>) {
  await ctx.reply(
    [
      "Poolsbot — monitoramento e otimização de pools DeFi.",
      "",
      "Comandos disponíveis:",
      "/find <chain> <symbol> — busca pools (ex: /find arbitrum USDC-ETH)",
      "/pool <id> — detalhes de um pool pelo id da DefiLlama",
    ].join("\n")
  );
}

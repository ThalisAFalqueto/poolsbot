import type { CommandContext, Context } from "grammy";

export async function startCommand(ctx: CommandContext<Context>) {
  await ctx.reply(
    [
      "Poolsbot — monitoramento e otimização de pools DeFi.",
      "",
      "Comandos disponíveis:",
      "/find <chain> <symbol> — busca pools (ex: /find arbitrum USDC-ETH)",
      "/pool <id> — detalhes de um pool pelo id da DefiLlama",
      "/watch <id> — observa um pool e cria alertas padrão (queda de APY/TVL ≥20% em 24h)",
      "/unwatch <id> — para de observar um pool",
      "/alerts — lista seus alertas e o estado atual",
      "/unalert <id> — remove um alerta",
    ].join("\n")
  );
}

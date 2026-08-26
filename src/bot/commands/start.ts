import type { CommandContext, Context } from "grammy";
import { chains, getActiveChains } from "../../config/chains.js";

export async function startCommand(ctx: CommandContext<Context>) {
  const activeChainNames = getActiveChains()
    .map((c) => chains[c].defillamaChainName)
    .join(", ");

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
      "/yield <chain> [symbol] [--min <apy%>] — ranking de pools por retorno ajustado a risco (piso padrão 36%/ano)",
      "/range <poolId> — sugere faixa de LP calibrada por volatilidade real ANTES de abrir a posição (Uniswap V3)",
      "/addwallet <endereço> [rótulo] — vincula uma wallet (pode vincular mais de uma; só endereço público, nunca chave privada)",
      "/wallets — lista suas wallets vinculadas",
      "/removewallet <endereço> — desvincula uma wallet",
      `/positions — mostra suas posições de LP em todas as wallets vinculadas (${activeChainNames}), se estão dentro da faixa, e o IL de cada uma`,
      "/status — saúde do bot: última execução de cada job automático e um resumo da sua conta",
      "/labelposition <tokenId> <nome> — dá um apelido curto pra uma posição (ex: /labelposition 5658859 p1)",
      "/graph [apelido ou tokenId] — imagem mostrando a faixa da posição vs. preço de entrada e atual (sem argumento, usa sua única posição)",
      "/closed — histórico de posições de LP já fechadas, com o P&L final de cada uma",
      "/mes [AAAA-MM] — resultado do mês pelo patrimônio total da carteira (já descontando gas e slippage); sem argumento, mês atual",
    ].join("\n")
  );
}

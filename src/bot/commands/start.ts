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
      "/sites — onde olhar pool na internet, e o que o bot faz melhor que eles",
      "/watch <id> — passa a gravar o histórico de APY/TVL de uma pool (/unwatch pra parar)",
      "/yield <chain> [par] [--min <%ao ano>] — pools de liquidez concentrada da chain, ranqueadas pelo que pagam DE VERDADE (medido on-chain) e por quanto a faixa dura (piso padrão 36%/ano)",
      "/range <poolId> — sugere faixa de LP calibrada por volatilidade real ANTES de abrir a posição (Uniswap V3)",
      "/addwallet <endereço> [rótulo] — vincula uma wallet (pode vincular mais de uma; só endereço público, nunca chave privada)",
      "/wallets — lista suas wallets vinculadas",
      "/removewallet <endereço> — desvincula uma wallet",
      `/positions — mostra suas posições de LP em todas as wallets vinculadas (${activeChainNames}), se estão dentro da faixa, e o IL de cada uma`,
      "/status — saúde do bot: última execução de cada job automático e um resumo da sua conta",
      "/labelposition <tokenId> <nome> — dá um apelido curto pra uma posição (ex: /labelposition 5658859 p1)",
      "/graph [apelido ou tokenId] — imagem mostrando a faixa da posição vs. preço de entrada e atual (sem argumento, usa sua única posição)",
      "/closed — histórico de posições de LP já fechadas, com o P&L final de cada uma",
      "/dia, /semana, /mes — resultado do período pelo patrimônio total da carteira (já descontando gas e slippage); aceitam data como argumento",
      "/comparar <par> — o mesmo par ranqueado entre chains pelo que cada pool paga DE VERDADE (medido on-chain, não o apyBase); sem argumento, usa os pares que você tem",
      "/explicacoes [assunto] — como cada conta do bot é feita: fórmula, exemplo com números reais e o que o número não diz",
      "/fechar <tokenId> abaixo <preço> acima <preço> — fecha a posição sozinho quando o preço bater no limite (o bot só sabe FECHAR, nunca abrir; os fundos vão direto pra sua wallet)",
      "/fechamentos — lista os gatilhos de fechamento armados",
      "/bordaalerta on|off — aviso quando o preço se aproxima da borda da sua faixa (desligado por padrão)",
    ].join("\n")
  );
}

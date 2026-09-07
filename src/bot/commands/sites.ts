import type { CommandContext, Context } from "grammy";

// Substitui os comandos removidos na limpeza de 07/09/2026.
//
// O critério da limpeza foi: fica o que o bot faz MELHOR que um site. Buscar
// pool, ver ficha de pool e ler regime de mercado, os sites fazem melhor e
// atualizam sozinhos. O que eles NÃO fazem é medir taxa por unidade de
// liquidez ativa e rodar backtest de largura — isso ficou (/yield, /range,
// /comparar).
//
// O aviso sobre a coluna de APR não é opinião: está medido. A pool ETH/USDC de
// $36M na Arbitrum aparece com 5,31% no app do Uniswap e 130%/ano quando medida
// do contrato pra uma faixa de ±3%. A diferença é o TVL no denominador, que
// inclui liquidez parada fora de faixa.
//
// Estado dos links conferido em 05/09/2026 — Snuggle.fi estava em manutenção.

export async function sitesCommand(ctx: CommandContext<Context>) {
  await ctx.reply(
    [
      "Onde olhar pool, e o que o bot faz melhor.",
      "",
      "ACHAR E CONFERIR POOL",
      "• defillama.com/yields — maior cobertura, filtra por chain e par",
      "• geckoterminal.com — volume e liquidez em tempo real, sem carteira",
      "• app.uniswap.org/explore/pools — dados oficiais",
      "",
      "MERCADO",
      "• defillama.com/dexs — volume agregado de DEXs",
      "",
      "SIMULAR FAIXA",
      "• revert.finance — analytics de posição LP",
      "• defi-lab.xyz — simulador de V3 com IL",
      "",
      "⚠️ CUIDADO COM A COLUNA DE APR",
      "Todos esses sites mostram taxa ÷ TVL. E TVL conta a liquidez que está longe do preço e não ganha nada.",
      "",
      "Exemplo real: a pool ETH/USDC de $36M na Arbitrum aparece com 5,31% no app do Uniswap. Medida do contrato, pra uma faixa de ±3%, paga 130%/ano.",
      "",
      "Use os sites pra ACHAR pool e conferir profundidade. Use o bot pra DECIDIR:",
      "  /yield <chain>    ranking pela taxa medida on-chain",
      "  /comparar <par>   pools do mesmo par, medidas",
      "  /range <id>       que largura rende mais, no histórico real",
      "",
      "Detalhe de cada conta: /explicacoes",
    ].join("\n")
  );
}

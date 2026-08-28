import type { CommandContext, Context } from "grammy";

// Texto FIXO explicando cada conta que o bot faz — pedido explícito do
// usuário (28/08/2026): "assim eu posso entender como chegamos em qualquer
// conta".
//
// Regras deste arquivo, que é o que o torna útil em vez de decorativo:
//   1. Toda fórmula aqui tem que bater LITERALMENTE com a implementação. Se
//      mudar o cálculo, muda o texto no mesmo commit — um texto desatualizado
//      aqui é pior que texto nenhum, porque parece autoridade.
//   2. Todo exemplo usa NÚMERO REAL já medido (posição do usuário, leitura
//      on-chain), nunca número inventado que fecha bonito.
//   3. Toda explicação termina no que o número NÃO diz. É onde mora o erro
//      de interpretação, não na fórmula.
//
// Texto puro, sem HTML: ctx.reply aqui não usa parse_mode, e tag crua na
// tela já aconteceu uma vez (resumo diário, 27/08).

type Topico = { chave: string; titulo: string; texto: string };

const TOPICOS: Topico[] = [
  {
    chave: "il",
    titulo: "IL — perda impermanente",
    texto: [
      "FÓRMULA",
      "  IL% = (valor da posição agora ÷ valor se você tivesse só segurado) − 1",
      "",
      "As duas cestas são avaliadas NO PREÇO DE AGORA. Essa é a parte que quase toda implementação erra: se você avaliar a cesta de entrada no preço de entrada, o IL zera artificialmente sempre.",
      "",
      "  cesta HODL = as quantidades de token que você depositou, valoradas hoje",
      "  cesta posição = as quantidades que a posição tem hoje, valoradas hoje",
      "",
      "As quantidades saem da liquidez L e da faixa, pelas fórmulas do Uniswap V3 — quando o preço anda, a pool troca automaticamente um token pelo outro, e você acaba com mais do que caiu e menos do que subiu.",
      "",
      "EXEMPLO REAL (sua posição V4, fechada em 27/08)",
      "  posição valia   $46,45",
      "  segurando valia $47,09",
      "  IL = 46,45 ÷ 47,09 − 1 = −1,35%  =  −$0,64",
      "",
      "O QUE ELE NÃO DIZ",
      "IL sozinho não é prejuízo. Ele é o que a pool te custou EM COMPARAÇÃO a não ter feito nada — e as taxas existem justamente pra pagar por ele. No seu caso as taxas foram $0,575 contra $0,637 de IL: quase empatou.",
      "",
      "Ele também não é permanente enquanto o preço puder voltar. Vira permanente quando você fecha.",
    ].join("\n"),
  },
  {
    chave: "pl",
    titulo: "P&L da posição",
    texto: [
      "FÓRMULA",
      "  P&L = valor atual + taxas ganhas − valor de entrada",
      "",
      "EXEMPLO REAL (sua posição V4, fechada em 27/08)",
      "  46,45 + 0,575 − 46,12 = +$0,90",
      "",
      "SÃO DUAS PERGUNTAS DIFERENTES, E ELAS NÃO SE MISTURAM",
      "",
      "1) Ganhei dinheiro?  →  P&L = +$0,90. Sim.",
      "2) Valeu a pena ter feito a pool?  →  compare com segurar:",
      "     pool:     46,45 + 0,575 = $47,03",
      "     segurar:                   $47,09",
      "     diferença:                 −$0,06",
      "",
      "O +$0,90 veio quase inteiro do BTC subir, não da pool. A pool em si empatou com não fazer nada.",
      "",
      "É por isso que o texto do /positions mostra os dois números. Um P&L positivo com IL alto pode significar que você só teve sorte na direção do preço.",
      "",
      "O QUE ELE NÃO DIZ",
      "Não desconta gas (ver /explicacoes gas) nem imposto. Pra o resultado que já desconta tudo, use /mes.",
    ].join("\n"),
  },
  {
    chave: "taxas",
    titulo: "Como suas taxas são calculadas",
    texto: [
      "Você não ganha uma fatia do VOLUME. Você ganha uma fatia proporcional à sua liquidez, entre quem está posicionado no preço de agora.",
      "",
      "FÓRMULA (é assim no contrato, não é aproximação)",
      "  suas taxas = (feeGrowthInside agora − feeGrowthInside quando você entrou) × sua liquidez",
      "",
      "feeGrowthInside é um contador que a pool mantém: quanto de taxa foi acumulado POR UNIDADE DE LIQUIDEZ dentro da sua faixa. Ele só anda enquanto o preço está dentro dela.",
      "",
      "SUA FATIA",
      "  fatia = sua liquidez ÷ liquidez ativa no preço atual",
      "",
      "EXEMPLO REAL (28/08, sua posição V3 #5674258)",
      "  sua liquidez         57.148.856",
      "  liquidez ativa V3    1.791.084.760.921",
      "  fatia                0,0032%",
      "",
      "Na V4 anterior, com capital e largura quase idênticos, sua fatia era 0,0124% — quase 4x maior, porque aquela pool tinha 3,7x menos liquidez amontoada no preço. A V3 compensa com mais volume, e no fim as duas pagaram quase a mesma coisa.",
      "",
      "O QUE ELE NÃO DIZ",
      "Nada disso conta enquanto você está fora de faixa: o contador simplesmente não anda. Duas posições com o mesmo capital e a mesma faixa rendem diferente só por causa de quanto tempo cada uma ficou dentro.",
    ].join("\n"),
  },
  {
    chave: "faixa",
    titulo: "Faixa sugerida (/range)",
    texto: [
      "PASSO 1 — medir o quanto o preço balança, do seu próprio histórico",
      "  para cada par de preços consecutivos:  r = ln(P2 ÷ P1) ÷ √Δt",
      "  σ = desvio-padrão desses r",
      "",
      "O ÷√Δt normaliza a cadência: o bot grava a cada 15min no ciclo normal e a cada 1h no backfill, e misturar as duas sem normalizar distorce o resultado. Intervalos maiores que 12h são descartados — são buraco de coleta (bot fora do ar), não movimento de preço.",
      "",
      "PASSO 2 — esticar pelo horizonte",
      "  move = σ × √(dias)",
      "  piso = P × e^(−move)      teto = P × e^(+move)",
      "",
      "√dias, não dias: dobrar o horizonte alarga ~41%, não 100%. É difusão, o mesmo motivo pelo qual um passeio aleatório se afasta com a raiz do tempo.",
      "",
      "EXEMPLO REAL (WBTC/USDC, 28/08)",
      "  σ = 1,67%/dia, medido sobre 1.108 pontos em 37 dias",
      "  3 dias:  move = 1,67% × √3 = 2,89%",
      "  piso = 79.254 × e^(−0,0289) = 77.274",
      "  teto = 79.254 × e^(+0,0289) = 81.285",
      "",
      "O e^(±move) em vez de ±move direto é porque preço é log-normal: ±3% simétrico em log é o que corresponde a uma faixa simétrica em tick, que é como o Uniswap enxerga.",
      "",
      "O QUE ELE NÃO DIZ",
      "±1σ cobre ~68% dos casos, mas isso é sobre ONDE O PREÇO TERMINA. Sua posição sai de faixa se ele ENCOSTAR na borda em qualquer momento — condição bem mais dura. Medido no seu histórico, uma faixa de 6,3% aguenta 3 dias em 83% das janelas, mas 7 dias em só 49%.",
      "",
      "E cripto tem cauda gorda: movimentos extremos são mais frequentes do que a curva normal prevê.",
    ].join("\n"),
  },
  {
    chave: "pool",
    titulo: "Quanto uma pool paga de verdade (/comparar)",
    texto: [
      "O apyBase da DefiLlama é taxa ÷ TVL. O problema: TVL conta TODA a liquidez da pool, inclusive a que está fora de faixa e não ganha nada. Você não divide taxa com o TVL — divide com quem está no preço de agora.",
      "",
      "FÓRMULA",
      "  1. taxa por unidade de liquidez, lida em dois blocos:",
      "     Δ = (feeGrowthGlobal no fim − no início) ÷ 2^128 ÷ 10^decimais",
      "  2. por dia:  Δ ÷ dias da janela  (a janela é de 3 dias)",
      "  3. liquidez de uma posição de referência de valor V e meia-largura δ:",
      "     L = V × 10^d1 ÷ (2√p × (1 − e^(−δ/2)))",
      "  4. diluição: quando você entra, as taxas passam a ser divididas com você",
      "     suas taxas = (taxa por L) × L_ativa × L ÷ (L_ativa + L)",
      "  5. APR = suas taxas × 365 ÷ V",
      "",
      "A referência é fixa em $1.000 numa faixa de ±3%. Tem que ser a MESMA nos dois lados: faixa mais estreita sempre dá APR maior, então comparar pools com larguras diferentes não compara nada.",
      "",
      "EXEMPLO REAL (WBTC-USDC, 28/08)",
      "  Arbitrum uni v3 0.3%    105%/ano   (DefiLlama dizia 16,2%)",
      "  Arbitrum uni v4 0.05%   102%/ano   (dizia 10,9%)",
      "  Arbitrum uni v3 0.05%   101%/ano   (dizia 24,1%)",
      "  Polygon  uni v3 0.3%     97%/ano   (dizia 30,1%)",
      "",
      "As quatro pagam quase igual — 9% de diferença entre a primeira e a última — enquanto o apyBase espalhava de 10,9% a 30,1%. Faz sentido: se uma pool do mesmo par pagasse muito mais por unidade de liquidez, os LPs migrariam pra lá até equilibrar.",
      "",
      "POR QUE O PASSO 4 EXISTE",
      "feeGrowthGlobal mede o que o pool pagou ENQUANTO VOCÊ NÃO ESTAVA LÁ. Sem o termo de diluição, um pool raso promete um retorno que morre no instante em que você entra. Caso real: um WETH-GMX com volume ~zero aparecia com 212%/ano — $1.000 ali seriam 91% da liquidez ativa. Com a diluição, caiu pra 19%.",
      "",
      "Na sua WBTC-USDC o termo quase não muda nada: $1.000 seriam 0,06% da liquidez. É assim que tem que ser — a correção só morde onde o pool é raso.",
      "",
      "O QUE ELE NÃO DIZ",
      "É o retorno ENQUANTO EM FAIXA — fora dela é zero. Não desconta IL nem gas. E é uma janela de 3 dias: as mesmas pools pagaram 40% menos em 20h do que na média dos 4 dias anteriores.",
    ].join("\n"),
  },
  {
    chave: "giro",
    titulo: "Giro (volume ÷ TVL)",
    texto: [
      "FÓRMULA",
      "  giro = volume negociado em 24h ÷ TVL do pool",
      "",
      "Quantas vezes por dia o capital da pool é negociado. Giro 1,0 = a pool movimentou o próprio tamanho em um dia.",
      "",
      "EXEMPLO REAL (28/08)",
      "  V3 0.05% Arbitrum: $11,4M ÷ $8,7M = 1,32",
      "  V4 0.05% Arbitrum: $2,2M ÷ $3,7M = 0,60",
      "",
      "O QUE ELE NÃO DIZ — E POR QUE ELE FOI REBAIXADO",
      "Giro divide por TVL, e TVL inclui a liquidez parada fora de faixa. Ele premia pool com liquidez espalhada, que é o oposto do que interessa.",
      "",
      "No exemplo acima o giro diz que a V3 é 2,2x melhor. Medindo on-chain, as duas pagam praticamente igual. O /comparar hoje só usa giro quando não consegue medir de verdade — e avisa quando é o caso. Ver /explicacoes pool.",
    ].join("\n"),
  },
  {
    chave: "gas",
    titulo: "Custo de gas e payback",
    texto: [
      "FÓRMULA",
      "  custo em ETH = gas usado × preço do gas   (lido da transação real, não estimado)",
      "  custo em USD = custo em ETH × preço do ETH",
      "",
      "O bot lê as transações de abertura e de fechamento e soma as duas.",
      "",
      "EXEMPLO REAL (sua posição V4)",
      "  abrir   0,0000077 ETH",
      "  fechar  0,0000034 ETH",
      "  total   0,0000111 ETH × $2.522 = $0,028",
      "  = 0,06% de uma posição de $46",
      "",
      "PAYBACK",
      "  dias até o gas se pagar = custo do gas ÷ taxa ganha por dia",
      "",
      "O QUE ELE NÃO DIZ",
      "O payback ASSUME que a posição fica em faixa o tempo todo. Fora de faixa a taxa por dia é zero e o payback não anda — o número é um piso otimista, não uma previsão.",
      "",
      "E o custo depende brutalmente da chain: essa mesma operação custa $20–50 na Ethereum. Numa posição de $46 isso mudaria a decisão inteira.",
    ].join("\n"),
  },
  {
    chave: "mes",
    titulo: "Resultado do mês (/mes)",
    texto: [
      "Este é o único número que mede TUDO, porque não enumera nada: olha só quanto patrimônio entrou e quanto saiu.",
      "",
      "FÓRMULA",
      "  P&L = patrimônio no fim − patrimônio no início − depósitos + saques",
      "",
      "Se o patrimônio subiu sem você ter aportado, foi lucro. Gas, slippage, taxa de swap, IL — tudo já está dentro, sem precisar somar item por item.",
      "",
      "RETORNO (Modified Dietz)",
      "  peso de cada fluxo = tempo que ele ficou aplicado ÷ duração do mês",
      "  capital médio = patrimônio inicial + Σ(fluxo × peso)",
      "  retorno = P&L ÷ capital médio",
      "",
      "Ponderar pelo tempo evita um erro grosseiro: dinheiro que entrou no dia 28 não teve o mês inteiro pra render. Aporte no dia 1 pesa 1; no último dia, ~0.",
      "",
      "EXEMPLO",
      "  início $1.000, aporte de $500 no meio do mês, fim $1.560",
      "  P&L = 1.560 − 1.000 − 500 = $60",
      "  capital médio = 1.000 + (500 × 0,5) = $1.250",
      "  retorno = 60 ÷ 1.250 = +4,8%",
      "",
      "Dividir por $1.500 daria 4,0% e subestimaria; por $1.000 daria 6,0% e exageraria.",
      "",
      "O QUE ELE NÃO DIZ",
      "Não separa o que veio de taxa do que veio do preço do token subir. Pra isso, /positions e /closed.",
    ].join("\n"),
  },
  {
    chave: "mercado",
    titulo: "Regime de mercado (/mercado)",
    texto: [
      "FÓRMULA — PERCENTIL",
      "  percentil = (dias com volume MENOR que o de hoje) ÷ (dias na janela)",
      "  janela = os 90 dias anteriores, EXCLUINDO o próprio dia comparado",
      "",
      "Excluir o dia é necessário: senão ele entra na própria distribuição e puxa o percentil pro meio.",
      "",
      "  percentil ≥ 0,70 → aquecido",
      "  percentil ≤ 0,30 → fraco",
      "  no meio          → normal",
      "",
      "FÓRMULA — SEMANA VS MÊS",
      "  razão = média de 7 dias ÷ média de 30 dias − 1",
      "  acima de +5% → acima da média;  abaixo de −5% → abaixo;  no meio → em linha",
      "",
      "EXEMPLO REAL (27/08)",
      "  média 7d $10,8B contra média 30d $7,2B → 'acima da média'",
      "  e ao mesmo tempo −23% de variação na semana",
      "",
      "O NOME É PROPOSITAL: isso é NÍVEL, não direção. Os dois números acima são verdadeiros ao mesmo tempo — patamar alto e caindo dia a dia. Chamar isso de 'tendência: subindo' seria o rótulo contradizendo os números ao lado.",
      "",
      "O QUE ELE NÃO DIZ",
      "Com menos de 30 dias de histórico o comando responde 'indisponível' em vez de chutar. E ele nunca mexe na sua meta — só informa.",
    ].join("\n"),
  },
  {
    chave: "yield",
    titulo: "Ranking do /yield",
    texto: [
      "O /yield lista só pools de LIQUIDEZ CONCENTRADA (Uniswap V3/V4), ranqueadas pelo que pagam de verdade — a mesma medição do /comparar (ver /explicacoes pool).",
      "",
      "POR QUE SÓ POOLS",
      "Medido na Arbitrum em 28/08: entre as 107 opções que passavam os filtros, o teto de tudo que NÃO é liquidez concentrada era 13,8%/ano — empréstimo 0–6%, renda fixa tokenizada 3–7%, GMX 4,7–13,8%, Pendle 1,3–10,9%. Longe da meta de 36%, e alcançável por caminhos bem mais simples.",
      "",
      "DUAS LISTAS, NÃO UMA",
      "  utilizáveis  — a faixa de ±3% dura pelo menos 1 dia",
      "  faixa curta  — dura menos que isso",
      "",
      "Isso existe porque ranquear só pelo retorno PREMIA PAR VOLÁTIL: volatilidade gera volume, volume gera taxa. O topo da lista virou um RAIN-USDT com 1781%/ano cuja faixa de ±3% dura 1 hora. Número verdadeiro, leitura mentirosa — fora de faixa o retorno é zero.",
      "",
      "A DURAÇÃO",
      "  σ = volatilidade do par, dos ticks amostrados em 9 blocos da janela",
      "  dias = (0,03 ÷ σ)²      ← a inversa do move = σ√t do /range",
      "",
      "EXEMPLO REAL (28/08)",
      "  RAIN-USDT   σ 13,9%/dia → ±3% dura ~1h",
      "  WBTC-USDC   σ  1,4%/dia → ±3% dura ~4,5 dias",
      "",
      "FILTROS DE SEGURANÇA (não ajustáveis pelo --min)",
      "  TVL ≥ $1.000.000        pool pequena é barata de manipular",
      "  APY ≤ 1,5x a média 30d  corta pico de wash trading",
      "",
      "O segundo continua valendo mesmo com o nível do apyBase errado: é uma razão do pool contra ele mesmo, então o viés de TVL se cancela nos dois lados.",
      "",
      "O QUE ELE NÃO DIZ",
      "A duração é quanto o preço leva pra ANDAR até a borda — encostar acontece antes, então é teto otimista. E nada aqui desconta IL, gas ou risco de chain.",
      "",
      "Não existe mais um 'score' multiplicativo. Ele existia pra ajustar o apy da DefiLlama por 5 fatores, e foi removido junto com a troca do critério: com o número medido em mãos, multiplicá-lo por fatores opacos só esconderia de onde veio a ordem.",
    ].join("\n"),
  },
];

function indice(): string {
  return [
    "Como cada conta do bot é feita. Escolha um assunto:",
    "",
    ...TOPICOS.map((t) => `  /explicacoes ${t.chave}${" ".repeat(Math.max(1, 10 - t.chave.length))}— ${t.titulo}`),
    "",
    "Cada um traz a fórmula, o que cada valor significa, um exemplo com números reais e — o mais importante — o que aquele número NÃO diz.",
  ].join("\n");
}

/** Casa por prefixo, não por igualdade: "/explicacoes taxa" tem que achar
 *  "taxas", e "/explicacoes IL" tem que funcionar com maiúscula. */
export function findTopico(arg: string): Topico | undefined {
  const q = arg.trim().toLowerCase();
  if (!q) return undefined;
  return TOPICOS.find((t) => t.chave === q) ?? TOPICOS.find((t) => t.chave.startsWith(q) || q.startsWith(t.chave));
}

export const TOPICO_CHAVES = TOPICOS.map((t) => t.chave);
export const TOPICOS_PARA_TESTE = TOPICOS;

export async function explicacoesCommand(ctx: CommandContext<Context>) {
  const arg = ctx.match?.toString().trim() ?? "";
  if (!arg) {
    await ctx.reply(indice());
    return;
  }

  const topico = findTopico(arg);
  if (!topico) {
    await ctx.reply([`Não tenho um verbete "${arg}".`, "", indice()].join("\n"));
    return;
  }

  await ctx.reply([topico.titulo.toUpperCase(), "", topico.texto].join("\n"));
}

// Recibo de fechamento de uma posição V3, montado a partir dos EVENTOS do
// NonfungiblePositionManager ao longo da vida inteira dela.
//
// POR QUE ISSO EXISTE (11/09/2026). O /closed montava o recibo com o snapshot
// `lastKnown*`, que só é gravado quando o usuário roda /positions. Tudo que
// acontecia entre o último /positions e o fechamento — preço andando, taxa
// acumulando — ficava de fora. Caso real, WETH/USDC #5683732:
//
//                   snapshot    chain
//     final           107,58   108,35
//     fees              1,57     1,86
//     P&L total        +0,99    +2,06
//
// A transação de fechamento já era localizada (pro gas) e depois descartada.
// Só que ela É o recibo: DecreaseLiquidity diz quanto principal saiu, Collect
// diz quanto saiu no total, e a diferença entre os dois é a taxa.

export type LiquidityEvent = {
  kind: "increase" | "decrease" | "collect";
  /** Unidades humanas (já divididas por 10^decimals). */
  amount0: number;
  amount1: number;
  /** Preço token1 por token0 no bloco do evento. */
  price: number;
  at: Date;
  txHash: string;
};

export type CloseReceipt = {
  openedAt: Date;
  closedAt: Date;
  /** Cada depósito valorado no preço DO SEU bloco — o que de fato entrou. */
  entryValueToken1: number;
  /** Cada retirada de principal valorada no preço do seu bloco. */
  finalPositionValueToken1: number;
  /** Taxa em quantidade de cada token: coletado − principal retirado. */
  feesAmount0: number;
  feesAmount1: number;
  /** Taxa valorada no preço do fechamento. */
  finalFeesValueToken1: number;
  /** As mesmas moedas depositadas, paradas na carteira até o fechamento. */
  hodlValueToken1: number;
  ilToken1: number;
  totalPnlToken1: number;
};

/**
 * collect − decrease pode sair ligeiramente negativo por arredondamento; isso
 * é zero. Negativo DE VERDADE significa principal que saiu da posição mas não
 * foi coletado — o recibo estaria incompleto, e aí o certo é não emitir.
 */
function taxaOuNull(diferenca: number, base: number): number | null {
  if (diferenca >= 0) return diferenca;
  return -diferenca <= Math.max(base, 1e-12) * 1e-6 ? 0 : null;
}

/**
 * Null quando os eventos não descrevem uma posição aberta E fechada (sem
 * depósito, sem retirada, sem coleta) ou quando falta coletar principal.
 * Quem chama cai no snapshot e o /closed avisa — nunca inventa um recibo.
 *
 * Taxas de coletas intermediárias são valoradas no preço do fechamento, não
 * no da coleta. A quantidade de cada token é exata; só a conversão pra token1
 * é aproximada nesse caso.
 */
export function calculateCloseReceipt(events: LiquidityEvent[]): CloseReceipt | null {
  const entradas = events.filter((e) => e.kind === "increase");
  const saidas = events.filter((e) => e.kind === "decrease");
  const coletas = events.filter((e) => e.kind === "collect");
  if (entradas.length === 0 || saidas.length === 0 || coletas.length === 0) return null;

  const soma = (xs: LiquidityEvent[], f: (e: LiquidityEvent) => number) => xs.reduce((s, e) => s + f(e), 0);
  const valor = (e: LiquidityEvent) => e.amount0 * e.price + e.amount1;
  const t = (e: LiquidityEvent) => e.at.getTime();

  const precoFechamento = [...saidas].sort((a, b) => t(a) - t(b)).at(-1)!.price;

  const saiu0 = soma(saidas, (e) => e.amount0);
  const saiu1 = soma(saidas, (e) => e.amount1);
  const fees0 = taxaOuNull(soma(coletas, (e) => e.amount0) - saiu0, saiu0);
  const fees1 = taxaOuNull(soma(coletas, (e) => e.amount1) - saiu1, saiu1);
  if (fees0 === null || fees1 === null) return null;

  const entryValueToken1 = soma(entradas, valor);
  const finalPositionValueToken1 = soma(saidas, valor);
  const finalFeesValueToken1 = fees0 * precoFechamento + fees1;
  const hodlValueToken1 = soma(entradas, (e) => e.amount0) * precoFechamento + soma(entradas, (e) => e.amount1);

  return {
    openedAt: new Date(Math.min(...entradas.map(t))),
    closedAt: new Date(Math.max(...[...saidas, ...coletas].map(t))),
    entryValueToken1,
    finalPositionValueToken1,
    feesAmount0: fees0,
    feesAmount1: fees1,
    finalFeesValueToken1,
    hodlValueToken1,
    ilToken1: finalPositionValueToken1 - hodlValueToken1,
    totalPnlToken1: finalPositionValueToken1 + finalFeesValueToken1 - entryValueToken1,
  };
}

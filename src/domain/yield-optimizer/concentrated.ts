// Quais protocolos são de LIQUIDEZ CONCENTRADA — e por que o /yield só olha
// pra eles.
//
// DECISÃO DO USUÁRIO (28/08/2026): "quero só pools."
//
// O que sustenta isso é o dado. Medido na Arbitrum no mesmo dia, entre as 107
// pools que passavam os filtros de segurança:
//   - empréstimo (Aave, Compound, Morpho, Fluid, Dolomite): 0% a 6,1%
//   - renda fixa tokenizada (BUIDL, Ondo, Spark, Sky):      3,2% a 7,2%
//   - contraparte de perp (GMX):                            4,7% a 13,8%
//   - Pendle:                                               1,3% a 10,9%
// O TETO de tudo que NÃO é liquidez concentrada era 13,8% — bem longe dos 36%
// da meta de 3%/mês, e alcançável por caminhos bem mais simples que DeFi.
//
// Só liquidez concentrada entrega isso — e era justamente o que o /yield
// descartava, porque filtrava pelo apyBase da DefiLlama (taxa ÷ TVL), que
// subestima posição concentrada em ~4x. A pool em que ele estava marcava
// 23,3% na DefiLlama e 101%/ano medida: reprovava no piso de 36%.
// Ver domain/market/fee-per-liquidity.ts.

/**
 * Protocolos de liquidez concentrada que o bot sabe MEDIR on-chain.
 *
 * Deliberadamente curto. Cada entrada aqui é a afirmação de que
 * measurePoolYields consegue localizar o pool e ler feeGrowthGlobal dele —
 * não é uma lista de "protocolos parecidos com Uniswap".
 *
 * NÃO estão aqui, e o motivo importa:
 *   - pancakeswap-amm / camelot-v3 — são de liquidez concentrada de verdade
 *     (fork do V3 e Algebra), mas exigem endereço de factory próprio por
 *     chain, e endereço não entra no código sem conferência on-chain.
 *   - curve-dex, camelot-v2, fluid-dex — AMM, mas não concentrado: a
 *     liquidez cobre a curva inteira, e aí o apyBase da DefiLlama já é o
 *     número certo (toda a liquidez trabalha).
 */
export const MEASURABLE_CONCENTRATED_PROJECTS = ["uniswap-v3", "uniswap-v4"] as const;

/**
 * Protocolos de liquidez concentrada que o bot RECONHECE mas não mede.
 * Existem pra poder dizer "achei N pools desse tipo e não consegui medir" em
 * vez de fingir que elas não existem.
 */
export const UNMEASURED_CONCENTRATED_PROJECTS = ["pancakeswap-amm", "camelot-v3", "sushiswap-v3", "quickswap-dex"] as const;

export function isMeasurableConcentrated(project: string): boolean {
  return (MEASURABLE_CONCENTRATED_PROJECTS as readonly string[]).includes(project);
}

export function isConcentrated(project: string): boolean {
  return isMeasurableConcentrated(project) || (UNMEASURED_CONCENTRATED_PROJECTS as readonly string[]).includes(project);
}

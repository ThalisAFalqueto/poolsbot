import { isMeasurableConcentrated } from "./concentrated.js";

// Quando confiar no `outlier` da DefiLlama, e quando ignorá-lo.
//
// O flag existe porque a DefiLlama detecta APY estatisticamente estranho, e
// filtrar por ele protege contra pool manipulada. O problema é que ele é
// derivado do MESMO apyBase que já sabemos não servir pra posição concentrada
// (taxa ÷ TVL, com o TVL incluindo liquidez fora de faixa — ver
// domain/market/fee-per-liquidity.ts). Numa pool concentrada esse número é
// ruidoso por construção, então ser marcado outlier ali diz mais sobre a
// métrica da DefiLlama do que sobre a pool.
//
// O ESTRAGO ERA GRANDE, medido em 05/09/2026. Pools de liquidez concentrada
// barradas SÓ pelo flag, que passariam em todo o resto:
//
//     Arbitrum   8 pools,  $60M de TVL   (a maior: WETH-USDC v3 0.05%, $36,1M)
//     Base      21 pools, $171M          (a maior: WETH-USDC v3 0.3%, $116,7M)
//     Polygon    1 pool,    $1M
//
// Na Base, MAIS DA METADE das pools concentradas estava escondida — incluindo
// as maiores e mais líquidas de ETH, exatamente as que interessam.
//
// A regra: pra pool que o bot MEDE on-chain, a nossa medição vale mais que a
// suspeita da DefiLlama, e o flag é ignorado. Pra todo o resto — onde o número
// que mostramos vem deles — o flag continua valendo, porque aí é a única
// defesa que temos.
//
// A segurança não fica órfã: o piso de TVL (isEligiblePool), o corte de pico
// contra a própria média de 30 dias, e a duração da faixa continuam de pé. E
// pool marcada outlier só aparece se a medição on-chain de fato tiver
// funcionado — se falhar, ela some junto com as outras não medidas.

export type OutlierCheckable = { project: string; outlier: boolean };

/**
 * A pool deve ser descartada por ser outlier?
 *
 * Falso quando o bot consegue medir a pool sozinho — nesse caso o julgamento
 * da DefiLlama é sobre um número que nem usamos.
 */
export function shouldDropAsOutlier(pool: OutlierCheckable): boolean {
  if (!pool.outlier) return false;
  return !isMeasurableConcentrated(pool.project);
}

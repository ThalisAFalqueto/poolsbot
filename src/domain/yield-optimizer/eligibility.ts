import type { RankablePool } from "../pools/types.js";

// Abaixo disso, mesmo com bom score, a pool fica vulnerável a manipulação
// de preço barata: a Chaos Labs mediu que manipular o TWAP de 30min de um
// pool real custa entre 37% e 155% do TVL, dependendo de quantos blocos o
// atacante controla — $1M de piso já exige ~$370k-$1.5M pro ataque mais
// barato. Diferente do TVL_FULL_TRUST_USD em score.ts (que só suaviza o
// score entre esse ponto e a saturação, sem nunca excluir), este é um
// corte BINÁRIO: pools abaixo nem aparecem no ranking.
export const MIN_TVL_USD = 1_000_000;

// Corte contra APY inflado (wash trading, pico transitório de volume): se
// o valor ATUAL passa de 1.5x a própria média de 30 dias do pool, é
// tratado como não confiável e excluído — mais forte que o
// stabilityFactor em score.ts, que só penaliza (suave) sem nunca excluir,
// deixando picos passarem se o resto do score for bom o bastante. Só
// corta quando apyMean30d existe e é positivo; dado ausente não vira
// exclusão (mesmo tratamento neutro dado a sigma ausente em score.ts).
export const MAX_APY_VS_MEAN30D_RATIO = 1.5;

export function isEligiblePool(pool: RankablePool): boolean {
  if (pool.tvlUsd < MIN_TVL_USD) return false;
  if (pool.apyMean30d !== null && pool.apyMean30d > 0 && pool.apy > pool.apyMean30d * MAX_APY_VS_MEAN30D_RATIO) {
    return false;
  }
  return true;
}

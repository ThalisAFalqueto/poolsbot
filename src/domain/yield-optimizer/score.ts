import type { RankablePool } from "../pools/types.js";

// TVL a partir do qual o fator de liquidez satura em 1.0 (sem penalidade).
// Abaixo disso, o fator cai linearmente até 0 — pools minúsculos já são
// excluídos como outlier antes de chegar aqui, isso só suaviza o intervalo
// intermediário (pools pequenos mas legítimos).
const TVL_FULL_TRUST_USD = 500_000;

// Penalidade fixa de 15% pra pools com risco categórico de IL sinalizado
// pela DefiLlama — mesmo proxy simplificado usado no motor de alertas (v1),
// já que não temos a posição real do usuário pra calcular IL de verdade.
const IL_RISK_PENALTY = 0.85;

function tvlFactor(tvlUsd: number): number {
  return Math.min(1, tvlUsd / TVL_FULL_TRUST_USD);
}

function ilFactor(ilRisk: string): number {
  return ilRisk === "yes" ? IL_RISK_PENALTY : 1;
}

// sigma é o desvio-padrão histórico do APY que a DefiLlama calcula. Quanto
// maior, mais imprevisível o retorno — 1/(1+sigma) decai suavemente sem
// exigir uma constante de peso arbitrária. sigma ausente não penaliza nem
// beneficia (mesmo tratamento neutro dado a il7d ausente no v1).
function volatilityFactor(sigma: number | null): number {
  if (sigma === null) return 1;
  return 1 / (1 + sigma);
}

// O sinal mais importante contra APYs infladas: quanto o valor ATUAL diverge
// da própria média de 30 dias do pool. Um pool com apy=461% e apyMean30d=45%
// está reportando um pico transitório (ex: um dia de volume/arbitragem fora
// do padrão num par ilíquido), não um retorno sustentável — mesmo que o
// número em si seja real (não seja um "outlier" estatístico da DefiLlama).
// Só penaliza picos ACIMA da média; não recompensa estar abaixo dela.
function stabilityFactor(apy: number, apyMean30d: number | null): number {
  if (apyMean30d === null || apy <= 0) return 1;
  return Math.min(1, apyMean30d / apy);
}

export type ScoredPool = RankablePool & { score: number };

export function computeRiskAdjustedScore(pool: RankablePool): number {
  return (
    pool.apy *
    tvlFactor(pool.tvlUsd) *
    ilFactor(pool.ilRisk) *
    volatilityFactor(pool.sigma) *
    stabilityFactor(pool.apy, pool.apyMean30d)
  );
}

export function rankByRiskAdjustedYield(pools: RankablePool[]): ScoredPool[] {
  return pools
    .map((pool) => ({ ...pool, score: computeRiskAdjustedScore(pool) }))
    .sort((a, b) => b.score - a.score);
}

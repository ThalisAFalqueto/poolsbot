// Shape mínima e desacoplada da DefiLlamaPool — domain/ não depende do
// formato específico de nenhuma fonte de dados (mesmo princípio já usado em
// domain/alerts/types.ts com PoolSnapshot).
export type RankablePool = {
  poolId: string;
  chain: string;
  project: string;
  symbol: string;
  apy: number;
  tvlUsd: number;
  ilRisk: string;
  sigma: number | null;
  apyMean30d: number | null;
};

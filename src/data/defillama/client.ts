const YIELDS_ENDPOINT = "https://yields.llama.fi/pools";

export type DefiLlamaPool = {
  pool: string; // id do pool na DefiLlama (uuid)
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number;
  apyPct1D: number | null;
  apyPct7D: number | null;
  apyPct30D: number | null;
  stablecoin: boolean;
  ilRisk: string;
  il7d: number | null; // geralmente null na prática, mas presente pra alguns pools
  sigma: number | null; // desvio-padrão histórico do APY — quanto menor, mais estável/previsível
  apyMean30d: number | null; // média de APY dos últimos 30 dias — usado pra detectar picos transitórios
  outlier: boolean; // sinalizado pela própria DefiLlama como estatisticamente não confiável
};

type YieldsResponse = {
  status: string;
  data: DefiLlamaPool[];
};

let cache: { pools: DefiLlamaPool[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchAllPools(): Promise<DefiLlamaPool[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.pools;
  }

  const res = await fetch(YIELDS_ENDPOINT);
  if (!res.ok) {
    throw new Error(`DefiLlama request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as YieldsResponse;
  cache = { pools: json.data, fetchedAt: Date.now() };
  return json.data;
}

export async function getPoolById(poolId: string): Promise<DefiLlamaPool | undefined> {
  const pools = await fetchAllPools();
  return pools.find((p) => p.pool === poolId);
}

export async function searchPools(params: {
  chain?: string;
  project?: string;
  symbol?: string;
  limit?: number;
  includeOutliers?: boolean;
}): Promise<DefiLlamaPool[]> {
  const pools = await fetchAllPools();
  const { chain, project, symbol, limit = 10, includeOutliers = false } = params;

  return pools
    .filter((p) => !chain || p.chain.toLowerCase() === chain.toLowerCase())
    .filter((p) => !project || p.project.toLowerCase().includes(project.toLowerCase()))
    .filter((p) => !symbol || p.symbol.toLowerCase().includes(symbol.toLowerCase()))
    .filter((p) => includeOutliers || !p.outlier)
    .sort((a, b) => b.apy - a.apy)
    .slice(0, limit);
}

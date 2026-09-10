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
  apyBase7d: number | null; // APY base assumindo faixa de concentração padrão (0.3%/0.001%) — não é a faixa real
  outlier: boolean; // sinalizado pela própria DefiLlama como estatisticamente não confiável
  volumeUsd1d: number | null; // volume de trade das últimas 24h — null em pools que não são DEX (ex: staking)
  volumeUsd7d: number | null; // volume de trade dos últimos 7d — null em pools que não são DEX (ex: staking)
  poolMeta: string | null; // pra Uniswap V3: rótulo do fee tier, ex: "0.05%" (não o valor numérico 500 que o contrato usa)
  underlyingTokens: string[] | null; // endereços dos tokens do par — null em pools que não são de 2 tokens
};

type YieldsResponse = {
  status: string;
  data: DefiLlamaPool[];
};

let cache: { pools: DefiLlamaPool[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchYields(url: string): Promise<YieldsResponse> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DefiLlama request failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as YieldsResponse;
  } catch {
    throw new Error(`DefiLlama resposta não é JSON válido: "${text.slice(0, 100)}"`);
  }
}

export async function fetchAllPools(): Promise<DefiLlamaPool[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.pools;
  }

  let json: YieldsResponse;
  try {
    json = await fetchYields(YIELDS_ENDPOINT);
  } catch (err) {
    // Visto ao vivo em 21/08/2026: o Cloudflare na frente da DefiLlama às
    // vezes serve, com status 200, um corpo cacheado indevidamente (o texto
    // literal "GET,HEAD" — parece ser um corpo de erro 405 armazenado por
    // engano) pra URL exata sem query string. Um cache-buster na query
    // evita esse cache específico — confirmado manualmente antes de
    // escrever isso, funciona de forma consistente. Só 1 retry: se falhar
    // de novo, é outro problema, deixa propagar.
    console.error("[defillama] 1ª tentativa falhou, tentando de novo com cache-buster:", err);
    json = await fetchYields(`${YIELDS_ENDPOINT}?_cb=${Date.now()}`);
  }

  cache = { pools: json.data, fetchedAt: Date.now() };
  return json.data;
}

export async function getPoolById(poolId: string): Promise<DefiLlamaPool | undefined> {
  const pools = await fetchAllPools();
  return pools.find((p) => p.pool === poolId);
}

/** Os 4 fee tiers padrão do Uniswap V3, em pips (o valor que o contrato usa). */
const FEE_TIERS = new Set([100, 500, 3000, 10000]);

// poolMeta da DefiLlama pra pools Uniswap V3 vem como o rótulo do fee tier
// (ex: "0.05%"), não o valor numérico bruto que o contrato usa (500). Só
// cobre os 4 fee tiers padrão do Uniswap V3 — qualquer outro rótulo (ou
// poolMeta ausente/de outro protocolo) retorna null, deixando quem chama
// decidir como lidar (não finge um fee tier que não foi confirmado).
//
// A CONVERSÃO É NUMÉRICA, não uma tabela de rótulos. Era uma tabela, e a
// DefiLlama escreve o MESMO tier das duas formas: no mesmo instante (10/09/2026)
// havia "0.3%" numa pool da Base e "0.30%" na WBTC-USDC 0,30% da Arbitrum. Só
// "0.3%" estava na tabela, então a segunda virava null e a pool sumia em
// silêncio de /yield, /comparar e do histórico de preço — sem erro, apenas uma
// pool a menos na lista.
export function parseFeeTierLabel(poolMeta: string | null): number | null {
  if (!poolMeta) return null;
  const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(poolMeta.trim());
  if (!m) return null;
  // Arredonda porque 0.05 * 10000 dá 500.0000000000001 em ponto flutuante.
  const pips = Math.round(Number(m[1]) * 10_000);
  return FEE_TIERS.has(pips) ? pips : null;
}

// A API da DefiLlama não expõe o endereço do pool on-chain diretamente —
// só chain + project + poolMeta (fee tier) + underlyingTokens (endereços
// dos 2 tokens). Pra achar o pool de uma posição que já lemos on-chain
// (ver /positions), casa por esses 4 campos — mesmo critério inverso do
// usado nos scripts de backfill (lá vai poolId->endereço via getPoolInfo,
// aqui vai endereços on-chain->poolId da DefiLlama). Comparação
// case-insensitive: underlyingTokens vem em minúsculas na prática, mas não
// é garantido, e Address (viem) vem checksummed.
function findUniswapPool(
  pools: DefiLlamaPool[],
  project: "uniswap-v3" | "uniswap-v4",
  defillamaChainName: string,
  fee: number,
  tokenA: string,
  tokenB: string
): DefiLlamaPool | undefined {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return pools.find((p) => {
    if (p.chain.toLowerCase() !== defillamaChainName.toLowerCase()) return false;
    if (p.project !== project) return false;
    if (parseFeeTierLabel(p.poolMeta) !== fee) return false;
    if (!p.underlyingTokens || p.underlyingTokens.length < 2) return false;
    const addrs = p.underlyingTokens.map((t) => t.toLowerCase());
    return addrs.includes(a) && addrs.includes(b);
  });
}

export function findUniswapV3Pool(
  pools: DefiLlamaPool[],
  defillamaChainName: string,
  fee: number,
  tokenA: string,
  tokenB: string
): DefiLlamaPool | undefined {
  return findUniswapPool(pools, "uniswap-v3", defillamaChainName, fee, tokenA, tokenB);
}

// Mesmo critério de findUniswapV3Pool, só trocando o project — achado real
// (Fase A): o mesmo par pode ter pool V3 E V4 com o mesmo fee tier na
// mesma chain (ex: WBTC/USDC 0.05% na Arbitrum), então NUNCA usar
// findUniswapV3Pool pra uma posição V4 (casaria com os números do pool V3
// errado) nem o inverso.
export function findUniswapV4Pool(
  pools: DefiLlamaPool[],
  defillamaChainName: string,
  fee: number,
  tokenA: string,
  tokenB: string
): DefiLlamaPool | undefined {
  return findUniswapPool(pools, "uniswap-v4", defillamaChainName, fee, tokenA, tokenB);
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

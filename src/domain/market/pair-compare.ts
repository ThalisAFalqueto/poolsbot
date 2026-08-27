// Comparação do MESMO par de tokens entre chains — "existe lugar melhor pra
// fazer o que eu já faço?".
//
// Por que casar por SÍMBOLO e não por endereço: dentro de uma chain, endereço
// é a chave certa (é o que findUniswapV3Pool/findUniswapV4Pool usam). Mas o
// mesmo token tem CONTRATO DIFERENTE em cada chain — o USDC da Arbitrum não é
// o da Polygon. Cross-chain, o símbolo é a única chave viável. Isso traz o
// risco de casar coisas parecidas mas distintas, contido pelo mapa de
// apelidos mínimo abaixo.

export type ComparablePool = {
  poolId: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  volumeUsd1d: number | null;
  apyBase: number | null;
  apy: number;
  poolMeta: string | null;
};

export type ComparedPool = ComparablePool & {
  /** volume 24h / TVL — quanto o capital do pool "gira" por dia. */
  turnover: number | null;
  /** A chain está entre as que o bot consegue monitorar de verdade? */
  isMonitorable: boolean;
};

// Apelidos: MESMO ativo com nome diferente entre chains/protocolos.
// Deliberadamente minúsculo — cada entrada aqui é uma afirmação de que dois
// símbolos são intercambiáveis, e errar isso mistura pools diferentes no mesmo
// ranking. Mesmo espírito de stablecoins.ts ("lista pequena e explícita, não
// um oráculo").
//
// NÃO entram aqui, de propósito:
//   USDC.e / USDbC — são pontes, contrato e liquidez distintos do USDC nativo
//   WBTC / cbBTC / tBTC — custódias diferentes, risco diferente
//   USDT / USDC — stablecoins distintas, não são o mesmo ativo
const SYMBOL_ALIASES: Record<string, string> = {
  WETH: "ETH",
  "USD₮0": "USDT",
};

function canonicalSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return SYMBOL_ALIASES[upper] ?? upper;
}

// "WBTC-USDC" e "usdc-wbtc" viram a mesma chave. A ordenação é o que torna a
// comparação insensível à ordem em que cada protocolo lista o par.
export function normalizePairKey(pairSymbol: string): string | null {
  const parts = pairSymbol
    .split("-")
    .map((s) => canonicalSymbol(s))
    .filter((s) => s.length > 0);

  // Só pares. Pools de 3+ ativos (curve-style) não são comparáveis com o que o
  // bot faz, e um símbolo de 1 token não identifica par nenhum.
  if (parts.length !== 2) return null;
  return [...parts].sort().join("-");
}

export function comparePoolsForPair(
  pools: ComparablePool[],
  pairKey: string,
  monitorableChains: string[]
): ComparedPool[] {
  const monitorable = new Set(monitorableChains.map((c) => c.toLowerCase()));

  return pools
    .filter((p) => normalizePairKey(p.symbol) === pairKey)
    .map((p) => ({
      ...p,
      // null (e não 0) quando não dá pra calcular: a DefiLlama às vezes não
      // reporta volume, e 0 seria indistinguível de "pool parado".
      turnover: p.volumeUsd1d !== null && p.tvlUsd > 0 ? p.volumeUsd1d / p.tvlUsd : null,
      isMonitorable: monitorable.has(p.chain.toLowerCase()),
    }));
}

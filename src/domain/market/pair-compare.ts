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
  /** Endereços dos 2 tokens — necessários pra localizar o pool on-chain e
   *  medir o que ele paga de verdade. null em pools que não são de 2 tokens. */
  underlyingTokens: string[] | null;
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

// ---------------------------------------------------------------------
// Ranking. Duas réguas diferentes, e a distinção é o ponto:
//
//   MEDIDO   — taxa por unidade de liquidez lida do contrato, convertida no
//              retorno de uma posição de referência. É o que decide de fato
//              quanto você ganha (ver domain/market/fee-per-liquidity.ts).
//   ESTIMADO — giro (volume/TVL) da DefiLlama. Só entra pra pools que não
//              dá pra medir (chain sem RPC, protocolo fora do Uniswap V3/V4).
//
// Nunca ordenar os dois grupos juntos por um mesmo número: são grandezas
// diferentes, e misturá-las num ranking só é a origem do erro que isso veio
// corrigir. Medidos primeiro, estimados depois, rotulados.

export type PoolMeasurementLike = {
  aprInRange: number;
  perLiquidityPerDay: number;
  days: number;
  /** Líquido depois do custo de LVR. null quando σ não foi medido. */
  netApr?: number | null;
};

export type RankedPool<M extends PoolMeasurementLike> = ComparedPool & { measured: M | null };

export function rankPools<M extends PoolMeasurementLike>(
  pools: ComparedPool[],
  measurements: Map<string, M>
): RankedPool<M>[] {
  return pools
    .map((p) => ({ ...p, measured: measurements.get(p.poolId) ?? null }))
    .sort((a, b) => {
      // Ordena pelo LÍQUIDO quando existe — receita bruta premiava par volátil
      // duas vezes (mais volume E mais arbitragem contra você).
      if (a.measured && b.measured) {
        const an = a.measured.netApr ?? null;
        const bn = b.measured.netApr ?? null;
        if (an !== null && bn !== null) return bn - an;
        if (an !== null) return -1;
        if (bn !== null) return 1;
        return b.measured.aprInRange - a.measured.aprInRange;
      }
      if (a.measured) return -1;
      if (b.measured) return 1;
      return (b.turnover ?? -1) - (a.turnover ?? -1);
    });
}

/**
 * Razão entre o melhor e o pior retorno MEDIDO. Null com menos de 2 medições.
 *
 * Serve pra decidir o que dizer: quando as pools do mesmo par pagam quase
 * igual (razão perto de 1), "qual pool escolher" é uma pergunta menos
 * importante que "que largura de faixa usar" — e o texto precisa dizer isso
 * em vez de fingir que o 1º lugar é uma recomendação forte. Medido em
 * 28/08/2026 no WBTC-USDC: 4 pools medidas entre 96,6% e 104,9% (razão 1,09),
 * enquanto o apyBase da DefiLlama pras mesmas 4 ia de 10,9% a 30,1%.
 */
export function measuredSpread<M extends PoolMeasurementLike>(ranked: RankedPool<M>[]): number | null {
  const aprs = ranked.filter((p) => p.measured).map((p) => p.measured!.aprInRange);
  if (aprs.length < 2) return null;
  const min = Math.min(...aprs);
  if (min <= 0) return null;
  return Math.max(...aprs) / min;
}

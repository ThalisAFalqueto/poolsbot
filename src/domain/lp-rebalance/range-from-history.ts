// Faixa sugerida a partir do HISTÓRICO DE PREÇO REAL que o bot guarda, em vez
// da janela que o oráculo do pool por acaso consegue servir.
//
// POR QUE ISSO EXISTE — o método anterior tinha um viés sistemático:
//
// O oráculo do Uniswap V3 guarda observações num buffer CIRCULAR de tamanho
// fixo. Quanto MAIS negociado o pool, mais rápido as posições antigas são
// sobrescritas e MENOR fica o alcance histórico. A cascata de janelas
// (7d→24h→6h→…) usava a primeira que respondesse, ou seja: a base de cálculo
// era escolhida por DISPONIBILIDADE, não por qualidade.
//
// O resultado é perverso em duas frentes:
//   1. quanto mais o preço se move (pool ativo), menos tempo eu observava, e
//      mais ESTREITA saía a faixa — exatamente o contrário do que deveria;
//   2. duas pools acabavam comparadas em bases diferentes (uma com 7 dias,
//      outra com 4 horas) sem que isso ficasse visível.
//
// Medido ao vivo em 27/08/2026, no WBTC/USDC 0.05% da Arbitrum: o oráculo
// alcançava 4,9h e a faixa sugerida saiu com 2,0% de largura — mas a
// volatilidade diária real do par, medida sobre 37 dias do nosso banco, é
// 1,67%. Uma faixa de 2% não sobrevive um dia.
//
// Aqui a base é o `pool_price_history` (backfill + ingestão de 15min), e a
// saída SEMPRE declara sobre quantos dias foi estimada.

export type PricePoint = { recordedAt: Date; price: number };

/** Abaixo disso a estimativa é ruído de amostra pequena. */
export const MIN_POINTS = 24;
/** Retornos com intervalo maior que isso são buraco de coleta (bot fora do ar),
 *  não movimento contínuo — entram distorcendo a volatilidade pra cima. */
export const MAX_GAP_DAYS = 0.5;
/**
 * Ponto a menos disso do anterior é LEITURA DUPLICADA, não movimento: dois
 * writers (ou um backfill gravado por cima da ingestão) lendo o mesmo pool com
 * segundos de diferença. Normalizado por √Δt, um Δt minúsculo amplifica a
 * diferença entre as duas leituras — e preço idêntico entra como retorno zero,
 * puxando o σ pra baixo. Medido em 11/09/2026: 360 pares assim no WBTC/USDC
 * inflavam o σ de 2,26% pra 2,79%/dia (+23%), e o /range desenha a faixa
 * proporcional ao σ. A maioria veio de um backfill rodado sem filtro — ver
 * domain/market/price-gaps.ts, que impede isso na escrita.
 */
export const MIN_INTERVAL_DAYS = 5 / 1440;

export type VolatilityEstimate = {
  /** Desvio-padrão do retorno logarítmico diário (0.0167 = 1,67% ao dia). */
  dailyVolatility: number;
  observedDays: number;
  pointCount: number;
};

export type RangeForHorizon = {
  horizonDays: number;
  low: number;
  high: number;
  /** Largura total da faixa, em fração do preço (0.058 = 5,8%). */
  widthPct: number;
};

// Normaliza cada retorno pelo intervalo real entre as amostras (√Δt) — a
// coleta não é perfeitamente regular (15min no ciclo normal, 1h no backfill do
// Dune, e buracos quando o bot ficou fora do ar). Sem normalizar, misturar
// cadências infla ou desinfla a volatilidade dependendo do que predominar.
export function estimateVolatility(history: PricePoint[]): VolatilityEstimate | null {
  if (history.length < MIN_POINTS) return null;

  const sorted = [...history].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const returns: number[] = [];

  // Cada retorno é medido contra o último ponto ACEITO, não contra o vizinho
  // imediato: ponto colado no anterior é descartado inteiro (a âncora fica),
  // em vez de só perder o retorno minúsculo e deixar o ponto duplicado
  // contaminar o retorno seguinte.
  let anchor = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i]!;
    const deltaDays = (curr.recordedAt.getTime() - anchor.recordedAt.getTime()) / 86_400_000;
    if (deltaDays < MIN_INTERVAL_DAYS) continue;
    const prev = anchor;
    anchor = curr;
    if (deltaDays > MAX_GAP_DAYS) continue;
    if (prev.price <= 0 || curr.price <= 0) continue;
    returns.push(Math.log(curr.price / prev.price) / Math.sqrt(deltaDays));
  }

  if (returns.length < MIN_POINTS) return null;

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return {
    dailyVolatility: Math.sqrt(variance),
    observedDays: (last.recordedAt.getTime() - first.recordedAt.getTime()) / 86_400_000,
    pointCount: sorted.length,
  };
}

// Largura pra um HORIZONTE: quanto tempo você quer que a faixa aguente antes
// de o preço sair dela. Escala com √t (difusão) — dobrar o horizonte NÃO dobra
// a largura necessária, aumenta ~41%.
//
// `sigmas` controla a margem: 1 desvio cobre ~68% dos cenários no horizonte,
// 2 cobrem ~95%. Faixa mais larga sai de range menos, mas concentra menos
// liquidez e rende menos taxa — o trade-off central de uma posição
// concentrada, e uma decisão do usuário, não do bot.
// `currentPrice` vem de FORA (leitura on-chain ao vivo), não do último ponto
// do histórico. A separação é essencial: o histórico serve pra medir
// VOLATILIDADE, mas pode estar desatualizado — o do pool V3 aqui parou quando
// o usuário migrou a posição pro V4, e centrar a faixa na última cotação
// gravada produziu uma faixa que NÃO CONTINHA o preço atual (bug pego em
// 27/08/2026: preço $80.474, faixa sugerida $75.573–$78.457).
export function rangeForHorizon(
  estimate: VolatilityEstimate,
  currentPrice: number,
  horizonDays: number,
  sigmas = 1
): RangeForHorizon {
  const move = estimate.dailyVolatility * Math.sqrt(horizonDays) * sigmas;
  // Multiplicativo (não aditivo): preço é log-normal, e ±x% simétrico em
  // porcentagem é o que corresponde a uma faixa simétrica em tick.
  const low = currentPrice * Math.exp(-move);
  const high = currentPrice * Math.exp(move);
  return { horizonDays, low, high, widthPct: high / low - 1 };
}

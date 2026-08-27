import { MAX_TICK, MIN_TICK, roundToSpacing } from "./price-math.js";
import type { SuggestedRange } from "./types.js";

export type VolatilityWindow = { windowSeconds: number; checkpointCount: number };

// Cascata de janelas tentadas em ordem — a mais longa dá uma estimativa
// mais representativa quando disponível (cobre mais regimes de mercado),
// mas nem todo pool guarda histórico suficiente: depende de quão
// movimentado ele é (um pool ativo "gasta" o buffer de observações do
// oráculo mais rápido em tempo real, mesmo com a mesma capacidade de
// slots — validado contra pools reais: uma pool WETH/LINK pouco
// movimentada na Arbitrum guardava ~7 dias, uma pool WETH/USDC mais
// ativa na Base guardava só ~6-24h). Cada tentativa custa 1 chamada de
// RPC, independente da janela ou de quantos checkpoints.
// Cascata do maior pro menor: usa a primeira janela que o oráculo do pool
// consegue servir. Janela longa é melhor (mais amostra, menos ruído), mas nem
// todo pool alcança.
//
// Por que existem janelas CURTAS aqui — e por que isso não é preciosismo:
// o buffer do oráculo do Uniswap V3 tem tamanho FIXO (observationCardinality)
// e é circular. Um pool MUITO ativo sobrescreve as posições antigas rápido, e
// aí o alcance histórico dele encolhe. Medido ao vivo (27/08/2026) no
// WBTC/USDC 0.05% da Arbitrum: $10M de volume/dia, cardinality 1000, e o
// oráculo só alcançava ~4,9 HORAS — abaixo da menor janela que existia aqui
// (6h), então o /range não conseguia calibrar num dos pools mais líquidos da
// chain e devolvia "sem histórico", o que sugeria pool parado quando era o
// oposto.
//
// O piso é 2h de propósito: abaixo disso a amostra vira ruído de curtíssimo
// prazo, e extrapolar isso pra largura de faixa produziria uma posição
// apertada demais, que sai de range no primeiro movimento. Preferimos cair no
// heurístico a sugerir uma faixa perigosa.
export const VOLATILITY_WINDOWS: VolatilityWindow[] = [
  { windowSeconds: 7 * 24 * 3600, checkpointCount: 12 },
  { windowSeconds: 24 * 3600, checkpointCount: 12 },
  { windowSeconds: 6 * 3600, checkpointCount: 12 },
  { windowSeconds: 4 * 3600, checkpointCount: 12 },
  { windowSeconds: 2 * 3600, checkpointCount: 12 },
];

// ---------------------------------------------------------------------
// Margem de segurança adicionada em cada lado do range observado.
//
// Direção inspirada em Fukasawa, Maire & Wunsch (arXiv:2309.08431),
// δ* = 4γ/(8π − σ²): a largura ótima de uma posição concentrada CRESCE
// com o custo de rebalancear (γ) e com a variância do preço (σ²), e CAI
// com a taxa de fee do pool (π) — quanto mais a pool paga por
// concentração, mais compensa ficar apertado e rebalancear com mais
// frequência.
//
// Isso NÃO é uma implementação literal da fórmula do paper: replicar o
// δ* exato exigiria normalizar γ e σ² nas mesmas unidades de
// tempo/valor do modelo contínuo deles, o que os dados discretos do
// oráculo TWAP não sustentam sem mais estudo (ver documento de
// estratégia). O que é replicado com fidelidade é (a) a DIREÇÃO
// comprovada de cada alavanca e (b) o "8" interno, que pondera fee
// contra variância dentro do mesmo parênteses do paper — o "4" externo
// foi removido de propósito porque cancela exatamente quando se calcula
// uma RAZÃO contra um cenário de referência, que é a abordagem usada
// aqui: em vez de tentar produzir o δ* absoluto em unidades não
// verificadas, calculamos o quanto o cenário real se desvia de um
// cenário "típico" (fee tier comum, custo de gas típico, volatilidade
// moderada) e aplicamos essa razão em cima da margem de 20% que já
// estava em produção — assim o comportamento anterior continua sendo o
// centro, não um salto para um número não calibrado.
const DEFAULT_MARGIN_FRACTION = 0.2;
const MIN_MARGIN_FRACTION = 0.05;
const MAX_MARGIN_FRACTION = 0.6;

// Âncoras do cenário de referência — não são medidas, são escolhas de
// calibração para manter 20% como ponto central num caso "típico":
// fee tier de 0.05% (comum em pares major/stable), custo de rebalance
// ~0.2% do valor da posição, volatilidade equivalente a ~100 ticks de
// desvio padrão entre checkpoints consecutivos (pool moderadamente
// ativo).
const REFERENCE_GAS_COST_FRACTION = 0.002;
const REFERENCE_FEE_RATE = 0.0005;
const REFERENCE_TICK_STDDEV = 100;

const TICK_LOG_STEP = Math.log(1.0001); // 1 tick ≈ essa fração de log-preço
const REFERENCE_VARIANCE = (REFERENCE_TICK_STDDEV * TICK_LOG_STEP) ** 2;
const REFERENCE_VALUE = REFERENCE_GAS_COST_FRACTION / (8 * REFERENCE_FEE_RATE - REFERENCE_VARIANCE);

function feeRateFromTier(fee: number): number {
  return fee / 1_000_000; // unidades Uniswap: fee=3000 -> 0.003 (0.3%)
}

function sampleStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Variância do log-preço por intervalo de checkpoint, a partir da
// dispersão das DIFERENÇAS entre ticks médios consecutivos — usar os
// níveis brutos misturaria tendência de preço (drift) com oscilação
// (volatilidade), que é o que a fórmula quer medir.
function priceVarianceFromIntervalTicks(intervalTicks: number[]): number {
  if (intervalTicks.length < 2) return 0;
  const diffs = intervalTicks.slice(1).map((t, i) => t - intervalTicks[i]!);
  const tickStdDev = sampleStdDev(diffs);
  const logStdDev = tickStdDev * TICK_LOG_STEP;
  return logStdDev * logStdDev;
}

function costBenefitValue(gasCostFraction: number, feeRate: number, variance: number): number {
  const denominator = 8 * feeRate - variance;
  // Piso pra evitar denominador ~0 ou negativo — caso degenerado do
  // paper (pool volátil demais pra compensar o fee tier, σ² >= 8π), onde
  // a fórmula original não tem ótimo bem definido. Em vez de estourar
  // pra infinito/negativo, satura no comportamento de "margem máxima" via
  // o clamp final.
  const denominatorFloor = 8 * REFERENCE_FEE_RATE * 0.05;
  return gasCostFraction / Math.max(denominator, denominatorFloor);
}

// gasCostFraction: custo estimado de rebalance como fração do valor
// atual da posição (ex: 0.001 = 0.1%). null quando não dá pra estimar
// (par sem WETH pra converter o custo de gas, ou preço de gas
// indisponível no ciclo) — nesse caso assume o custo de referência
// (fator neutro), deixando fee tier e volatilidade reais ajustarem a
// margem mesmo assim.
export function computeMarginFraction(gasCostFraction: number | null, fee: number, intervalTicks: number[]): number {
  const feeRate = feeRateFromTier(fee);
  const variance = priceVarianceFromIntervalTicks(intervalTicks);
  const actualGasCostFraction = gasCostFraction ?? REFERENCE_GAS_COST_FRACTION;

  const actualValue = costBenefitValue(actualGasCostFraction, feeRate, variance);
  const ratio = actualValue / REFERENCE_VALUE;
  const margin = DEFAULT_MARGIN_FRACTION * ratio;

  return Math.min(MAX_MARGIN_FRACTION, Math.max(MIN_MARGIN_FRACTION, margin));
}

// secondsAgos em ORDEM DECRESCENTE terminando em 0 (mais antigo primeiro),
// formato exigido pelo observe() do Uniswap V3.
export function buildSecondsAgos(windowSeconds: number, checkpointCount: number): number[] {
  const secondsAgos: number[] = [];
  for (let i = 0; i <= checkpointCount; i++) {
    secondsAgos.push(Math.round((windowSeconds * (checkpointCount - i)) / checkpointCount));
  }
  return secondsAgos;
}

// observe() retorna tickCumulative EM CADA checkpoint solicitado (não o
// tick instantâneo naquele momento) — a diferença entre dois checkpoints
// consecutivos, dividida pelo intervalo de tempo entre eles, dá o tick
// MÉDIO nesse sub-intervalo. secondsAgos e tickCumulatives têm o mesmo
// tamanho e correspondência posicional (saída de fetchTickCumulatives).
export function intervalAverageTicks(tickCumulatives: readonly bigint[], secondsAgos: number[]): number[] {
  const averages: number[] = [];
  for (let i = 0; i < tickCumulatives.length - 1; i++) {
    const tickCumDelta = tickCumulatives[i + 1]! - tickCumulatives[i]!;
    const timeDelta = secondsAgos[i]! - secondsAgos[i + 1]!; // secondsAgos decrescente -> positivo
    if (timeDelta <= 0) continue; // checkpoints degenerados (não deveria acontecer com buildSecondsAgos)
    averages.push(Number(tickCumDelta) / timeDelta);
  }
  return averages;
}

// Sugere uma faixa que cobre o range de preço REALMENTE observado na
// janela (mínimo–máximo dos ticks médios por intervalo), com margem de
// segurança calibrada por custo/benefício (ver computeMarginFraction) —
// não é um modelo estatístico completo (nem desvio padrão puro, nem
// intervalo de confiança formal), é "onde o preço andou de verdade, mais
// uma folga que reage a custo de gas, fee tier e volatilidade reais".
// Inclui o tick atual na amostra, pra nunca sugerir uma faixa que já
// nasce fora do preço agora (ex: pool muito parado na janela, mas o
// preço se moveu logo antes do checkpoint mais recente).
export function suggestVolatilityRange(
  intervalTicks: number[],
  currentTick: number,
  fee: number,
  tickSpacing: number,
  gasCostFraction: number | null
): SuggestedRange {
  const spacing = tickSpacing;
  const allTicks = [...intervalTicks, currentTick];
  const minTick = Math.min(...allTicks);
  const maxTick = Math.max(...allTicks);
  const width = maxTick - minTick;
  const marginFraction = computeMarginFraction(gasCostFraction, fee, intervalTicks);
  const margin = width * marginFraction;

  let newLower = roundToSpacing(minTick - margin, spacing);
  let newUpper = roundToSpacing(maxTick + margin, spacing);

  if (newLower === newUpper) newUpper = newLower + spacing; // largura degenerada (pool sem movimento na janela)
  newLower = Math.max(newLower, MIN_TICK);
  newUpper = Math.min(newUpper, MAX_TICK);

  return { tickLower: newLower, tickUpper: newUpper };
}

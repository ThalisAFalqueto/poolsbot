import { MAX_TICK, MIN_TICK, roundToSpacing, tickSpacingForFee } from "./price-math.js";
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
export const VOLATILITY_WINDOWS: VolatilityWindow[] = [
  { windowSeconds: 7 * 24 * 3600, checkpointCount: 12 },
  { windowSeconds: 24 * 3600, checkpointCount: 12 },
  { windowSeconds: 6 * 3600, checkpointCount: 12 },
];

// Margem adicionada em cada lado do range observado (mínimo–máximo) antes
// de virar a faixa sugerida — cobrir exatamente o que já foi visto
// historicamente significa que qualquer novo extremo, por menor que seja,
// já rompe de novo. 20% é uma folga arbitrária mas razoável, não um valor
// calibrado estatisticamente.
export const SAFETY_MARGIN_FRACTION = 0.2;

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
// segurança — não é um modelo estatístico (nem desvio padrão, nem
// intervalo de confiança), é "onde o preço andou de verdade, mais uma
// folga". Inclui o tick atual na amostra, pra nunca sugerir uma faixa que
// já nasce fora do preço agora (ex: pool muito parado na janela, mas o
// preço se moveu logo antes do checkpoint mais recente).
export function suggestVolatilityRange(intervalTicks: number[], currentTick: number, fee: number): SuggestedRange {
  const spacing = tickSpacingForFee(fee);
  const allTicks = [...intervalTicks, currentTick];
  const minTick = Math.min(...allTicks);
  const maxTick = Math.max(...allTicks);
  const width = maxTick - minTick;
  const margin = width * SAFETY_MARGIN_FRACTION;

  let newLower = roundToSpacing(minTick - margin, spacing);
  let newUpper = roundToSpacing(maxTick + margin, spacing);

  if (newLower === newUpper) newUpper = newLower + spacing; // largura degenerada (pool sem movimento na janela)
  newLower = Math.max(newLower, MIN_TICK);
  newUpper = Math.min(newUpper, MAX_TICK);

  return { tickLower: newLower, tickUpper: newUpper };
}

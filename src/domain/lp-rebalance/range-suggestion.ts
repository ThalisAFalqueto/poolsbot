import { MAX_TICK, MIN_TICK, roundToSpacing } from "./price-math.js";
import type { SuggestedRange } from "./types.js";

// Heurística: replica a MESMA LARGURA da posição atual (em ticks),
// recentralizada no tick atual, arredondada para o tickSpacing do fee tier.
//
// Trade-off consciente: uma recentralização simétrica não protege contra uma
// tendência direcional contínua do preço — se o preço está subindo de forma
// sustentada, a nova faixa pode sair de range de novo no próximo ciclo. Uma
// alternativa ("range skewing" na direção do movimento recente) exigiria uma
// janela de preços históricos que o v3 não coleta (leitura on-chain é sempre
// do estado atual). Simetria é auto-contida, previsível de explicar ao
// usuário, e não pretende ser estratégia ótima — é só uma sugestão de
// largura equivalente; a decisão de quando/como executar é do usuário.
export function suggestRange(currentTick: number, tickLower: number, tickUpper: number, tickSpacing: number): SuggestedRange {
  const spacing = tickSpacing;
  const width = tickUpper - tickLower;
  const halfWidth = width / 2;

  let newLower = roundToSpacing(currentTick - halfWidth, spacing);
  let newUpper = roundToSpacing(currentTick + halfWidth, spacing);

  if (newLower === newUpper) newUpper = newLower + spacing; // largura degenerada: garante >= 1 spacing
  newLower = Math.max(newLower, MIN_TICK);
  newUpper = Math.min(newUpper, MAX_TICK);

  return { tickLower: newLower, tickUpper: newUpper };
}

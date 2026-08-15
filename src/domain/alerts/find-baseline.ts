import type { PoolSnapshot } from "./types.js";

// history deve estar ordenado ascendente por recordedAt.
// Retorna o snapshot mais recente com recordedAt <= targetTime, ou null se
// não houver nenhum (pool observado há menos tempo que a janela pedida).
export function findClosestBefore(history: PoolSnapshot[], targetTime: Date): PoolSnapshot | null {
  let best: PoolSnapshot | null = null;
  for (const snap of history) {
    if (snap.recordedAt.getTime() <= targetTime.getTime()) {
      best = snap;
    } else {
      break;
    }
  }
  return best;
}

import type { Signal } from "../domain/signals/types.js";

// Stub da camada de execução do MVP não-custodial: nunca assina nem envia
// transações. A Fase 2 custodial substitui/complementa isto por um executor
// real (ex: execution/onchain-executor.ts) que consome o mesmo tipo Signal.
export function executeSignal(signal: Signal): void {
  console.log(`[noop-executor] Sinal recebido, nenhuma ação executada:`, {
    type: signal.type,
    poolId: signal.poolId,
    suggestedAction: signal.suggestedAction,
  });
}

export type SignalType = "rebalance_lp" | "yield_opportunity" | "risk_alert";

export type SuggestedAction =
  | { kind: "none" }
  | { kind: "move_range"; params: { newTickLower: number; newTickUpper: number } }
  | { kind: "reallocate"; params: { fromPoolId: string; toPoolId: string } };

// Contrato central que separa a camada de decisão (domain/) da camada de
// execução (execution/). No MVP só é consumido por notifications/; a Fase 2
// custodial adiciona um novo consumidor que executa suggestedAction on-chain,
// sem precisar mudar como os sinais são gerados.
export type Signal = {
  type: SignalType;
  userId: string;
  poolId: string;
  reason: string;
  suggestedAction: SuggestedAction;
  confidence: number; // 0-1
  createdAt: Date;
};

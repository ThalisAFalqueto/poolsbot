import type { Address } from "viem";
import type { ChainKey } from "../../config/chains.js";
import type { GasCostEstimate } from "./estimate-gas-cost.js";

export type TokenMeta = { address: Address; decimals: number; symbol: string };

export type OnchainPosition = {
  chain: ChainKey;
  walletAddress: Address;
  tokenId: bigint;
  poolAddress: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  token0: TokenMeta;
  token1: TokenMeta;
};

export type PositionRangeStatus = "in_range" | "out_of_range";

export type PositionState = {
  status: PositionRangeStatus;
  outOfRangeSince: Date | null;
  lastNotifiedAt: Date | null;
};

export type SuggestedRange = { tickLower: number; tickUpper: number };

// "volatility": calibrada por movimento de preço real observado on-chain
// (ver domain/lp-rebalance/volatility-range.ts), com a janela usada.
// "heuristic": caiu pro espelhamento de largura simples (range-suggestion.ts)
// porque o pool não tinha histórico de preço suficiente pra nenhuma janela
// tentada — sempre disponível, nunca falha.
export type PositionRangeSuggestion = {
  range: SuggestedRange;
  source: "volatility" | "heuristic";
  volatilityWindowSeconds: number | null;
};

export type EvaluatePositionInput = {
  position: OnchainPosition;
  state: PositionState;
  now: Date;
  // null quando a posição está in_range (não vai ser usado) ou quando o
  // job optou por não buscar o preço de gas nesse ciclo/chain.
  gasCost: GasCostEstimate | null;
  // null quando a posição está in_range (não vai ser usado). Quando fora
  // de range, o job sempre consegue calcular algo (heuristic é garantido).
  suggestedRange: PositionRangeSuggestion | null;
};

export type PositionNotification = {
  kind: "out_of_range" | "reminder" | "back_in_range";
  reason: string;
  confidence: number;
};

export type EvaluatePositionOutput = {
  nextState: PositionState;
  notification: PositionNotification | null;
};

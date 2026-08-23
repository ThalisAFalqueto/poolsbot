import type { Address } from "viem";
import type { ChainKey } from "../../config/chains.js";
import type { GasCostEstimate } from "./estimate-gas-cost.js";

export type TokenMeta = { address: Address; decimals: number; symbol: string };

export type OnchainPosition = {
  chain: ChainKey;
  walletAddress: Address;
  tokenId: bigint;
  protocol: "v3" | "v4";
  // V3: endereço real do contrato do pool. V4: NÃO existe contrato de pool
  // próprio (arquitetura singleton, ver client-v4.ts) — esse campo guarda o
  // PoolId (bytes32, mesmo formato hex de endereço) nesse caso, decisão
  // deliberada pra reaproveitar as tabelas pool_price_history/
  // pool_volume_history (chaveadas por chain+poolAddress) sem coluna nova.
  // Nunca tratar como um endereço chamável pra posições V4.
  poolAddress: Address;
  fee: number;
  // Sempre populado explicitamente na origem (V3: via tickSpacingForFee(fee);
  // V4: lido direto do PoolKey, onde é independente do fee) — evita
  // qualquer código downstream tentar derivar de `fee` de novo, o que
  // lançaria erro pra fee tiers que não são um dos 4 padrão do V3.
  tickSpacing: number;
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

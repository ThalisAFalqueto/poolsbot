import type { Address } from "viem";

export type TokenMeta = { address: Address; decimals: number; symbol: string };

export type OnchainPosition = {
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

export type EvaluatePositionInput = {
  position: OnchainPosition;
  state: PositionState;
  now: Date;
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

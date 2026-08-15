import type { ImpermanentLossResult } from "./calculate-il.js";

export type CalculatePnlInput = {
  il: ImpermanentLossResult;
  entryPriceToken1: number; // sqrtPriceX96ToPrice(baseline.sqrtPriceX96, decimals0, decimals1)
  currentPriceToken1: number; // sqrtPriceX96ToPrice(current.sqrtPriceX96, decimals0, decimals1)
  feesAmount0: number; // unidades humanas (já /10^decimals0)
  feesAmount1: number;
};

export type PnlResult = {
  entryValueToken1: number; // composição de entrada valorada no preço DE ENTRADA
  hodlValueToken1: number; // composição de entrada valorada no preço ATUAL (= il.hodlValueToken1)
  positionValueToken1: number; // composição atual valorada no preço ATUAL (= il.positionValueToken1)
  feesValueToken1: number; // fees coletáveis valoradas no preço atual
  priceMovementToken1: number; // hodl - entry: efeito PURO de preço, isolado do IL
  ilToken1: number; // position - hodl: IL em valor absoluto (não %)
  principalPnlToken1: number; // position - entry (= priceMovement + il)
  totalPnlToken1: number; // principal + fees
};

export function calculatePnl(input: CalculatePnlInput): PnlResult {
  const { il, entryPriceToken1, currentPriceToken1, feesAmount0, feesAmount1 } = input;

  const entryValueToken1 = il.baselineAmount0 * entryPriceToken1 + il.baselineAmount1;
  const feesValueToken1 = feesAmount0 * currentPriceToken1 + feesAmount1;

  const priceMovementToken1 = il.hodlValueToken1 - entryValueToken1;
  const ilToken1 = il.positionValueToken1 - il.hodlValueToken1;
  const principalPnlToken1 = il.positionValueToken1 - entryValueToken1;

  return {
    entryValueToken1,
    hodlValueToken1: il.hodlValueToken1,
    positionValueToken1: il.positionValueToken1,
    feesValueToken1,
    priceMovementToken1,
    ilToken1,
    principalPnlToken1,
    totalPnlToken1: principalPnlToken1 + feesValueToken1,
  };
}

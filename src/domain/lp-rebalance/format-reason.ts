import type { ImpermanentLossResult } from "./calculate-il.js";
import { sqrtPriceX96ToPrice, tickToPrice } from "./price-math.js";
import { suggestRange } from "./range-suggestion.js";
import type { OnchainPosition, PositionNotification } from "./types.js";

// toFixed(2) é suficiente pros pares "comuns" (ETH/USDC, WBTC/USDC etc.) mas
// perde precisão pra pares de baixo valor unitário (ex: 0.0000001234) — fora
// de escopo do v3, formatação dinâmica por magnitude fica pra depois.
export function formatPrice(value: number): string {
  return value.toFixed(2);
}

// Detecção por MAGNITUDE do preço, não por proximidade do tick ao MIN/MAX
// absoluto: posições full-range produzem preços astronômicos (~1e50), mas o
// mesmo acontece com ranges muito largos e assimétricos (ex: só um lado no
// limite, o outro não) — suggestRange pode reproduzir esse problema ao
// espelhar a largura de uma posição desse tipo. Checar a magnitude do
// resultado final cobre os dois casos sem depender de quão perto do tick
// absoluto o valor está.
const DISPLAY_PRICE_UPPER_BOUND = 1e15;
const DISPLAY_PRICE_LOWER_BOUND = 1e-15;

export function formatBoundaryPrice(tick: number, decimals0: number, decimals1: number): string {
  const price = tickToPrice(tick, decimals0, decimals1);
  if (!Number.isFinite(price) || price >= DISPLAY_PRICE_UPPER_BOUND) return "∞";
  if (price <= DISPLAY_PRICE_LOWER_BOUND) return "0";
  return formatPrice(price);
}

function formatFee(fee: number): string {
  return `${(fee / 10000).toFixed(2)}%`;
}

function header(position: OnchainPosition): string {
  return `${position.token0.symbol}/${position.token1.symbol} ${formatFee(position.fee)} (Uniswap V3, Arbitrum)`;
}

function rangeLine(position: OnchainPosition): string {
  const low = formatBoundaryPrice(position.tickLower, position.token0.decimals, position.token1.decimals);
  const high = formatBoundaryPrice(position.tickUpper, position.token0.decimals, position.token1.decimals);
  return `Faixa da posição: ${low} – ${high} ${position.token1.symbol} por ${position.token0.symbol}`;
}

function currentPriceLine(position: OnchainPosition): string {
  const price = sqrtPriceX96ToPrice(position.sqrtPriceX96, position.token0.decimals, position.token1.decimals);
  return `Preço atual: ${formatPrice(price)} ${position.token1.symbol} por ${position.token0.symbol}`;
}

function suggestedRangeLine(position: OnchainPosition): string {
  const suggested = suggestRange(position.currentTick, position.tickLower, position.tickUpper, position.fee);
  const low = formatBoundaryPrice(suggested.tickLower, position.token0.decimals, position.token1.decimals);
  const high = formatBoundaryPrice(suggested.tickUpper, position.token0.decimals, position.token1.decimals);
  return `Faixa sugerida: ${low} – ${high} ${position.token1.symbol} por ${position.token0.symbol}`;
}

const CALL_TO_ACTION = "Use /positions para ver todas as suas posições.";

export function formatOutOfRangeReason(position: OnchainPosition): string {
  return [
    header(position),
    rangeLine(position),
    currentPriceLine(position),
    "Status: 🚨 fora da faixa — posição parada de render fees",
    suggestedRangeLine(position),
    "",
    CALL_TO_ACTION,
  ].join("\n");
}

export function formatReminderReason(position: OnchainPosition, outOfRangeSince: Date | null): string {
  const since = outOfRangeSince ? outOfRangeSince.toLocaleString("pt-BR") : "data desconhecida";
  return [
    header(position),
    rangeLine(position),
    currentPriceLine(position),
    `Status: 🔔 continua fora da faixa desde ${since}`,
    suggestedRangeLine(position),
    "",
    CALL_TO_ACTION,
  ].join("\n");
}

export function formatBackInRangeReason(position: OnchainPosition): string {
  const price = sqrtPriceX96ToPrice(position.sqrtPriceX96, position.token0.decimals, position.token1.decimals);
  return [
    header(position),
    `Status: ✅ voltou para dentro da faixa (${formatPrice(price)} ${position.token1.symbol} por ${position.token0.symbol})`,
    "",
    CALL_TO_ACTION,
  ].join("\n");
}

// Deixa explícito que NÃO é IL desde a abertura real da posição (só desde
// que o poolsbot passou a observá-la), e que fees ganhas não estão
// compensando o número — evita que o usuário leia isso como P&L líquido.
export function formatIlLine(il: ImpermanentLossResult, wasReset: boolean, token1Symbol: string): string {
  const pct = (il.ilPct * 100).toFixed(2);
  const since = il.since.toLocaleDateString("pt-BR");
  const resetNote = wasReset ? " — baseline resetado por alteração na liquidez da posição" : "";
  return `IL desde que o poolsbot passou a monitorar esta posição (${since}${resetNote}): ${pct}% em ${token1Symbol} (não é a abertura on-chain real; não desconta fees ganhas)`;
}

export type FormatReasonFn = (position: OnchainPosition, kind: PositionNotification["kind"], outOfRangeSince: Date | null) => string;

export function formatReason(position: OnchainPosition, kind: PositionNotification["kind"], outOfRangeSince: Date | null): string {
  switch (kind) {
    case "out_of_range":
      return formatOutOfRangeReason(position);
    case "reminder":
      return formatReminderReason(position, outOfRangeSince);
    case "back_in_range":
      return formatBackInRangeReason(position);
  }
}

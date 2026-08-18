import { chains } from "../../config/chains.js";
import type { ImpermanentLossResult } from "./calculate-il.js";
import type { GasCostEstimate } from "./estimate-gas-cost.js";
import { sqrtPriceX96ToPrice, tickToPrice } from "./price-math.js";
import type { OnchainPosition, PositionNotification, PositionRangeSuggestion } from "./types.js";

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
  const chainName = chains[position.chain].defillamaChainName;
  return `${position.token0.symbol}/${position.token1.symbol} ${formatFee(position.fee)} (Uniswap V3, ${chainName})`;
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

export function formatWindowDuration(seconds: number): string {
  if (seconds >= 24 * 3600) return `${Math.round(seconds / (24 * 3600))}d`;
  return `${Math.round(seconds / 3600)}h`;
}

// suggestion vem sempre pronta do job (calculada em client.ts/volatility-range.ts,
// que exigem RPC — esta função continua pura). O texto deixa explícito se a
// faixa foi calibrada por movimento de preço real ou se caiu no heurístico
// de espelhar a largura atual (pool sem histórico suficiente) — nunca
// finge uma precisão que não tem.
function suggestedRangeLine(position: OnchainPosition, suggestion: PositionRangeSuggestion): string {
  const low = formatBoundaryPrice(suggestion.range.tickLower, position.token0.decimals, position.token1.decimals);
  const high = formatBoundaryPrice(suggestion.range.tickUpper, position.token0.decimals, position.token1.decimals);
  const basis =
    suggestion.source === "volatility"
      ? `calibrada por volatilidade real, últimos ${formatWindowDuration(suggestion.volatilityWindowSeconds!)}`
      : "largura atual espelhada — sem histórico de preço suficiente pra calibrar";
  return `Faixa sugerida (${basis}): ${low} – ${high} ${position.token1.symbol} por ${position.token0.symbol}`;
}

const CALL_TO_ACTION = "Use /positions para ver todas as suas posições.";

// null quando o job não buscou o preço de gas (posição já in_range não
// precisa) ou quando o par não envolve WETH (sem oráculo, não dá pra
// converter — nesse caso a linha inteira é omitida, não só o valor).
function gasCostLines(position: OnchainPosition, gasCost: GasCostEstimate | null): string[] {
  if (!gasCost || gasCost.costToken1 === null) return [];
  return [
    `Custo estimado de rebalance: ~${gasCost.costToken1.toFixed(4)} ${position.token1.symbol} em gas (~${gasCost.costEth.toFixed(5)} ETH) — considere se compensa antes de agir.`,
  ];
}

export function formatOutOfRangeReason(
  position: OnchainPosition,
  gasCost: GasCostEstimate | null,
  suggestedRange: PositionRangeSuggestion
): string {
  return [
    header(position),
    rangeLine(position),
    currentPriceLine(position),
    "Status: 🚨 fora da faixa — posição parada de render fees",
    suggestedRangeLine(position, suggestedRange),
    ...gasCostLines(position, gasCost),
    "",
    CALL_TO_ACTION,
  ].join("\n");
}

export function formatReminderReason(
  position: OnchainPosition,
  outOfRangeSince: Date | null,
  gasCost: GasCostEstimate | null,
  suggestedRange: PositionRangeSuggestion
): string {
  const since = outOfRangeSince ? outOfRangeSince.toLocaleString("pt-BR") : "data desconhecida";
  return [
    header(position),
    rangeLine(position),
    currentPriceLine(position),
    `Status: 🔔 continua fora da faixa desde ${since}`,
    suggestedRangeLine(position, suggestedRange),
    ...gasCostLines(position, gasCost),
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

export function formatIlAlertReason(
  position: OnchainPosition,
  il: ImpermanentLossResult,
  kind: "triggered" | "reminder" | "recovered"
): string {
  const pct = (il.ilPct * 100).toFixed(2);
  const pair = `${position.token0.symbol}/${position.token1.symbol}`;
  const since = il.since.toLocaleDateString("pt-BR");
  const prefix = {
    triggered: "🚨 IL alto:",
    reminder: "🔔 IL continua alto:",
    recovered: "✅ IL normalizado:",
  }[kind];

  const body = `${prefix} posição ${pair} ${formatFee(position.fee)} (#${position.tokenId}) está em ${pct}% desde ${since} em ${position.token1.symbol} (não é a abertura on-chain real; não desconta fees ganhas).`;
  return kind === "recovered" ? body : `${body}\n\nUse /positions para ver detalhes.`;
}

export type FormatReasonFn = (
  position: OnchainPosition,
  kind: PositionNotification["kind"],
  outOfRangeSince: Date | null,
  gasCost: GasCostEstimate | null,
  suggestedRange: PositionRangeSuggestion | null
) => string;

// suggestedRange só é obrigatória de verdade pros kinds out_of_range/reminder
// (garantido pelo job — sempre calcula algo quando a posição está fora de
// range); back_in_range ignora. O "| null" no tipo existe porque
// EvaluatePositionInput também usa null pra representar "posição in_range,
// não computado" antes de saber qual kind vai sair da avaliação.
export function formatReason(
  position: OnchainPosition,
  kind: PositionNotification["kind"],
  outOfRangeSince: Date | null,
  gasCost: GasCostEstimate | null,
  suggestedRange: PositionRangeSuggestion | null
): string {
  switch (kind) {
    case "out_of_range":
      return formatOutOfRangeReason(position, gasCost, suggestedRange!);
    case "reminder":
      return formatReminderReason(position, outOfRangeSince, gasCost, suggestedRange!);
    case "back_in_range":
      return formatBackInRangeReason(position);
  }
}

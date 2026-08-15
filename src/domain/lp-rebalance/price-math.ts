// Conversões puras tick <-> preço para EXIBIÇÃO. Não são bit-exact com a
// aritmética Q64.96 on-chain (não precisam ser: nada aqui assina transação).

export const Q96 = 2 ** 96;

// Preço (token1 por token0, em unidades humanas) direto do sqrtPriceX96 do
// slot0() — mais preciso que passar pelo tick porque evita a exponenciação
// de 1.0001^tick para o preço atual, que já temos em formato melhor.
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const raw = Number(sqrtPriceX96) / Q96;
  return raw * raw * 10 ** (decimals0 - decimals1);
}

// sqrt do preço RAW (sem ajuste de decimais): S = sqrtPriceX96 / 2^96. Usado
// pela matemática de liquidity-math.ts, que opera nas fórmulas raw do
// Uniswap V3 (o ajuste de decimais entra só no final, ao converter os
// amounts pra unidades humanas).
export function rawSqrtRatio(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / Q96;
}

// sqrt do preço RAW na fronteira de um tick — equivalente a
// sqrt(tickToPrice(tick, 0, 0)), reaproveitando a mesma exponenciação em vez
// de reimplementar 1.0001^(tick/2).
export function sqrtRatioAtTick(tick: number): number {
  return Math.sqrt(tickToPrice(tick, 0, 0));
}

// Preço (token1 por token0, em unidades humanas) na fronteira de um tick.
// Math.pow(1.0001, tick) satura em ~1.9e38 no tick máximo válido (887272),
// bem dentro do range de float64 (~1.8e308) — sem overflow/Infinity. Evita
// trazer @uniswap/v3-sdk (que arrasta ethers.js, conflitando com viem).
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1);
}

// tickSpacing por fee tier (hundredths of a bip). Constante imutável por
// deploy do Uniswap V3 — hardcoded evita uma chamada RPC extra por fee tier.
const TICK_SPACING_BY_FEE: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

export function tickSpacingForFee(fee: number): number {
  const spacing = TICK_SPACING_BY_FEE[fee];
  if (spacing === undefined) {
    throw new Error(`Fee tier desconhecido: ${fee}`);
  }
  return spacing;
}

export function roundToSpacing(tick: number, spacing: number): number {
  return Math.round(tick / spacing) * spacing;
}

// Convenção Uniswap: posição ativa se tickLower <= tick < tickUpper.
export function isInRange(currentTick: number, tickLower: number, tickUpper: number): boolean {
  return currentTick >= tickLower && currentTick < tickUpper;
}

// Limites absolutos de tick do Uniswap V3. Posições "full range" (comuns em
// certas estratégias) usam ticks arredondados pro tickSpacing mais próximo
// desses limites — tickToPrice nesses extremos produz números astronômicos
// (~1e50 com ajuste de decimais) que são tecnicamente corretos mas inúteis
// pra exibição. MARGIN cobre qualquer spacing válido (o maior é 200).
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const FULL_RANGE_MARGIN = 1000;

export function isFullRangeLower(tick: number): boolean {
  return tick <= MIN_TICK + FULL_RANGE_MARGIN;
}

export function isFullRangeUpper(tick: number): boolean {
  return tick >= MAX_TICK - FULL_RANGE_MARGIN;
}

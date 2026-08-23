// Uniswap V4's PositionManager.getPoolAndPositionInfo() devolve
// tickLower/tickUpper compactados num único uint256 (não numa tupla como o
// positions() do V3) — layout confirmado ao vivo contra uma posição real
// (23/08/2026, tokenId 198755): hasSubscriber nos 8 bits baixos, tickLower
// no bit 8 (24 bits, int24 sinalizado), tickUpper no bit 32 (24 bits,
// int24 sinalizado). Validado batendo com a faixa real da posição
// (74970-79526 USD, o que o usuário chamou de "faixa 75000-79000").
const TICK_BITS = 24n;
const TICK_MASK = (1n << TICK_BITS) - 1n; // 0xFFFFFF

function toSignedInt24(value: bigint): number {
  const masked = value & TICK_MASK;
  const signed = masked & (1n << (TICK_BITS - 1n)) ? masked - (1n << TICK_BITS) : masked;
  return Number(signed);
}

export function decodePositionInfo(packed: bigint): { tickLower: number; tickUpper: number } {
  const tickLower = toSignedInt24(packed >> 8n);
  const tickUpper = toSignedInt24(packed >> 32n);
  return { tickLower, tickUpper };
}

// Mesma matemática Q128 que o V3 usa (implicitamente, via simulação de
// collect()) — aqui é explícita porque o V4 não tem um jeito de simular
// collect() da mesma forma; StateView expõe os 2 valores de
// feeGrowthInside diretamente (o último gravado na posição, e o atual
// recalculado ao vivo) e a conta é feita na mão. Validado ao vivo contra a
// posição real do usuário (bateu com a liquidez/fees esperadas).
export function calculateFeesOwedFromGrowth(feeGrowthInsideLastX128: bigint, feeGrowthInsideX128: bigint, liquidity: bigint): bigint {
  const Q128 = 2n ** 128n;
  return ((feeGrowthInsideX128 - feeGrowthInsideLastX128) * liquidity) / Q128;
}

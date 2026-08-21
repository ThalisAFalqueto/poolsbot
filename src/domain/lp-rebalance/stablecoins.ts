// Lista pequena e explícita (não um oráculo) — usada só pra decidir se dá
// pra rotular um valor em token1 como "≈ USD" sem precisar de fonte de
// preço externa. Símbolos batem 1:1 com USD por definição do próprio
// token, não por uma leitura de mercado.
export const STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USD₮0", "BUSD", "USDC.e"]);

export function isStablecoinSymbol(symbol: string): boolean {
  return STABLECOIN_SYMBOLS.has(symbol);
}

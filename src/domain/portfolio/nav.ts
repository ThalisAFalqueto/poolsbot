// Composição do patrimônio (NAV) da carteira, em USDC.
//
// Puro de propósito (sem RPC nem banco, como todo o domain/): quem chama
// resolve preços e saldos e entrega os números já convertidos. Isso é o que
// permite testar a matemática sem rede.
//
// A parte importante é o que este arquivo NÃO faz: não descobre tokens. A
// lista vem de fora, filtrada (ver token-allowlist.ts) — airdrop de scam com
// preço inventado destruiria o patrimônio, e ele chega exatamente como uma
// transferência de entrada legítima.

export type ValuedHolding = { symbol: string; amount: number; priceUsdc: number };

export type NavBreakdown = {
  navUsdc: number;
  idleUsdc: number; // tokens soltos na carteira, incluindo a reserva de gas
  positionsUsdc: number; // capital dentro das pools
  feesUsdc: number; // fees geradas e ainda não coletadas
  /** Fração do patrimônio que NÃO está rendendo em pool (0-1). */
  idleFraction: number;
};

export function composeNav(input: {
  idle: ValuedHolding[];
  positionsUsdc: number;
  feesUsdc: number;
}): NavBreakdown {
  const idleUsdc = input.idle.reduce((sum, h) => sum + h.amount * h.priceUsdc, 0);
  const navUsdc = idleUsdc + input.positionsUsdc + input.feesUsdc;

  return {
    navUsdc,
    idleUsdc,
    positionsUsdc: input.positionsUsdc,
    feesUsdc: input.feesUsdc,
    // Fees contam como "rendendo": já foram geradas pela pool, só não foram
    // sacadas. O que é ocioso de verdade é o que está fora dela.
    idleFraction: navUsdc > 0 ? idleUsdc / navUsdc : 0,
  };
}

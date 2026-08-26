// Quais tokens podem entrar no patrimônio (NAV) e nos fluxos de caixa.
//
// Isto NÃO é preciosismo. Airdrop de token de scam é rotina na Arbitrum, e
// ele chega exatamente como um depósito legítimo: uma transferência de
// entrada assinada por outra pessoa — que é a definição que o bot usa pra
// "dinheiro novo entrou". Sem esta lista, um token falso com preço inventado
// entraria como aporte e como patrimônio, corrompendo o P&L do mês.
//
// A lista é construída, não descoberta: token só entra se o usuário JÁ o usou
// numa pool (o banco guarda token0/token1 de toda posição, ativa ou fechada)
// ou se é uma moeda de referência da própria chain. Qualquer coisa fora disso
// é ignorada por completo — nem patrimônio, nem depósito.

export function buildTokenAllowlist(input: {
  /** Endereços de token vindos das posições do usuário (ativas e fechadas). */
  positionTokens: string[];
  /** Moedas de referência da chain (USDC, WETH) — sempre confiáveis. */
  referenceTokens: (string | undefined)[];
}): Set<string> {
  const allowlist = new Set<string>();
  for (const token of [...input.positionTokens, ...input.referenceTokens]) {
    if (token) allowlist.add(token.toLowerCase());
  }
  return allowlist;
}

export function isAllowedToken(allowlist: Set<string>, token: string): boolean {
  return allowlist.has(token.toLowerCase());
}

// Decidir se um gatilho de fechamento dispara. Puro de propósito: é a lógica
// que move dinheiro real, e ela tem que ser testável sem RPC, sem banco e sem
// contrato.
//
// O bot NUNCA abre posição. A garantia disso é estrutural, no contrato
// (CloseOnlyController não tem código de mint), não neste arquivo.

export type CloseTriggerBounds = {
  /** Fecha se o preço cair ATÉ ou abaixo disto. null = sem piso armado. */
  belowPrice: number | null;
  /** Fecha se o preço subir ATÉ ou acima disto. null = sem teto armado. */
  abovePrice: number | null;
};

export type CloseDecision = { fire: true; side: "below" | "above"; limit: number } | { fire: false };

/**
 * O preço cruzou algum dos limites?
 *
 * Comparação com >= e <=: o limite é o ponto em que o usuário quer sair, não
 * um valor a ser ultrapassado. "Feche em $70.000" com o preço exatamente em
 * $70.000 deve fechar.
 *
 * Quando os dois lados disparam ao mesmo tempo (só é possível com limites
 * cruzados, que `validateBounds` rejeita), o piso ganha — é o lado protetivo.
 */
export function decideClose(bounds: CloseTriggerBounds, currentPrice: number): CloseDecision {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return { fire: false };

  if (bounds.belowPrice !== null && currentPrice <= bounds.belowPrice) {
    return { fire: true, side: "below", limit: bounds.belowPrice };
  }
  if (bounds.abovePrice !== null && currentPrice >= bounds.abovePrice) {
    return { fire: true, side: "above", limit: bounds.abovePrice };
  }
  return { fire: false };
}

export type BoundsValidation = { ok: true } | { ok: false; reason: string };

/**
 * Recusa configurações que disparariam imediatamente ou nunca — errar isso
 * custa uma posição fechada por engano.
 */
export function validateBounds(bounds: CloseTriggerBounds, currentPrice: number): BoundsValidation {
  const { belowPrice, abovePrice } = bounds;

  if (belowPrice === null && abovePrice === null) {
    return { ok: false, reason: "Preciso de pelo menos um limite: abaixo, acima, ou os dois." };
  }
  for (const v of [belowPrice, abovePrice]) {
    if (v !== null && (!Number.isFinite(v) || v <= 0)) {
      return { ok: false, reason: "Os limites precisam ser números positivos." };
    }
  }
  if (belowPrice !== null && abovePrice !== null && belowPrice >= abovePrice) {
    return { ok: false, reason: "O limite de baixo tem que ser MENOR que o de cima — do jeito que está, não existe preço que não dispare." };
  }
  // Armar um gatilho que já está satisfeito fecharia a posição no próximo
  // ciclo, sem o usuário perceber que foi isso que ele pediu.
  const agora = decideClose(bounds, currentPrice);
  if (agora.fire) {
    const lado = agora.side === "below" ? "abaixo" : "acima";
    return {
      ok: false,
      reason: `O preço atual já está ${lado} desse limite — isso fecharia a posição no próximo ciclo. Se é o que você quer, feche na mão.`,
    };
  }
  return { ok: true };
}

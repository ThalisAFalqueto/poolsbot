// Aviso de que a posição está CHEGANDO na borda — antes de sair, não depois.
//
// POR QUE ISSO É SEPARADO DA MÁQUINA DE ESTADO de evaluate-position.ts: aquela
// já causou um crash em produção (27/08/2026) por divergência entre dois
// critérios de "está em faixa". Isto aqui é uma função pura, sem estado, que
// só responde "quão perto da borda". Quem decide notificar cuida da cadência
// em separado, e os dois nunca podem discordar sobre a mesma pergunta.
//
// DESLIGADO POR PADRÃO. O usuário já disse uma vez que não queria esse alerta,
// e mudou de ideia depois — em vez de adivinhar qual das duas vale, o alerta
// existe e ele liga quando quiser (/bordaalerta).

export type EdgeProximity = {
  /** De qual borda está perto. */
  side: "lower" | "upper";
  /** Distância até essa borda, como fração da largura total da faixa.
   *  0 = encostado, 0.5 = bem no meio. */
  fraction: number;
};

/**
 * Quão perto da borda mais próxima, em fração da largura da faixa.
 *
 * Usa TICK, não preço: é a unidade em que a faixa é definida no contrato, e a
 * distância em tick é linear em log-preço — que é a métrica certa, já que o
 * preço se move multiplicativamente.
 *
 * Devolve null pra faixa degenerada (largura zero ou negativa), em vez de
 * dividir por zero e produzir Infinity num alerta.
 */
export function edgeProximity(currentTick: number, tickLower: number, tickUpper: number): EdgeProximity | null {
  const width = tickUpper - tickLower;
  if (width <= 0) return null;

  const paraBaixo = (currentTick - tickLower) / width;
  const paraCima = (tickUpper - currentTick) / width;

  return paraBaixo <= paraCima ? { side: "lower", fraction: paraBaixo } : { side: "upper", fraction: paraCima };
}

/**
 * Fração da largura abaixo da qual vale avisar.
 *
 * 0.15 = os 15% de cada ponta. Numa faixa de ±3% (6,2% de largura), isso é
 * ~0,9% de preço até a borda — com σ de 2,7%/dia no ETH, menos de meio dia de
 * movimento típico. Perto o bastante pra ser acionável, longe o bastante pra
 * não disparar a cada oscilação.
 */
export const NEAR_EDGE_FRACTION = 0.15;

export function isNearEdge(currentTick: number, tickLower: number, tickUpper: number): boolean {
  const p = edgeProximity(currentTick, tickLower, tickUpper);
  // Fora da faixa NÃO conta como "perto da borda": aí já existe o alerta de
  // out_of_range, e mandar os dois seria ruído duplicado.
  if (!p || p.fraction < 0) return false;
  return p.fraction <= NEAR_EDGE_FRACTION;
}

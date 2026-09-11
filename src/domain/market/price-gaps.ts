// Amostras de backfill que caem perto de um ponto já gravado são descartadas.
//
// POR QUE ISSO EXISTE (11/09/2026). O backfill amostra em passo fixo a partir
// de um bloco qualquer, e o histórico já tem um ponto a cada 15min. Sem
// filtro, rodar o backfill numa janela que já tem dado intercala pontos a
// segundos de distância — e estimateVolatility divide cada retorno por √Δt:
// com Δt de 30s a diferença entre as duas leituras é amplificada ~53x (mesmo
// motivo de MIN_PRICE_GAP_MS). Com o filtro, o backfill só preenche BURACO e
// pode ser rodado de novo sem estragar nada.

/**
 * Mantém só as amostras que não têm ponto existente a menos de `radiusMs`.
 * Busca binária no vizinho mais próximo: o histórico de uma pool tem milhares
 * de pontos.
 */
export function keepOnlyGapSamples<T extends { recordedAt: Date }>(samples: T[], existing: Date[], radiusMs: number): T[] {
  const ts = existing.map((d) => d.getTime()).sort((a, b) => a - b);
  return samples.filter((s) => {
    const t = s.recordedAt.getTime();
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    const vizinhos = [ts[lo - 1], ts[lo]];
    return !vizinhos.some((v) => v !== undefined && Math.abs(v - t) < radiusMs);
  });
}

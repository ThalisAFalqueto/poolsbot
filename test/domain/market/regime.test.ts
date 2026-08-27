import { describe, expect, it } from "vitest";
import { analyzeMarketRegime, type MarketVolumePoint } from "../../../src/domain/market/regime.js";

// Série sintética: `values` em ordem crescente de data, uma por dia.
function series(values: number[]): MarketVolumePoint[] {
  return values.map((volumeUsd, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    volumeUsd,
  }));
}

const flat = (n: number, v = 100) => Array.from({ length: n }, () => v);

describe("analyzeMarketRegime", () => {
  it("amostra pequena não vira palpite — devolve indisponível", () => {
    const r = analyzeMarketRegime(series(flat(29)));
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("dados_insuficientes");
  });

  it("volume acima de quase toda a janela sai como aquecido", () => {
    const r = analyzeMarketRegime(series([...flat(90, 100), 500]));
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.percentile).toBe(1);
    expect(r.label).toBe("aquecido");
  });

  it("volume abaixo de quase toda a janela sai como fraco", () => {
    const r = analyzeMarketRegime(series([...flat(90, 100), 1]));
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.percentile).toBe(0);
    expect(r.label).toBe("fraco");
  });

  it("percentil é calculado contra a janela, com o próprio dia FORA dela", () => {
    // 100 dias abaixo de 50, depois o dia medido em 50: se o próprio dia
    // entrasse na distribuição, o percentil não chegaria a 1.
    const r = analyzeMarketRegime(series([...Array.from({ length: 60 }, (_, i) => i + 1), 500]));
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.percentile).toBe(1);
    expect(r.windowDays).toBe(60);
  });

  // A distinção que evita repetir o bug do alerta ("caiu -31%" numa alta):
  // patamar alto e direção de queda são coisas diferentes e podem coexistir.
  it("semana acima do mês é PATAMAR, não direção", () => {
    // 30 dias baixos, depois 7 dias altos: a média curta fica acima da longa.
    const r = analyzeMarketRegime(series([...flat(60, 100), ...flat(7, 300)]));
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.weekVsMonth).toBe("acima_da_media");
    expect(r.shortMaUsd).toBeGreaterThan(r.longMaUsd);
  });

  it("semana abaixo do mês é detectada", () => {
    const r = analyzeMarketRegime(series([...flat(60, 300), ...flat(7, 100)]));
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.weekVsMonth).toBe("abaixo_da_media");
  });

  it("variação irrelevante entre as médias fica 'em linha', não vira notícia", () => {
    const r = analyzeMarketRegime(series([...flat(60, 100), ...flat(7, 102)]));
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.weekVsMonth).toBe("em_linha");
  });

  it("reporta a data do último dia usado, pra o texto poder dizer de quando é", () => {
    const s = series(flat(40));
    const r = analyzeMarketRegime(s);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.latestDate).toBe(s[s.length - 1]!.date);
  });
});

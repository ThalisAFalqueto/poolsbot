import { describe, expect, it } from "vitest";
import { keepOnlyGapSamples } from "../../../src/domain/market/price-gaps.js";

const MIN = 60_000;
const t0 = new Date("2026-09-09T00:00:00Z").getTime();
const at = (min: number) => new Date(t0 + min * MIN);

// Histórico real da WBTC/USDC: um ponto a cada 15min, e um buraco de 24h de
// 09/09 13:45 a 10/09 13:54 — a posição foi fechada e ninguém gravava preço.
const inicioBuraco = 13 * 60 + 45;
const fimBuraco = inicioBuraco + 24 * 60 + 9;
const existentes = [
  ...Array.from({ length: 56 }, (_, i) => at(i * 15)).filter((d) => d.getTime() <= at(inicioBuraco).getTime()),
  ...Array.from({ length: 40 }, (_, i) => at(fimBuraco + i * 15)),
];

describe("keepOnlyGapSamples", () => {
  const amostras = Array.from({ length: 48 * 4 }, (_, i) => ({ recordedAt: at(3 + i * 15), price: 1 }));
  const mantidas = keepOnlyGapSamples(amostras, existentes, 7.5 * MIN);

  it("preenche o buraco", () => {
    const noBuraco = mantidas.filter((s) => s.recordedAt > at(inicioBuraco) && s.recordedAt < at(fimBuraco));
    expect(noBuraco.length).toBeGreaterThan(90); // 24h / 15min = 96, menos as bordas
  });

  // O ponto do teste: amostra a 3 minutos de um ponto existente é justamente o
  // par que amplificaria o σ ~9x. Fora do buraco, nada entra.
  it("não põe nenhuma amostra perto de um ponto existente", () => {
    for (const s of mantidas) {
      const maisPerto = Math.min(...existentes.map((e) => Math.abs(e.getTime() - s.recordedAt.getTime())));
      expect(maisPerto).toBeGreaterThanOrEqual(7.5 * MIN);
    }
  });

  it("sem histórico, mantém tudo", () => {
    expect(keepOnlyGapSamples(amostras, [], 7.5 * MIN)).toHaveLength(amostras.length);
  });

  it("rodar de novo sobre o próprio resultado não acrescenta nada", () => {
    const todos = [...existentes, ...mantidas.map((s) => s.recordedAt)];
    expect(keepOnlyGapSamples(mantidas, todos, 7.5 * MIN)).toHaveLength(0);
  });
});

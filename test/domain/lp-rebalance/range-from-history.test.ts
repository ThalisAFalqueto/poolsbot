import { describe, expect, it } from "vitest";
import { estimateVolatility, rangeForHorizon, type PricePoint } from "../../../src/domain/lp-rebalance/range-from-history.js";

const BASE = new Date("2026-08-01T00:00:00Z");

/** Série com intervalo fixo em minutos. */
function series(prices: number[], stepMinutes = 15): PricePoint[] {
  return prices.map((price, i) => ({
    recordedAt: new Date(BASE.getTime() + i * stepMinutes * 60_000),
    price,
  }));
}

/** Passeio aleatório determinístico com volatilidade diária conhecida. */
function walk(days: number, dailyVol: number, stepMinutes = 15, seed = 42): PricePoint[] {
  const perStep = dailyVol * Math.sqrt(stepMinutes / 1440);
  const n = Math.round((days * 1440) / stepMinutes);
  let price = 80_000;
  let s = seed;
  const out: PricePoint[] = [];
  for (let i = 0; i < n; i++) {
    // gerador simples e determinístico — o teste não pode depender de Math.random
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = (s % 10000) / 10000 || 0.5;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = (s % 10000) / 10000 || 0.5;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    price *= Math.exp(perStep * z);
    out.push({ recordedAt: new Date(BASE.getTime() + i * stepMinutes * 60_000), price });
  }
  return out;
}

describe("estimateVolatility", () => {
  it("amostra pequena devolve null em vez de um número inventado", () => {
    expect(estimateVolatility(series([1, 2, 3]))).toBeNull();
  });

  it("preço parado tem volatilidade zero", () => {
    const e = estimateVolatility(series(Array(50).fill(80_000)));
    expect(e).not.toBeNull();
    expect(e!.dailyVolatility).toBeCloseTo(0, 10);
  });

  it("recupera a volatilidade diária de uma série com vol conhecida", () => {
    const e = estimateVolatility(walk(30, 0.02));
    expect(e).not.toBeNull();
    // ±40% de tolerância: é estimativa estatística, não identidade
    expect(e!.dailyVolatility).toBeGreaterThan(0.012);
    expect(e!.dailyVolatility).toBeLessThan(0.028);
  });

  // O bot já ficou fora do ar por 17h (ver os gaps do /graph). Um retorno
  // medido "por cima" de um buraco desses não é movimento contínuo — se
  // entrasse, inflaria a volatilidade e alargaria a faixa sem motivo.
  it("ignora buracos de coleta em vez de tratá-los como movimento", () => {
    // Dois trechos de preço CONSTANTE (vol real = 0), separados por 3 dias sem
    // coleta e com um salto de 19% entre eles. Se o retorno "por cima" do
    // buraco entrasse na conta, a volatilidade dispararia; excluído, fica ~0.
    const antes = series(Array(40).fill(80_000));
    const depois = series(Array(40).fill(95_000)).map((p) => ({
      ...p,
      recordedAt: new Date(p.recordedAt.getTime() + 3 * 86_400_000),
    }));

    const e = estimateVolatility([...antes, ...depois]);
    expect(e).not.toBeNull();
    // Vol de um salto de 19% em 3 dias seria da ordem de 10%/dia. Exigir
    // < 0,1%/dia prova que o salto não entrou.
    expect(e!.dailyVolatility).toBeLessThan(0.001);
  });

  it("normaliza cadências diferentes (backfill de 1h + ingestão de 15min)", () => {
    const a = estimateVolatility(walk(20, 0.02, 15));
    const b = estimateVolatility(walk(20, 0.02, 60));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Sem normalizar por √Δt, a série de 1h estimaria ~2x a de 15min.
    const razao = a!.dailyVolatility / b!.dailyVolatility;
    expect(razao).toBeGreaterThan(0.5);
    expect(razao).toBeLessThan(2);
  });

  // O caso real de 11/09/2026: um backfill gravado por cima da ingestão deixou
  // 360 pares a segundos de distância no WBTC/USDC e inflou o σ em 23%. Aqui a
  // leitura duplicada difere 0,1% da original — com Δt de 30s, isso vira um
  // "retorno diário" de ~17%.
  it("ignora leitura duplicada colada na anterior", () => {
    const limpo = walk(10, 0.02);
    const sujo = limpo.flatMap((p, i) => [
      p,
      { recordedAt: new Date(p.recordedAt.getTime() + 30_000), price: p.price * (i % 2 === 0 ? 1.001 : 0.999) },
    ]);
    const a = estimateVolatility(limpo)!.dailyVolatility;
    const b = estimateVolatility(sujo)!.dailyVolatility;
    expect(Math.abs(b / a - 1)).toBeLessThan(0.1);
  });

  // Duplicata com o MESMO preço erra pro outro lado: retorno zero puxa o σ pra
  // baixo, e a faixa sugerida sairia estreita demais.
  it("duplicata de preço idêntico não puxa o σ pra baixo", () => {
    const limpo = walk(10, 0.02);
    const sujo = limpo.flatMap((p) => [p, { recordedAt: new Date(p.recordedAt.getTime() + 30_000), price: p.price }]);
    expect(estimateVolatility(sujo)!.dailyVolatility).toBeCloseTo(estimateVolatility(limpo)!.dailyVolatility, 10);
  });

  it("reporta quantos dias e pontos sustentam a estimativa", () => {
    const e = estimateVolatility(walk(10, 0.02));
    expect(e!.observedDays).toBeGreaterThan(9);
    expect(e!.pointCount).toBeGreaterThan(900);
  });
});

describe("rangeForHorizon", () => {
  const est = { dailyVolatility: 0.0167, observedDays: 37, pointCount: 1108 };
const PRECO = 79_254;

  it("horizonte maior exige faixa mais larga", () => {
    const um = rangeForHorizon(est, PRECO, 1);
    const sete = rangeForHorizon(est, PRECO, 7);
    expect(sete.widthPct).toBeGreaterThan(um.widthPct);
  });

  // Difusão escala com √t — dobrar o horizonte aumenta a largura ~41%, não
  // 100%. Errar isso superdimensiona faixas longas e rende menos taxa.
  it("largura escala com a raiz do tempo, não linearmente", () => {
    const um = rangeForHorizon(est, PRECO, 1);
    const quatro = rangeForHorizon(est, PRECO, 4);
    // 4 dias = 2x a largura de 1 dia (√4 = 2), não 4x
    expect(quatro.widthPct / um.widthPct).toBeGreaterThan(1.8);
    expect(quatro.widthPct / um.widthPct).toBeLessThan(2.2);
  });

  it("mais sigmas alargam a faixa", () => {
    expect(rangeForHorizon(est, PRECO, 3, 2).widthPct).toBeGreaterThan(rangeForHorizon(est, PRECO, 3, 1).widthPct);
  });

  it("a faixa contém o preço atual", () => {
    const r = rangeForHorizon(est, PRECO, 3);
    expect(r.low).toBeLessThan(PRECO);
    expect(r.high).toBeGreaterThan(PRECO);
  });

  // REGRESSÃO: a faixa é centrada no preço VIVO passado por quem chama, não
  // na última cotação do histórico. Com o histórico do V3 parado em ~$77k e o
  // preço real em $80,4k, centrar no histórico produzia uma faixa que nem
  // continha o preço atual.
  it("centra no preço passado, mesmo com histórico defasado", () => {
    const r = rangeForHorizon(est, 90_000, 1);
    expect(r.low).toBeLessThan(90_000);
    expect(r.high).toBeGreaterThan(90_000);
  });

  // Reproduz o caso real que motivou a mudança: com vol diária de 1,67%, a
  // faixa de 3 dias tem ~5,8% — contra os 2,0% que a janela de 4h do oráculo
  // produzia, que não sobreviveria um dia.
  it("reproduz os números medidos do WBTC/USDC", () => {
    expect(rangeForHorizon(est, PRECO, 1).widthPct).toBeCloseTo(0.0334, 2);
    expect(rangeForHorizon(est, PRECO, 3).widthPct).toBeCloseTo(0.058, 2);
  });
});

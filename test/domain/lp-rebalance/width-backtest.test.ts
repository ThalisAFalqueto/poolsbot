import { describe, expect, it } from "vitest";
import { backtestWidths, bestWidth } from "../../../src/domain/lp-rebalance/width-backtest.js";
import type { PricePoint } from "../../../src/domain/lp-rebalance/range-from-history.js";

const BASE = new Date("2026-08-01T00:00:00Z");

/** Série com intervalo fixo em minutos, como a ingestão real (15min). */
function serie(precos: number[], passoMin = 15): PricePoint[] {
  return precos.map((price, i) => ({ recordedAt: new Date(BASE.getTime() + i * passoMin * 60_000), price }));
}

/** Passeio aleatório determinístico com volatilidade diária conhecida. */
function passeio(dias: number, volDiaria: number, passoMin = 15, semente = 7): PricePoint[] {
  const porPasso = volDiaria * Math.sqrt(passoMin / 1440);
  const n = Math.round((dias * 1440) / passoMin);
  let preco = 80_000;
  let s = semente;
  const out: PricePoint[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u1 = (s % 10000) / 10000 || 0.5;
    s = (s * 1103515245 + 12345) % 2147483648;
    const u2 = (s % 10000) / 10000 || 0.5;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    preco *= Math.exp(porPasso * z);
    out.push({ recordedAt: new Date(BASE.getTime() + i * passoMin * 60_000), price: preco });
  }
  return out;
}

const OPTS = { widths: [0.02, 0.03, 0.04, 0.083], horizonDays: 7, aprAtReferenceWidth: 0.98, referenceWidth: 0.03 };

describe("backtestWidths", () => {
  it("amostra pequena devolve null em vez de recomendar largura", () => {
    expect(backtestWidths(serie([1, 2, 3]), OPTS)).toBeNull();
  });

  it("sem janela inteira no horizonte devolve null", () => {
    // 2 dias de série contra horizonte de 7: nenhuma janela fecha.
    expect(backtestWidths(passeio(2, 0.02), OPTS)).toBeNull();
  });

  it("preço parado fica 100% em faixa em qualquer largura", () => {
    const r = backtestWidths(serie(Array(1000).fill(80_000)), OPTS)!;
    for (const w of r) expect(w.timeInRange).toBeCloseTo(1, 10);
  });

  // Monotonicidade: se a faixa larga contém a estreita, o tempo dentro nunca
  // pode ser menor. Se isso quebrar, a contagem de amostras está errada.
  it("faixa mais larga nunca fica menos tempo em faixa", () => {
    const r = backtestWidths(passeio(30, 0.02), OPTS)!;
    for (let i = 1; i < r.length; i++) {
      expect(r[i]!.timeInRange).toBeGreaterThanOrEqual(r[i - 1]!.timeInRange - 1e-12);
    }
  });

  // O trade-off central: estreito rende mais por dólar, largo fica mais tempo
  // dentro. Se os dois andassem juntos não haveria decisão a tomar.
  it("faixa mais estreita rende mais bruto e fica menos tempo dentro", () => {
    const r = backtestWidths(passeio(30, 0.02), OPTS)!;
    const estreita = r[0]!;
    const larga = r[r.length - 1]!;
    expect(estreita.grossApr).toBeGreaterThan(larga.grossApr);
    expect(estreita.timeInRange).toBeLessThan(larga.timeInRange);
  });

  it("a taxa bruta bate com a referência medida na própria largura de referência", () => {
    const r = backtestWidths(passeio(30, 0.02), { ...OPTS, widths: [0.03] })!;
    expect(r[0]!.grossApr).toBeCloseTo(0.98, 10);
  });

  // O bot já ficou 17h fora do ar. Numa janela com buraco não dá pra saber se
  // o preço saiu da faixa enquanto ninguém olhava — contá-la como "ficou
  // dentro" inventa tempo em faixa que talvez não tenha existido.
  it("janela com buraco de coleta é descartada, não contada como dentro", () => {
    const antes = passeio(20, 0.02);
    const depois = passeio(20, 0.02).map((p) => ({
      ...p,
      recordedAt: new Date(p.recordedAt.getTime() + 20 * 86_400_000 + 3 * 86_400_000),
    }));
    const comBuraco = backtestWidths([...antes, ...depois], OPTS)!;
    const soAntes = backtestWidths(antes, OPTS)!;
    // As janelas que cruzam o buraco somem; as demais continuam iguais.
    expect(comBuraco[0]!.windows).toBeLessThan(soAntes[0]!.windows * 2 + 1);
    expect(comBuraco[0]!.timeInRange).toBeGreaterThan(0);
  });

  it("reporta quantas janelas sustentam o número", () => {
    const r = backtestWidths(passeio(30, 0.02), OPTS)!;
    expect(r[0]!.windows).toBeGreaterThan(10);
    for (const w of r) expect(w.windows).toBe(r[0]!.windows);
  });

  // Ancorado na medição real de 01/09/2026 (WBTC/USDC, 42 dias): com σ de
  // ~2%/dia, uma faixa de ±2% fica em torno de 3/4 do tempo dentro em janelas
  // de 7 dias, e ±8,3% fica quase sempre.
  it("reproduz a ordem de grandeza medida no WBTC/USDC", () => {
    const r = backtestWidths(passeio(40, 0.02), OPTS)!;
    const estreita = r.find((w) => w.halfWidthLog === 0.02)!;
    const larga = r.find((w) => w.halfWidthLog === 0.083)!;
    expect(estreita.timeInRange).toBeGreaterThan(0.5);
    expect(estreita.timeInRange).toBeLessThan(0.95);
    expect(larga.timeInRange).toBeGreaterThan(0.9);
  });
});

describe("bestWidth", () => {
  it("devolve a de maior retorno efetivo", () => {
    const r = backtestWidths(passeio(40, 0.02), OPTS)!;
    const melhor = bestWidth(r)!;
    for (const w of r) expect(melhor.effectiveApr).toBeGreaterThanOrEqual(w.effectiveApr);
  });

  it("null quando o backtest não rodou", () => {
    expect(bestWidth(null)).toBeNull();
    expect(bestWidth([])).toBeNull();
  });
});

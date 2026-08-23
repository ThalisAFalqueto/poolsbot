import { describe, expect, it } from "vitest";
import {
  buildSecondsAgos,
  computeMarginFraction,
  intervalAverageTicks,
  suggestVolatilityRange,
} from "../../../src/domain/lp-rebalance/volatility-range.js";

describe("buildSecondsAgos", () => {
  it("gera checkpointCount+1 pontos, decrescentes, terminando em 0", () => {
    const result = buildSecondsAgos(3600, 4);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(3600);
    expect(result[result.length - 1]).toBe(0);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!).toBeLessThan(result[i - 1]!);
    }
  });
});

describe("intervalAverageTicks", () => {
  it("calcula o tick médio de cada sub-intervalo a partir do tickCumulative", () => {
    // preço parado em tick=100 o tempo todo: tickCumulative cresce
    // linearmente 100 por segundo.
    const secondsAgos = [300, 200, 100, 0];
    const tickCumulatives = [-30000n, -20000n, -10000n, 0n]; // tick=100 * (300-t)... equivalente a acumulado crescente
    const result = intervalAverageTicks(tickCumulatives, secondsAgos);
    expect(result).toEqual([100, 100, 100]);
  });

  it("pula intervalos com timeDelta zero (checkpoints duplicados)", () => {
    const secondsAgos = [100, 100, 0];
    const tickCumulatives = [0n, 0n, 5000n];
    const result = intervalAverageTicks(tickCumulatives, secondsAgos);
    expect(result).toEqual([50]); // só o intervalo válido (100->0)
  });
});

describe("computeMarginFraction", () => {
  const flatTicks = [100, 100, 100, 100]; // variância zero

  it("fica na faixa do comportamento anterior (~20%) num cenário parecido com a referência", () => {
    // fee 0.05% == fee tier de referência, gasCostFraction null (usa custo de
    // referência), volatilidade moderada — não é mais exatamente 20% (a
    // referência é uma calibração, não uma identidade), mas fica perto.
    const margin = computeMarginFraction(null, 500, [90, 100, 110, 95, 105, 98]);
    expect(margin).toBeGreaterThan(0.1);
    expect(margin).toBeLessThan(0.3);
  });

  it("custo de gas maior (fração do valor da posição) aumenta a margem", () => {
    const low = computeMarginFraction(0.0005, 3000, flatTicks);
    const high = computeMarginFraction(0.02, 3000, flatTicks);
    expect(high).toBeGreaterThan(low);
  });

  it("fee tier maior reduz a margem — mais compensa ficar concentrado", () => {
    const lowFeeTier = computeMarginFraction(null, 500, flatTicks); // 0.05%
    const highFeeTier = computeMarginFraction(null, 10000, flatTicks); // 1%
    expect(highFeeTier).toBeLessThan(lowFeeTier);
  });

  it("volatilidade maior (dispersão dos ticks médios) aumenta a margem", () => {
    const low = computeMarginFraction(null, 3000, flatTicks);
    const volatile = computeMarginFraction(null, 3000, [0, 500, -300, 800, -600, 400]);
    expect(volatile).toBeGreaterThan(low);
  });

  it("nunca sai dos limites [5%, 60%], mesmo em cenários extremos", () => {
    const extremeCost = computeMarginFraction(5, 500, [0, 5000, -3000, 8000]); // custo de gas absurdo
    expect(extremeCost).toBeLessThanOrEqual(0.6);

    const tinyCostHighFee = computeMarginFraction(0.00001, 10000, flatTicks); // custo ínfimo, fee tier alto
    expect(tinyCostHighFee).toBeGreaterThanOrEqual(0.05);
  });

  it("gasCostFraction null usa o custo de referência (não é o mesmo que custo zero)", () => {
    // fee 0.05% == tier de referência, pra não mascarar a diferença no piso
    // de 5% (com fee=3000 os dois lados clampam pro mesmo piso).
    const nullCost = computeMarginFraction(null, 500, flatTicks);
    const zeroCost = computeMarginFraction(0, 500, flatTicks);
    expect(nullCost).toBeGreaterThan(zeroCost);
  });
});

describe("suggestVolatilityRange", () => {
  it("cobre o range observado com a margem calculada por computeMarginFraction", () => {
    const intervalTicks = [90, 100, 110, 95]; // min=90, max=110, width=20
    const fee = 3000; // spacing=60
    const marginFraction = computeMarginFraction(null, fee, intervalTicks);
    const margin = 20 * marginFraction;

    const result = suggestVolatilityRange(intervalTicks, 100, fee, 60, null);

    expect(result.tickLower).toBeLessThanOrEqual(90 - margin);
    expect(result.tickUpper).toBeGreaterThanOrEqual(110 + margin);
    expect(result.tickLower % 60).toBe(0);
    expect(result.tickUpper % 60).toBe(0);
  });

  it("uma posição com custo de gas alto (fração da posição) recebe uma faixa mais larga que uma com custo baixo", () => {
    // width base grande (via currentTick bem fora dos intervalTicks) pra a
    // diferença de margem sobreviver ao arredondamento pro tickSpacing.
    const intervalTicks = [0, 0, 0, 0];
    const narrow = suggestVolatilityRange(intervalTicks, 1000, 3000, 60, 0.0005);
    const wide = suggestVolatilityRange(intervalTicks, 1000, 3000, 60, 0.02);

    const narrowWidth = narrow.tickUpper - narrow.tickLower;
    const wideWidth = wide.tickUpper - wide.tickLower;
    expect(wideWidth).toBeGreaterThan(narrowWidth);
  });

  it("inclui o tick atual mesmo se estiver fora do range observado historicamente", () => {
    const intervalTicks = [90, 95, 100]; // max histórico = 100
    const result = suggestVolatilityRange(intervalTicks, 500, 3000, 60, null); // preço atual bem acima do observado

    expect(result.tickUpper).toBeGreaterThan(500);
  });

  it("garante largura mínima de 1 tickSpacing quando não há movimento na janela", () => {
    const intervalTicks = [100, 100, 100];
    const result = suggestVolatilityRange(intervalTicks, 100, 3000, 60, null);

    expect(result.tickUpper).toBeGreaterThan(result.tickLower);
  });

  it("nunca sugere além dos limites absolutos de tick", () => {
    const intervalTicks = [887000, 887272];
    const result = suggestVolatilityRange(intervalTicks, 887272, 3000, 60, null);

    expect(result.tickUpper).toBeLessThanOrEqual(887272);
  });
});

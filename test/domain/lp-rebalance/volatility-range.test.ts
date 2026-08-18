import { describe, expect, it } from "vitest";
import {
  buildSecondsAgos,
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

describe("suggestVolatilityRange", () => {
  it("cobre o range observado com margem de 20%", () => {
    const intervalTicks = [90, 100, 110, 95]; // min=90, max=110, width=20
    const result = suggestVolatilityRange(intervalTicks, 100, 3000); // fee 0.3%, spacing=60

    // margem = 20*0.2 = 4 -> [86, 114], arredondado pro spacing de 60 -> [60, 120]
    expect(result.tickLower).toBeLessThanOrEqual(86);
    expect(result.tickUpper).toBeGreaterThanOrEqual(114);
    expect(result.tickLower % 60).toBe(0);
    expect(result.tickUpper % 60).toBe(0);
  });

  it("inclui o tick atual mesmo se estiver fora do range observado historicamente", () => {
    const intervalTicks = [90, 95, 100]; // max histórico = 100
    const result = suggestVolatilityRange(intervalTicks, 500, 3000); // preço atual bem acima do observado

    expect(result.tickUpper).toBeGreaterThan(500);
  });

  it("garante largura mínima de 1 tickSpacing quando não há movimento na janela", () => {
    const intervalTicks = [100, 100, 100];
    const result = suggestVolatilityRange(intervalTicks, 100, 3000);

    expect(result.tickUpper).toBeGreaterThan(result.tickLower);
  });

  it("nunca sugere além dos limites absolutos de tick", () => {
    const intervalTicks = [887000, 887272];
    const result = suggestVolatilityRange(intervalTicks, 887272, 3000);

    expect(result.tickUpper).toBeLessThanOrEqual(887272);
  });
});

import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Gráfico de comparação do mesmo par entre chains (/comparar) — mesmo desenho
// do plot-range.ts/plot-market.ts. Ver scripts/plot_pairs.py.
//
// Substituiu uma tabela de texto: o Telegram usa fonte proporcional fora de
// <pre>, e mesmo dentro ficava apertado no celular. Imagem não depende de
// fonte nem de largura de tela.

export type PairPlotPool = {
  label: string;
  turnover: number | null;
  tvlUsd: number;
  apyBase: number | null;
  /** Retorno MEDIDO on-chain de uma posição de referência, enquanto em faixa.
   *  null = não deu pra medir essa pool. */
  aprInRange: number | null;
  isMonitorable: boolean;
};

/** Qual grandeza as barras representam. Nunca misturar as duas no mesmo
 *  gráfico: "apr" é medido do contrato, "turnover" é estimado da DefiLlama —
 *  desenhá-las na mesma escala sugeriria que são comparáveis. */
export type PairPlotMetric = "apr" | "turnover";

export type PairPlotInput = { pairKey: string; metric: PairPlotMetric; pools: PairPlotPool[] };

const PYTHON_BIN = path.join(process.cwd(), ".venv", "bin", "python3");
const SCRIPT_PATH = path.join(process.cwd(), "scripts", "plot_pairs.py");

export async function renderPairPlot(input: PairPlotInput): Promise<Buffer> {
  const outPath = path.join(tmpdir(), `pairs-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT_PATH, JSON.stringify(input), outPath]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`plot_pairs.py saiu com código ${code}: ${stderr}`));
    });
    proc.on("error", reject); // ENOENT — .venv não configurado nessa máquina
  });

  const buffer = await readFile(outPath);
  await unlink(outPath).catch(() => {});
  return buffer;
}

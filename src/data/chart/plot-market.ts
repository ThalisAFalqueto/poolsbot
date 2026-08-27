import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Gráfico do volume de mercado (/mercado) — mesmo desenho do plot-range.ts:
// subprocesso Python com matplotlib, chamado sob demanda. Ver scripts/plot_market.py.
//
// Como o /graph, depende do .venv existir na máquina (não é versionado, ver
// README) — quem chama trata a falha e cai pro texto puro em vez de deixar o
// comando sem resposta.

export type MarketPlotPoint = { date: string; volumeUsd: number };

export type MarketPlotInput = {
  history: MarketPlotPoint[];
  percentile: number | null;
  label: string;
};

const PYTHON_BIN = path.join(process.cwd(), ".venv", "bin", "python3");
const SCRIPT_PATH = path.join(process.cwd(), "scripts", "plot_market.py");

export async function renderMarketPlot(input: MarketPlotInput): Promise<Buffer> {
  const outPath = path.join(tmpdir(), `market-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT_PATH, JSON.stringify(input), outPath]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`plot_market.py saiu com código ${code}: ${stderr}`));
    });
    proc.on("error", reject); // ENOENT — ex: .venv não configurado nessa máquina
  });

  const buffer = await readFile(outPath);
  await unlink(outPath).catch(() => {}); // best-effort
  return buffer;
}

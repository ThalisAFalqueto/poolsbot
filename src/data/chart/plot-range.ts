import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Gera a imagem via subprocesso Python (matplotlib) — ver scripts/plot_range.py
// e o plano salvo na sessão pra justificativa completa (QuickChart.io manda
// dado pra fora; lib de canvas nativa em JS tem risco de compilação; Python
// via venv local testou limpo nessa máquina). ~1-2s de latência por chamada
// (spawn + import do matplotlib) — aceitável pra um comando sob demanda,
// nunca chamado do ciclo automático de 15min.
export type RangePlotHistoryPoint = { recordedAt: Date; price: number };

export type RangePlotInput = {
  symbolPair: string;
  low: number;
  high: number;
  entry: number | null;
  current: number;
  history: RangePlotHistoryPoint[];
};

const PYTHON_BIN = path.join(process.cwd(), ".venv", "bin", "python3");
const SCRIPT_PATH = path.join(process.cwd(), "scripts", "plot_range.py");

export async function renderRangePlot(input: RangePlotInput): Promise<Buffer> {
  const outPath = path.join(tmpdir(), `range-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [SCRIPT_PATH, JSON.stringify(input), outPath]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`plot_range.py saiu com código ${code}: ${stderr}`));
    });
    // ENOENT etc. — ex: .venv não configurado nessa máquina
    proc.on("error", reject);
  });

  const buffer = await readFile(outPath);
  await unlink(outPath).catch(() => {}); // best-effort, não falha o comando se o cleanup falhar
  return buffer;
}

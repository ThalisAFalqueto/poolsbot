import cron from "node-cron";
import { recordJobRun } from "../persistence/repositories/job-status.repository.js";
import { ingestPoolsJob } from "./jobs/ingest-pools.job.js";
import { checkPositionsJob } from "./jobs/check-positions.job.js";
import { snapshotNavJob } from "./jobs/snapshot-nav.job.js";
import { dailyDigestJob } from "./jobs/daily-digest.job.js";
import { checkCloseTriggersJob } from "./jobs/check-close-triggers.job.js";

// Cada job roda isolado no seu próprio try/catch — um job falhando não pode
// impedir os outros de rodarem no mesmo ciclo (antes de existir /status, os
// 3 rodavam sob um try/catch compartilhado: se evaluate-alerts lançasse,
// check-positions nunca rodava naquele ciclo). Resultado (sucesso/erro +
// resumo) é sempre gravado em job_status, pro /status ler depois.
async function runJob(jobName: string, fn: () => Promise<string>): Promise<void> {
  try {
    const summary = await fn();
    await recordJobRun(jobName, { success: true, summary });
  } catch (err) {
    console.error(`[scheduler] erro no job ${jobName}:`, err);
    await recordJobRun(jobName, { success: false, errorMessage: err instanceof Error ? err.message : String(err) });
  }
}

async function runCycle(): Promise<void> {
  await runJob("ingest-pools", ingestPoolsJob);
  await runJob("check-positions", checkPositionsJob);
  // Único job que ESCREVE na blockchain. Depois do check-positions de
  // propósito: se uma posição sumiu, o estado já foi atualizado antes de
  // tentarmos fechá-la. Sai na primeira linha se não houver gatilho armado
  // ou se o fechamento não estiver configurado.
  await runJob("check-close-triggers", checkCloseTriggersJob);
  // Roda no mesmo ciclo de 15min, mas o próprio job sai cedo se já houver
  // foto de hoje — o custo de RPC acontece 1x/dia, não 96x.
  await runJob("snapshot-nav", snapshotNavJob);
  // Também sai cedo fora do horário/já enviado — ver o job.
  await runJob("daily-digest", dailyDigestJob);
}

export function startScheduler(): void {
  cron.schedule("*/15 * * * *", runCycle);
  void runCycle(); // roda uma vez no boot, sem esperar 15min pro primeiro ciclo
  console.log("Scheduler iniciado: ingestão + avaliação de alertas + posições LP a cada 15min.");
}

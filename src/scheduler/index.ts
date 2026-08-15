import cron from "node-cron";
import { ingestPoolsJob } from "./jobs/ingest-pools.job.js";
import { evaluateAlertsJob } from "./jobs/evaluate-alerts.job.js";
import { checkPositionsJob } from "./jobs/check-positions.job.js";

async function runCycle(): Promise<void> {
  try {
    await ingestPoolsJob();
    await evaluateAlertsJob();
    await checkPositionsJob();
  } catch (err) {
    console.error("[scheduler] erro no ciclo:", err);
  }
}

export function startScheduler(): void {
  cron.schedule("*/15 * * * *", runCycle);
  void runCycle(); // roda uma vez no boot, sem esperar 15min pro primeiro ciclo
  console.log("Scheduler iniciado: ingestão + avaliação de alertas + posições LP a cada 15min.");
}

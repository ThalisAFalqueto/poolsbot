import cron from "node-cron";
import { ingestPoolsJob } from "./jobs/ingest-pools.job.js";
import { evaluateAlertsJob } from "./jobs/evaluate-alerts.job.js";

async function runCycle(): Promise<void> {
  try {
    await ingestPoolsJob();
    await evaluateAlertsJob();
  } catch (err) {
    console.error("[scheduler] erro no ciclo de ingestão/avaliação:", err);
  }
}

export function startScheduler(): void {
  cron.schedule("*/15 * * * *", runCycle);
  void runCycle(); // roda uma vez no boot, sem esperar 15min pro primeiro ciclo
  console.log("Scheduler iniciado: ingestão + avaliação de alertas a cada 15min.");
}

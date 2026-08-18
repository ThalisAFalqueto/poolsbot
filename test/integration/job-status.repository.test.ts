import { beforeEach, describe, expect, it } from "vitest";
import { listJobStatuses, recordJobRun } from "../../src/persistence/repositories/job-status.repository.js";
import { truncateAll } from "./db-helper.js";

describe("job-status.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("recordJobRun cria uma linha nova pra um job inexistente", async () => {
    await recordJobRun("ingest-pools", { success: true, summary: "1/1 pools atualizados." });

    const rows = await listJobStatuses();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobName).toBe("ingest-pools");
    expect(rows[0]?.lastSuccess).toBe(true);
    expect(rows[0]?.lastSummary).toBe("1/1 pools atualizados.");
    expect(rows[0]?.lastErrorMessage).toBeNull();
  });

  it("recordJobRun sobrescreve o estado anterior do mesmo job (upsert, não histórico)", async () => {
    await recordJobRun("check-positions", { success: true, summary: "1 usuário verificado." });
    await recordJobRun("check-positions", { success: false, errorMessage: "RPC timeout" });

    const rows = await listJobStatuses();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastSuccess).toBe(false);
    expect(rows[0]?.lastErrorMessage).toBe("RPC timeout");
    expect(rows[0]?.lastSummary).toBeNull(); // limpo ao registrar uma falha
  });

  it("jobs diferentes mantêm linhas independentes", async () => {
    await recordJobRun("ingest-pools", { success: true, summary: "a" });
    await recordJobRun("evaluate-alerts", { success: true, summary: "b" });

    const rows = await listJobStatuses();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.jobName).sort()).toEqual(["evaluate-alerts", "ingest-pools"]);
  });
});

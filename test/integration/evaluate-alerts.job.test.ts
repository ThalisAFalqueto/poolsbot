import { beforeEach, describe, expect, it, vi } from "vitest";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { watchPool } from "../../src/persistence/repositories/watched-pools.repository.js";
import { listRulesForUser } from "../../src/persistence/repositories/alert-rules.repository.js";
import { insertSnapshots } from "../../src/persistence/repositories/apy-history.repository.js";
import { truncateAll } from "./db-helper.js";

// dispatchSignal manda mensagem de verdade pro Telegram — mockar é
// obrigatório aqui, nunca deveria enviar notificação real num teste.
vi.mock("../../src/notifications/dispatch-signal.js", () => ({
  dispatchSignal: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchSignal } from "../../src/notifications/dispatch-signal.js";
import { evaluateAlertsJob } from "../../src/scheduler/jobs/evaluate-alerts.job.js";

const mockedDispatchSignal = vi.mocked(dispatchSignal);

function snapshot(poolId: string, apy: number, tvlUsd: number, recordedAt: Date) {
  return {
    poolId,
    chain: "Arbitrum",
    apyBase: apy,
    apyReward: null,
    apy,
    tvlUsd,
    ilRisk: "no",
    il7d: null,
    recordedAt,
  } as any;
}

describe("evaluateAlertsJob", () => {
  beforeEach(async () => {
    await truncateAll();
    mockedDispatchSignal.mockClear();
  });

  it("não faz nada se não há regras ativas", async () => {
    await evaluateAlertsJob();
    expect(mockedDispatchSignal).not.toHaveBeenCalled();
  });

  it("dispara e persiste 'triggered' quando o APY cai acima do threshold (TVL estável não dispara)", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    await watchPool(user.id, "pool-a", "Arbitrum");
    const now = new Date();
    // 24.5h atrás: dentro da janela de busca (now-25h) mas fora do "agora",
    // com folga suficiente pra não cair na borda exata do range (mesma
    // lição aprendida testando isso manualmente em produção).
    const baselineAt = new Date(now.getTime() - 24.5 * 3600 * 1000);

    await insertSnapshots([
      snapshot("pool-a", 20, 1_000_000, baselineAt), // baseline: APY 20%, TVL $1M
      snapshot("pool-a", 10, 1_000_000, now), // atual: APY caiu 50%, TVL igual
    ]);

    await evaluateAlertsJob();

    expect(mockedDispatchSignal).toHaveBeenCalledTimes(1); // só apy_drop dispara
    const rules = await listRulesForUser(user.id);
    const apyRule = rules.find((r) => r.metric === "apy_drop_relative");
    const tvlRule = rules.find((r) => r.metric === "tvl_drop_relative");
    expect(apyRule?.status).toBe("triggered");
    expect(tvlRule?.status).toBe("ok");
  });

  it("não dispara com um único snapshot (baseline insuficiente)", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-2");
    await watchPool(user.id, "pool-b", "Arbitrum");
    await insertSnapshots([snapshot("pool-b", 10, 1_000_000, new Date())]);

    await evaluateAlertsJob();
    expect(mockedDispatchSignal).not.toHaveBeenCalled();

    const rules = await listRulesForUser(user.id);
    expect(rules.every((r) => r.status === "ok")).toBe(true);
  });
});

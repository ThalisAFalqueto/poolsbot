import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { watchPool } from "../../src/persistence/repositories/watched-pools.repository.js";
import { listRulesForUser } from "../../src/persistence/repositories/alert-rules.repository.js";
import { updateAlertState } from "../../src/persistence/repositories/alert-state.repository.js";
import { truncateAll } from "./db-helper.js";

describe("alert-state.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("updateAlertState grava status/valor/timestamps", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    await watchPool(user.id, "pool-abc", "Arbitrum");
    const [rule] = await listRulesForUser(user.id);
    const now = new Date();

    await updateAlertState(rule!.ruleId, {
      status: "triggered",
      lastValue: 0.25,
      triggeredAt: now,
      lastNotifiedAt: now,
    });

    const [updated] = await listRulesForUser(user.id);
    expect(updated?.status).toBe("triggered");
    expect(updated?.triggeredAt?.getTime()).toBe(now.getTime());
  });

  it("updateAlertState pra 'ok' limpa triggeredAt/lastNotifiedAt", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-2");
    await watchPool(user.id, "pool-abc", "Arbitrum");
    const [rule] = await listRulesForUser(user.id);

    await updateAlertState(rule!.ruleId, {
      status: "triggered",
      lastValue: 0.3,
      triggeredAt: new Date(),
      lastNotifiedAt: new Date(),
    });
    await updateAlertState(rule!.ruleId, { status: "ok", lastValue: 0.1, triggeredAt: null, lastNotifiedAt: null });

    const [updated] = await listRulesForUser(user.id);
    expect(updated?.status).toBe("ok");
    expect(updated?.triggeredAt).toBeNull();
  });
});

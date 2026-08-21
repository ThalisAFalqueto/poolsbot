import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { watchPool } from "../../src/persistence/repositories/watched-pools.repository.js";
import {
  deleteRuleForUser,
  listActiveRulesWithContext,
  listRulesForUser,
} from "../../src/persistence/repositories/alert-rules.repository.js";
import { truncateAll } from "./db-helper.js";

describe("alert-rules.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("listActiveRulesWithContext traz o contexto completo (usuário, wallet, pool)", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    await watchPool(user.id, "pool-abc", "Arbitrum");

    const rules = await listActiveRulesWithContext();
    expect(rules).toHaveLength(3); // apy_drop_relative, tvl_drop_relative, volume_spike_relative
    expect(rules[0]?.telegramChatId).toBe("chat-1");
    expect(rules[0]?.poolId).toBe("pool-abc");
    expect(rules[0]?.status).toBe("ok");
  });

  it("listRulesForUser só retorna regras do usuário pedido", async () => {
    const userA = await findOrCreateUserByTelegramChatId("chat-a");
    const userB = await findOrCreateUserByTelegramChatId("chat-b");
    await watchPool(userA.id, "pool-a", "Arbitrum");
    await watchPool(userB.id, "pool-b", "Arbitrum");

    const rulesA = await listRulesForUser(userA.id);
    expect(rulesA).toHaveLength(3);
    expect(rulesA.every((r) => r.poolId === "pool-a")).toBe(true);
  });

  it("deleteRuleForUser remove quando o usuário é dono", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    await watchPool(user.id, "pool-abc", "Arbitrum");
    const [rule] = await listRulesForUser(user.id);

    const removed = await deleteRuleForUser(rule!.ruleId, user.id);
    expect(removed).toBe(true);

    const remaining = await listRulesForUser(user.id);
    expect(remaining).toHaveLength(2);
  });

  it("deleteRuleForUser retorna false pra regra de outro usuário (ownership check)", async () => {
    const owner = await findOrCreateUserByTelegramChatId("owner");
    const attacker = await findOrCreateUserByTelegramChatId("attacker");
    await watchPool(owner.id, "pool-abc", "Arbitrum");
    const [rule] = await listRulesForUser(owner.id);

    const removed = await deleteRuleForUser(rule!.ruleId, attacker.id);
    expect(removed).toBe(false);

    const stillThere = await listRulesForUser(owner.id);
    expect(stillThere).toHaveLength(3);
  });
});

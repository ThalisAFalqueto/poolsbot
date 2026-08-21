import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/persistence/db.js";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import {
  listDistinctWatchedPools,
  unwatchPool,
  watchPool,
} from "../../src/persistence/repositories/watched-pools.repository.js";
import { truncateAll } from "./db-helper.js";

describe("watched-pools.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("watchPool cria a posição observada + regras default + estado inicial", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    const { isNew } = await watchPool(user.id, "pool-abc", "Arbitrum");
    expect(isNew).toBe(true);

    // DEFAULT_ALERT_RULES: apy_drop_relative, tvl_drop_relative, volume_spike_relative
    const rules = await db.execute<{ count: string }>(sql`SELECT count(*) FROM alert_rules`);
    expect(Number(rules.rows[0]?.count)).toBe(3);

    const states = await db.execute<{ count: string }>(sql`SELECT count(*) FROM alert_state`);
    expect(Number(states.rows[0]?.count)).toBe(3);
  });

  it("watchPool é idempotente: segunda chamada não duplica nem cria novas regras", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-2");
    await watchPool(user.id, "pool-abc", "Arbitrum");
    const second = await watchPool(user.id, "pool-abc", "Arbitrum");

    expect(second.isNew).toBe(false);
    const watched = await db.execute<{ count: string }>(sql`SELECT count(*) FROM watched_pools`);
    expect(Number(watched.rows[0]?.count)).toBe(1);
    const rules = await db.execute<{ count: string }>(sql`SELECT count(*) FROM alert_rules`);
    expect(Number(rules.rows[0]?.count)).toBe(3);
  });

  it("listDistinctWatchedPools dedupa quando dois usuários observam o mesmo pool", async () => {
    const userA = await findOrCreateUserByTelegramChatId("chat-a");
    const userB = await findOrCreateUserByTelegramChatId("chat-b");
    await watchPool(userA.id, "pool-shared", "Arbitrum");
    await watchPool(userB.id, "pool-shared", "Arbitrum");
    await watchPool(userA.id, "pool-only-a", "Arbitrum");

    const distinct = await listDistinctWatchedPools();
    expect(distinct).toHaveLength(2);
    expect(distinct.map((d) => d.poolId).sort()).toEqual(["pool-only-a", "pool-shared"]);
  });

  it("unwatchPool remove e limpa regras/estado via cascade", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-3");
    await watchPool(user.id, "pool-xyz", "Arbitrum");

    const removed = await unwatchPool(user.id, "pool-xyz");
    expect(removed).toBe(true);

    const watched = await db.execute<{ count: string }>(sql`SELECT count(*) FROM watched_pools`);
    expect(Number(watched.rows[0]?.count)).toBe(0);
    const rules = await db.execute<{ count: string }>(sql`SELECT count(*) FROM alert_rules`);
    expect(Number(rules.rows[0]?.count)).toBe(0);
  });

  it("unwatchPool retorna false quando não havia nada pra remover", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-4");
    const removed = await unwatchPool(user.id, "pool-inexistente");
    expect(removed).toBe(false);
  });
});

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

  // Já criava 3 regras de alerta junto. Isso saiu na limpeza de 07/09/2026:
  // acompanhar uma pool agora significa só uma coisa — gravar o histórico dela.
  it("watchPool registra a pool, e só isso", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    const { isNew } = await watchPool(user.id, "pool-abc", "Arbitrum");
    expect(isNew).toBe(true);

    const watched = await db.execute<{ count: string }>(sql`SELECT count(*) FROM watched_pools`);
    expect(Number(watched.rows[0]?.count)).toBe(1);
  });

  it("watchPool é idempotente: segunda chamada não duplica", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-2");
    await watchPool(user.id, "pool-abc", "Arbitrum");
    const second = await watchPool(user.id, "pool-abc", "Arbitrum");

    expect(second.isNew).toBe(false);
    const watched = await db.execute<{ count: string }>(sql`SELECT count(*) FROM watched_pools`);
    expect(Number(watched.rows[0]?.count)).toBe(1);
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

  it("unwatchPool remove a pool", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-x");
    await watchPool(user.id, "pool-abc", "Arbitrum");
    expect(await unwatchPool(user.id, "pool-abc")).toBe(true);

    const watched = await db.execute<{ count: string }>(sql`SELECT count(*) FROM watched_pools`);
    expect(Number(watched.rows[0]?.count)).toBe(0);
  });

  it("unwatchPool retorna false quando não havia nada pra remover", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-4");
    const removed = await unwatchPool(user.id, "pool-inexistente");
    expect(removed).toBe(false);
  });
});

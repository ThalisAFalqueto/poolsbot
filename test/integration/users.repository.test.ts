import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { truncateAll } from "./db-helper.js";

describe("users.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("cria um usuário novo na primeira chamada", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    expect(user.telegramChatId).toBe("chat-1");
    expect(user.id).toBeGreaterThan(0);
  });

  it("é idempotente: retorna o mesmo usuário em chamadas repetidas", async () => {
    const first = await findOrCreateUserByTelegramChatId("chat-2");
    const second = await findOrCreateUserByTelegramChatId("chat-2");
    expect(second.id).toBe(first.id);
  });
});

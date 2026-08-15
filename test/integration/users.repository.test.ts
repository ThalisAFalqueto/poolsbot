import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateUserByTelegramChatId, setWalletAddress } from "../../src/persistence/repositories/users.repository.js";
import { truncateAll } from "./db-helper.js";

describe("users.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("cria um usuário novo na primeira chamada", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    expect(user.telegramChatId).toBe("chat-1");
    expect(user.walletAddress).toBeNull();
    expect(user.id).toBeGreaterThan(0);
  });

  it("é idempotente: retorna o mesmo usuário em chamadas repetidas", async () => {
    const first = await findOrCreateUserByTelegramChatId("chat-2");
    const second = await findOrCreateUserByTelegramChatId("chat-2");
    expect(second.id).toBe(first.id);
  });

  it("setWalletAddress atualiza o endereço", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-3");
    await setWalletAddress(user.id, "0x1234567890123456789012345678901234567890");

    const reloaded = await findOrCreateUserByTelegramChatId("chat-3");
    expect(reloaded.walletAddress).toBe("0x1234567890123456789012345678901234567890");
  });
});

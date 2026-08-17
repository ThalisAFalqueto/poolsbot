import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { addWallet, listWallets, removeWallet } from "../../src/persistence/repositories/user-wallets.repository.js";
import { truncateAll } from "./db-helper.js";

const ADDR_A = "0x1234567890123456789012345678901234567890";
const ADDR_B = "0xaBcDEF1234567890123456789012345678901234";

describe("user-wallets.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("addWallet cria uma wallet nova e reporta wasNew", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    const result = await addWallet(user.id, ADDR_A, "principal");
    expect(result.wasNew).toBe(true);

    const wallets = await listWallets(user.id);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]!.address).toBe(ADDR_A);
    expect(wallets[0]!.label).toBe("principal");
  });

  it("addWallet é idempotente: vincular a mesma wallet de novo não duplica", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-2");
    await addWallet(user.id, ADDR_A);
    const second = await addWallet(user.id, ADDR_A);
    expect(second.wasNew).toBe(false);

    const wallets = await listWallets(user.id);
    expect(wallets).toHaveLength(1);
  });

  it("um usuário pode vincular mais de uma wallet", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-3");
    await addWallet(user.id, ADDR_A);
    await addWallet(user.id, ADDR_B);

    const wallets = await listWallets(user.id);
    expect(wallets.map((w) => w.address).sort()).toEqual([ADDR_A, ADDR_B].sort());
  });

  it("removeWallet desvincula e retorna true; repetir retorna false", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-4");
    await addWallet(user.id, ADDR_A);

    expect(await removeWallet(user.id, ADDR_A)).toBe(true);
    expect(await listWallets(user.id)).toHaveLength(0);
    expect(await removeWallet(user.id, ADDR_A)).toBe(false);
  });
});

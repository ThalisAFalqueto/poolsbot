import { beforeEach, describe, expect, it } from "vitest";
import {
  disableCloseTrigger,
  listArmedTriggers,
  listCloseTriggers,
  markTriggerFired,
  upsertCloseTrigger,
} from "../../src/persistence/repositories/close-triggers.repository.js";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { db } from "../../src/persistence/db.js";
import { userWallets } from "../../src/persistence/schema/index.js";
import { truncateAll } from "./db-helper.js";

const WALLET = "0x796532000000000000000000000000000000abcd";

async function usuario(chatId = "111") {
  const user = await findOrCreateUserByTelegramChatId(chatId);
  await db.insert(userWallets).values({ userId: user.id, address: WALLET }).onConflictDoNothing();
  return user;
}

const POS = { chain: "arbitrum", protocol: "v3", tokenId: "5674258" };

describe("close-triggers.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("cria e lista um gatilho", async () => {
    const user = await usuario();
    await upsertCloseTrigger({ userId: user.id, ...POS, belowPrice: 70_000, abovePrice: 90_000 });

    const [g] = await listCloseTriggers(user.id);
    expect(g?.tokenId).toBe("5674258");
    expect(g?.belowPrice).toBe(70_000);
    expect(g?.abovePrice).toBe(90_000);
    expect(g?.enabled).toBe(true);
  });

  // A identidade é (chain, protocol, tokenId), como em lp_positions: tokenId
  // só é único dentro de um contrato, e V3/V4 podem colidir.
  it("não confunde a mesma tokenId em protocolos diferentes", async () => {
    const user = await usuario();
    await upsertCloseTrigger({ userId: user.id, ...POS, belowPrice: 70_000, abovePrice: null });
    await upsertCloseTrigger({ userId: user.id, ...POS, protocol: "v4", belowPrice: 60_000, abovePrice: null });

    const todos = await listCloseTriggers(user.id);
    expect(todos).toHaveLength(2);
    expect(todos.map((g) => g.protocol).sort()).toEqual(["v3", "v4"]);
  });

  it("reconfigurar substitui os limites em vez de duplicar", async () => {
    const user = await usuario();
    await upsertCloseTrigger({ userId: user.id, ...POS, belowPrice: 70_000, abovePrice: null });
    await upsertCloseTrigger({ userId: user.id, ...POS, belowPrice: 65_000, abovePrice: 95_000 });

    const todos = await listCloseTriggers(user.id);
    expect(todos).toHaveLength(1);
    expect(todos[0]!.belowPrice).toBe(65_000);
    expect(todos[0]!.abovePrice).toBe(95_000);
  });

  it("desarmar mantém a linha, só desliga", async () => {
    const user = await usuario();
    await upsertCloseTrigger({ userId: user.id, ...POS, belowPrice: 70_000, abovePrice: null });

    expect(await disableCloseTrigger(user.id, POS.chain, POS.protocol, POS.tokenId)).toBe(true);
    const [g] = await listCloseTriggers(user.id);
    expect(g?.enabled).toBe(false);
    expect(await listArmedTriggers()).toHaveLength(0);
  });

  it("desarmar o que não existe devolve false em vez de estourar", async () => {
    const user = await usuario();
    expect(await disableCloseTrigger(user.id, "arbitrum", "v3", "999")).toBe(false);
  });

  // O par (enabled=false, firedAt) é o que impede fechar a mesma posição duas
  // vezes. Se isso quebrar, um gatilho disparado voltaria pro job no ciclo
  // seguinte e tentaria fechar de novo.
  it("marcar como disparado tira do conjunto armado", async () => {
    const user = await usuario();
    await upsertCloseTrigger({ userId: user.id, ...POS, belowPrice: 70_000, abovePrice: null });

    const [armado] = await listArmedTriggers();
    expect(armado).toBeDefined();
    await markTriggerFired(armado!.id, "0xabc");

    expect(await listArmedTriggers()).toHaveLength(0);
    const [g] = await listCloseTriggers(user.id);
    expect(g?.enabled).toBe(false);
    expect(g?.firedAt).toBeInstanceOf(Date);
  });

  // Reconfigurar depois de disparar RESSUSCITA o gatilho — é como o usuário
  // rearma depois de reabrir a posição.
  it("reconfigurar depois de disparar rearma", async () => {
    const user = await usuario();
    await upsertCloseTrigger({ userId: user.id, ...POS, belowPrice: 70_000, abovePrice: null });
    const [armado] = await listArmedTriggers();
    await markTriggerFired(armado!.id, "0xabc");

    await upsertCloseTrigger({ userId: user.id, ...POS, belowPrice: 60_000, abovePrice: null });
    const [g] = await listCloseTriggers(user.id);
    expect(g?.enabled).toBe(true);
    expect(g?.firedAt).toBeNull();
    expect(await listArmedTriggers()).toHaveLength(1);
  });

  // O job precisa do chat (pra avisar) e da wallet (pra ler o preço) junto com
  // o gatilho — buscar em consultas separadas abriria espaço pra divergência.
  it("o conjunto armado traz o chat e a wallet do dono", async () => {
    const user = await usuario("999");
    await upsertCloseTrigger({ userId: user.id, ...POS, belowPrice: 70_000, abovePrice: null });

    const [armado] = await listArmedTriggers();
    expect(armado!.telegramChatId).toBe("999");
    expect(armado!.walletAddress.toLowerCase()).toBe(WALLET.toLowerCase());
  });
});

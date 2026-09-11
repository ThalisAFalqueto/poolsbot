import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPeriodNav, type LiveNavMeasurer } from "../../src/data/period-nav.js";
import { dayBounds, monthBounds, weekBounds } from "../../src/domain/portfolio/periods.js";
import { db } from "../../src/persistence/db.js";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { insertCashFlows } from "../../src/persistence/repositories/wallet-nav.repository.js";
import { walletNavSnapshots } from "../../src/persistence/schema/index.js";
import { truncateAll } from "./db-helper.js";

const WALLET = "0x7965000000000000000000000000000000001404";

// A foto com data D é tirada às 00:00 UTC de D — o patrimônio no INÍCIO do
// dia. É exatamente o que o job faz (ver snapshot-nav.job.ts), e é o que o
// relatório antigo interpretava errado.
async function foto(userId: number, date: string, nav: number, wallet = WALLET) {
  await db.insert(walletNavSnapshots).values({
    userId,
    walletAddress: wallet,
    chain: "arbitrum",
    date,
    navUsdc: nav,
    idleUsdc: nav * 0.2,
    positionsUsdc: nav * 0.8,
    feesUsdc: 0,
    recordedAt: new Date(`${date}T00:00:05Z`),
  });
}

async function aporte(userId: number, id: string, at: string, valor: number) {
  await insertCashFlows([
    { userId, walletAddress: WALLET, chain: "arbitrum", uniqueId: id, direction: "deposit", asset: "USDC", amount: valor, valueUsdc: valor, txHash: id, occurredAt: new Date(at) },
  ]);
}

const aoVivo = (nav: number, at: string): LiveNavMeasurer =>
  vi.fn(async () => ({ navUsdc: nav, idleUsdc: nav, positionsUsdc: 0, feesUsdc: 0, at: new Date(at) }));

describe("loadPeriodNav", () => {
  let userId: number;
  beforeEach(async () => {
    await truncateAll();
    userId = (await findOrCreateUserByTelegramChatId("chat-periodo")).id;
  });

  // O bug real de 11/09/2026: pra setembro, a abertura era a foto de 31/08
  // ($57,96) em vez da de 01/09 00:00 ($58,68).
  it("abertura é a foto do início do período, não a do dia anterior", async () => {
    await foto(userId, "2026-08-31", 57.96);
    await foto(userId, "2026-09-01", 58.68);
    await foto(userId, "2026-09-11", 162.41);

    const r = await loadPeriodNav(userId, monthBounds(new Date("2026-09-11T15:00:00Z")), new Date("2026-09-11T15:00:00Z"), aoVivo(163, "2026-09-11T15:00:00Z"));
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.abertura.navUsdc).toBe(58.68);
  });

  // O outro bug real: posição fechada às 13:13 e o /mes parado na foto das
  // 00:00. Com o período em andamento, o fechamento é medido na hora.
  it("período em andamento fecha com o patrimônio medido agora", async () => {
    await foto(userId, "2026-09-01", 58.68);
    await foto(userId, "2026-09-11", 162.41);
    const medir = aoVivo(164.2, "2026-09-11T15:00:00Z");

    const r = await loadPeriodNav(userId, monthBounds(new Date("2026-09-11T15:00:00Z")), new Date("2026-09-11T15:00:00Z"), medir);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.fechamento.navUsdc).toBe(164.2);
    expect(r.fechamento.live).toBe(true);
    expect(r.liveFalhou).toBe(false);
  });

  it("se a medição ao vivo falha, cai na última foto e sinaliza", async () => {
    await foto(userId, "2026-09-01", 58.68);
    await foto(userId, "2026-09-11", 162.41);
    const quebrada: LiveNavMeasurer = async () => {
      throw new Error("rpc down");
    };

    const r = await loadPeriodNav(userId, monthBounds(new Date("2026-09-11T15:00:00Z")), new Date("2026-09-11T15:00:00Z"), quebrada);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.fechamento.navUsdc).toBe(162.41);
    expect(r.fechamento.live).toBe(false);
    expect(r.liveFalhou).toBe(true);
  });

  // Semana de 31/08 a 06/09: termina às 00:00 de 07/09, que é a foto datada
  // de 07/09. Semana fechada não gasta RPC medindo ao vivo.
  it("período fechado vai da foto do seu início à do início do seguinte, sem medir ao vivo", async () => {
    await foto(userId, "2026-08-31", 57.96);
    await foto(userId, "2026-09-06", 162.07);
    await foto(userId, "2026-09-07", 162.94);
    await foto(userId, "2026-09-08", 162.54);
    const medir = aoVivo(999, "2026-09-11T15:00:00Z");

    const r = await loadPeriodNav(userId, weekBounds(new Date("2026-09-02T12:00:00Z")), new Date("2026-09-11T15:00:00Z"), medir);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.abertura.navUsdc).toBe(57.96);
    expect(r.fechamento.navUsdc).toBe(162.94);
    expect(medir).not.toHaveBeenCalled();
  });

  // Aporte no último dia do mês anterior já está dentro da foto de abertura;
  // contá-lo de novo como fluxo do mês o subtrairia duas vezes.
  it("aportes contam entre os dois instantes medidos", async () => {
    await foto(userId, "2026-09-01", 58.68);
    await aporte(userId, "agosto", "2026-08-31T12:00:00Z", 10);
    await aporte(userId, "setembro", "2026-09-05T20:25:04Z", 102.43);

    const r = await loadPeriodNav(userId, monthBounds(new Date("2026-09-11T15:00:00Z")), new Date("2026-09-11T15:00:00Z"), aoVivo(164, "2026-09-11T15:00:00Z"));
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.fluxos.map((f) => f.uniqueId)).toEqual(["setembro"]);
  });

  // Antes era limit(1): com duas wallets, o patrimônio seria o de uma só.
  it("soma todas as wallets da mesma foto", async () => {
    await foto(userId, "2026-09-01", 50);
    await foto(userId, "2026-09-01", 8.68, "0x0000000000000000000000000000000000000002");

    const r = await loadPeriodNav(userId, monthBounds(new Date("2026-09-11T15:00:00Z")), new Date("2026-09-11T15:00:00Z"), aoVivo(164, "2026-09-11T15:00:00Z"));
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.abertura.navUsdc).toBeCloseTo(58.68, 10);
  });

  // /dia de hoje com só a foto de hoje e a medição ao vivo falhando: abertura
  // e fechamento seriam a mesma foto, e o resultado sairia zero disfarçado.
  it("a mesma foto dos dois lados não vira resultado", async () => {
    await foto(userId, "2026-09-11", 162.41);
    const r = await loadPeriodNav(userId, dayBounds(new Date("2026-09-11T15:00:00Z")), new Date("2026-09-11T15:00:00Z"));
    expect(r.status).toBe("sem-dados");
  });

  it("sem foto até o início do período, não há abertura", async () => {
    await foto(userId, "2026-09-11", 162.41);
    const r = await loadPeriodNav(userId, monthBounds(new Date("2026-09-11T15:00:00Z")), new Date("2026-09-11T15:00:00Z"), aoVivo(164, "2026-09-11T15:00:00Z"));
    expect(r.status).toBe("sem-abertura");
  });
});

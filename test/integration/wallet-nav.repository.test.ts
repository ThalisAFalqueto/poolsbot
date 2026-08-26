import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import {
  findLatestCashFlowAt,
  findLatestNavSnapshotUpTo,
  hasSnapshotForDate,
  insertCashFlows,
  insertNavSnapshots,
  listCashFlowsBetween,
  listNavSnapshotsBetween,
  type CashFlowInput,
  type NavSnapshotInput,
} from "../../src/persistence/repositories/wallet-nav.repository.js";
import { truncateAll } from "./db-helper.js";

const WALLET = "0xabc0000000000000000000000000000000000001";
const CHAIN = "arbitrum";

function makeSnapshot(userId: number, date: string, nav: number): NavSnapshotInput {
  return {
    userId,
    walletAddress: WALLET,
    chain: CHAIN,
    date,
    navUsdc: nav,
    idleUsdc: nav * 0.2,
    positionsUsdc: nav * 0.75,
    feesUsdc: nav * 0.05,
  };
}

function makeFlow(userId: number, uniqueId: string, at: string, value: number): CashFlowInput {
  return {
    userId,
    walletAddress: WALLET,
    chain: CHAIN,
    uniqueId,
    direction: "deposit",
    asset: "USDC",
    amount: value,
    valueUsdc: value,
    txHash: `0xhash${uniqueId}`,
    occurredAt: new Date(at),
  };
}

describe("wallet-nav.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("fotos de patrimônio", () => {
    it("grava e lê fotos dentro de um intervalo de datas", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      await insertNavSnapshots([
        makeSnapshot(user.id, "2026-08-31", 100),
        makeSnapshot(user.id, "2026-09-15", 110),
        makeSnapshot(user.id, "2026-10-02", 120),
      ]);

      const setembro = await listNavSnapshotsBetween(user.id, "2026-09-01", "2026-09-30");
      expect(setembro).toHaveLength(1);
      expect(setembro[0]?.navUsdc).toBe(110);
    });

    // A primeira foto do dia é a que vale: o job roda a cada 15min e sai cedo
    // quando já existe linha de hoje, mas duas execuções concorrentes podem
    // chegar juntas — a segunda tem que virar no-op, não erro.
    it("segunda foto do mesmo dia é ignorada em vez de falhar", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      await insertNavSnapshots([makeSnapshot(user.id, "2026-09-01", 100)]);
      await insertNavSnapshots([makeSnapshot(user.id, "2026-09-01", 999)]);

      const rows = await listNavSnapshotsBetween(user.id, "2026-09-01", "2026-09-01");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.navUsdc).toBe(100); // a original, não a duplicata
    });

    it("hasSnapshotForDate é o atalho que evita gastar RPC duas vezes no mesmo dia", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      expect(await hasSnapshotForDate(user.id, "2026-09-01")).toBe(false);
      await insertNavSnapshots([makeSnapshot(user.id, "2026-09-01", 100)]);
      expect(await hasSnapshotForDate(user.id, "2026-09-01")).toBe(true);
    });

    // Abertura do mês não exige foto exatamente no dia 1º: se o bot ficou fora
    // do ar naquele dia, a última anterior serve de referência.
    it("acha a foto de abertura mais recente antes de uma data", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      await insertNavSnapshots([makeSnapshot(user.id, "2026-08-28", 90), makeSnapshot(user.id, "2026-08-30", 95)]);

      const abertura = await findLatestNavSnapshotUpTo(user.id, "2026-08-31");
      expect(abertura?.date).toBe("2026-08-30");
      expect(abertura?.navUsdc).toBe(95);
    });

    it("devolve null quando não existe foto anterior à data pedida", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      await insertNavSnapshots([makeSnapshot(user.id, "2026-09-10", 100)]);
      expect(await findLatestNavSnapshotUpTo(user.id, "2026-08-31")).toBeNull();
    });
  });

  describe("fluxos de caixa", () => {
    // O job relê janelas sobrepostas de propósito (pra não perder transferência
    // por atraso de indexação) — sem o dedup por uniqueId, cada execução
    // duplicaria os aportes e o P&L do mês afundaria.
    it("não duplica o mesmo fluxo quando o job relê a mesma transferência", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      const flow = makeFlow(user.id, "uniq-1", "2026-09-05T10:00:00Z", 50);
      await insertCashFlows([flow]);
      await insertCashFlows([flow]);

      const rows = await listCashFlowsBetween(user.id, new Date("2026-09-01"), new Date("2026-10-01"));
      expect(rows).toHaveLength(1);
    });

    it("filtra fluxos por período", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      await insertCashFlows([
        makeFlow(user.id, "uniq-ago", "2026-08-20T10:00:00Z", 50),
        makeFlow(user.id, "uniq-set", "2026-09-05T10:00:00Z", 30),
      ]);

      const setembro = await listCashFlowsBetween(user.id, new Date("2026-09-01"), new Date("2026-10-01"));
      expect(setembro).toHaveLength(1);
      expect(setembro[0]?.valueUsdc).toBe(30);
    });

    it("findLatestCashFlowAt devolve o mais recente, ou null sem nenhum", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      expect(await findLatestCashFlowAt(user.id)).toBeNull();

      await insertCashFlows([
        makeFlow(user.id, "uniq-1", "2026-09-05T10:00:00Z", 10),
        makeFlow(user.id, "uniq-2", "2026-09-20T10:00:00Z", 20),
      ]);
      const latest = await findLatestCashFlowAt(user.id);
      expect(latest?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/persistence/db.js";
import { findOrCreateUserByTelegramChatId, setWalletAddress } from "../../src/persistence/repositories/users.repository.js";
import {
  deleteStalePositions,
  getIlAlertState,
  getIlBaseline,
  getPositionState,
  listUsersWithWallet,
  syncIlBaseline,
  updateIlAlertState,
  updatePositionState,
  upsertPositions,
  type PositionUpsertInput,
} from "../../src/persistence/repositories/lp-positions.repository.js";
import { truncateAll } from "./db-helper.js";

const CHAIN = "arbitrum";

function makeInput(overrides: Partial<PositionUpsertInput> = {}): PositionUpsertInput {
  return {
    userId: 1,
    chain: CHAIN,
    tokenId: "100",
    poolAddress: "0x0000000000000000000000000000000000000001",
    token0Address: "0x0000000000000000000000000000000000000002",
    token1Address: "0x0000000000000000000000000000000000000003",
    token0Symbol: "WETH",
    token1Symbol: "USDC",
    token0Decimals: 18,
    token1Decimals: 6,
    fee: 3000,
    tickLower: -6931,
    tickUpper: 6931,
    ...overrides,
  };
}

describe("lp-positions.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("listUsersWithWallet", () => {
    it("só retorna usuários com walletAddress preenchido", async () => {
      const withWallet = await findOrCreateUserByTelegramChatId("chat-1");
      await setWalletAddress(withWallet.id, "0xabc");
      await findOrCreateUserByTelegramChatId("chat-2"); // sem wallet

      const users = await listUsersWithWallet();
      expect(users).toHaveLength(1);
      expect(users[0]?.telegramChatId).toBe("chat-1");
    });
  });

  describe("upsertPositions", () => {
    it("cria posição nova + estado inicial in_range", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      const [result] = await upsertPositions([makeInput({ userId: user.id })]);

      expect(result?.isNew).toBe(true);
      const state = await getPositionState(result!.id);
      expect(state.status).toBe("in_range");
    });

    it("segunda chamada com o mesmo tokenId+chain atualiza em vez de duplicar", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-2");
      const first = await upsertPositions([makeInput({ userId: user.id, tickLower: -100 })]);
      const second = await upsertPositions([makeInput({ userId: user.id, tickLower: -200 })]);

      expect(second[0]?.isNew).toBe(false);
      expect(second[0]?.id).toBe(first[0]?.id);

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_positions`);
      expect(Number(count.rows[0]?.count)).toBe(1);

      const result = await db.execute<{ tick_lower: number }>(sql`SELECT tick_lower FROM lp_positions`);
      expect(result.rows[0]?.tick_lower).toBe(-200); // confirma que o update aconteceu de verdade
    });
  });

  describe("deleteStalePositions", () => {
    it("remove só as posições que não estão mais na lista ativa", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      await upsertPositions([
        makeInput({ userId: user.id, tokenId: "1" }),
        makeInput({ userId: user.id, tokenId: "2" }),
      ]);

      await deleteStalePositions(user.id, CHAIN, ["1"]); // "2" não está mais ativa

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_positions`);
      expect(Number(count.rows[0]?.count)).toBe(1);
    });

    it("lista de tokenIds ativos vazia remove todas as posições do usuário/chain", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-2");
      await upsertPositions([makeInput({ userId: user.id, tokenId: "1" })]);

      await deleteStalePositions(user.id, CHAIN, []);

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_positions`);
      expect(Number(count.rows[0]?.count)).toBe(0);
    });

    it("cascade limpa lp_position_state junto", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-3");
      await upsertPositions([makeInput({ userId: user.id, tokenId: "1" })]);
      await deleteStalePositions(user.id, CHAIN, []);

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_position_state`);
      expect(Number(count.rows[0]?.count)).toBe(0);
    });
  });

  describe("getPositionState / updatePositionState", () => {
    it("round-trip preserva os campos", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id })]);
      const since = new Date();

      await updatePositionState(id, { status: "out_of_range", outOfRangeSince: since, lastNotifiedAt: since });
      const state = await getPositionState(id);

      expect(state.status).toBe("out_of_range");
      expect(state.outOfRangeSince?.getTime()).toBe(since.getTime());
    });

    it("lança erro se a posição não existe", async () => {
      await expect(getPositionState(999999)).rejects.toThrow();
    });
  });

  describe("syncIlBaseline", () => {
    it("cria o baseline na primeira chamada", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id })]);

      const baseline = await syncIlBaseline(id, { liquidity: 1000n, sqrtPriceX96: 2n ** 96n, tick: 0 });
      expect(baseline.wasReset).toBe(false);
      expect(baseline.liquidity).toBe(1000n);
    });

    it("mantém o baseline (keep) quando a liquidez não mudou", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-2");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id })]);

      const first = await syncIlBaseline(id, { liquidity: 1000n, sqrtPriceX96: 2n ** 96n, tick: 0 });
      const second = await syncIlBaseline(id, { liquidity: 1000n, sqrtPriceX96: 3n ** 96n, tick: 100 });

      expect(second.recordedAt.getTime()).toBe(first.recordedAt.getTime()); // não regravou
      expect(second.sqrtPriceX96).toBe(first.sqrtPriceX96); // manteve o preço original
    });

    it("reseta o baseline quando a liquidez mudou", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-3");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id })]);

      await syncIlBaseline(id, { liquidity: 1000n, sqrtPriceX96: 2n ** 96n, tick: 0 });
      const second = await syncIlBaseline(id, { liquidity: 2000n, sqrtPriceX96: 3n ** 96n, tick: 100 });

      expect(second.wasReset).toBe(true);
      expect(second.liquidity).toBe(2000n);

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_position_il_baseline`);
      expect(Number(count.rows[0]?.count)).toBe(1); // não duplicou linha
    });

    it("getIlBaseline retorna null quando ainda não existe", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-4");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id })]);
      expect(await getIlBaseline(id)).toBeNull();
    });
  });

  describe("getIlAlertState / updateIlAlertState", () => {
    it("getIlAlertState retorna default 'ok' quando nunca avaliado", async () => {
      const state = await getIlAlertState(999999);
      expect(state.status).toBe("ok");
      expect(state.triggeredAt).toBeNull();
    });

    it("updateIlAlertState grava e getIlAlertState lê de volta", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id })]);
      const now = new Date();

      await updateIlAlertState(id, { status: "triggered", triggeredAt: now, lastNotifiedAt: now });
      const state = await getIlAlertState(id);

      expect(state.status).toBe("triggered");
      expect(state.triggeredAt?.getTime()).toBe(now.getTime());
    });

    it("chamadas repetidas fazem upsert, sem duplicar linha", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-2");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id })]);

      await updateIlAlertState(id, { status: "triggered", triggeredAt: new Date(), lastNotifiedAt: new Date() });
      await updateIlAlertState(id, { status: "ok", triggeredAt: null, lastNotifiedAt: null });

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_position_il_alert_state`);
      expect(Number(count.rows[0]?.count)).toBe(1);
    });
  });
});

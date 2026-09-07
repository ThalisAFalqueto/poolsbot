import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/persistence/db.js";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { addWallet } from "../../src/persistence/repositories/user-wallets.repository.js";
import {
  archiveStalePositions,
  deleteConfirmedClosedPositions,
  getIlAlertState,
  getIlBaseline,
  getPositionState,
  listClosedPositions,
  listStalePositionCandidates,
  listUserWallets,
  setMintGas,
  syncIlBaseline,
  updateIlAlertState,
  updatePositionSnapshot,
  updatePositionState,
  upsertPositions,
  type ActivePositionKey,
  type CloseGasResult,
  type PositionUpsertInput,
} from "../../src/persistence/repositories/lp-positions.repository.js";
import { truncateAll } from "./db-helper.js";

const CHAIN = "arbitrum";

function makeInput(overrides: Partial<PositionUpsertInput> = {}): PositionUpsertInput {
  return {
    userId: 1,
    chain: CHAIN,
    tokenId: "100",
    protocol: "v3",
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

  describe("listUserWallets", () => {
    it("só retorna usuários com pelo menos uma wallet vinculada", async () => {
      const withWallet = await findOrCreateUserByTelegramChatId("chat-1");
      await addWallet(withWallet.id, "0xabc");
      await findOrCreateUserByTelegramChatId("chat-2"); // sem wallet

      const rows = await listUserWallets();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.telegramChatId).toBe("chat-1");
    });

    it("retorna uma linha por wallet quando o usuário tem mais de uma", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-3");
      await addWallet(user.id, "0xabc");
      await addWallet(user.id, "0xdef");

      const rows = await listUserWallets();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.userId === user.id)).toBe(true);
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

  // Combina os 3 passos (listar candidatos -> arquivar -> deletar) — mesmo
  // fluxo que check-positions.job.ts orquestra de verdade (com range
  // ilimitado de eth_getLogs desde o upgrade da Alchemy, o gas de close já
  // é buscado ANTES de arquivar, não depois — closeGasByPositionId vazio
  // por padrão é o caso "não achou gas de close", já coberto por
  // hasCompleteSnapshot decidir arquivar mesmo assim).
  // Aceita tokenId cru ("1") como atalho — vira uma chave {tokenId, protocol}
  // com o protocolo padrão do fixture (v3), que é o caso da maioria dos
  // testes. Quem precisa exercitar a colisão V3/V4 passa a chave completa.
  async function archiveAndDelete(
    userId: number,
    chain: string,
    active: (string | ActivePositionKey)[],
    closeGasByPositionId = new Map<number, CloseGasResult>()
  ) {
    const activeKeys: ActivePositionKey[] = active.map((a) => (typeof a === "string" ? { tokenId: a, protocol: "v3" } : a));
    const candidates = await listStalePositionCandidates(userId, chain, activeKeys);
    await archiveStalePositions(candidates, closeGasByPositionId, "ETH");
    // O job só apaga o que CONFIRMOU fechado on-chain (ver
    // data/onchain/confirm-closed.ts). Aqui o helper simula a confirmação
    // tendo dado positiva pra todos os candidatos — os testes deste bloco são
    // sobre a reconciliação em si, não sobre a confirmação.
    await deleteConfirmedClosedPositions(
      userId,
      chain,
      candidates.map((c) => ({ tokenId: c.tokenId, protocol: c.protocol }))
    );
  }

  describe("listStalePositionCandidates / archiveStalePositions / deleteConfirmedClosedPositions", () => {
    it("remove só as posições que não estão mais na lista ativa", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      await upsertPositions([
        makeInput({ userId: user.id, tokenId: "1" }),
        makeInput({ userId: user.id, tokenId: "2" }),
      ]);

      await archiveAndDelete(user.id, CHAIN, ["1"]); // "2" não está mais ativa

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_positions`);
      expect(Number(count.rows[0]?.count)).toBe(1);
    });

    // Bug real (achado em auditoria, 26/08/2026): a staleness era casada só
    // por tokenId, então uma posição V4 ATIVA com o mesmo número "protegia"
    // uma V3 já fechada — que nunca era arquivada nem removida, ficando presa
    // no banco pra sempre. tokenId só é único DENTRO de um contrato.
    it("mesmo tokenId em V3 e V4: fechar só a V3 não pode ser mascarado pela V4 ativa", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      await upsertPositions([
        makeInput({ userId: user.id, tokenId: "198755", protocol: "v3" }),
        makeInput({ userId: user.id, tokenId: "198755", protocol: "v4" }),
      ]);

      // só a V4 continua ativa on-chain; a V3 homônima foi fechada
      await archiveAndDelete(user.id, CHAIN, [{ tokenId: "198755", protocol: "v4" }]);

      const remaining = await db.execute<{ protocol: string }>(sql`SELECT protocol FROM lp_positions`);
      expect(remaining.rows).toHaveLength(1);
      expect(remaining.rows[0]?.protocol).toBe("v4"); // a V3 fechada saiu, a V4 ativa ficou
    });

    it("lista de tokenIds ativos vazia remove todas as posições do usuário/chain", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-2");
      await upsertPositions([makeInput({ userId: user.id, tokenId: "1" })]);

      await archiveAndDelete(user.id, CHAIN, []);

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_positions`);
      expect(Number(count.rows[0]?.count)).toBe(0);
    });

    it("cascade limpa lp_position_state junto", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-3");
      await upsertPositions([makeInput({ userId: user.id, tokenId: "1" })]);
      await archiveAndDelete(user.id, CHAIN, []);

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_position_state`);
      expect(Number(count.rows[0]?.count)).toBe(0);
    });

    it("sem snapshot conhecido (nunca passou por /positions), fecha sem arquivar — comportamento antigo preservado", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-4");
      await upsertPositions([makeInput({ userId: user.id, tokenId: "1" })]);

      await archiveAndDelete(user.id, CHAIN, []);

      const closed = await listClosedPositions(user.id);
      expect(closed).toHaveLength(0);
    });

    it("com snapshot conhecido, arquiva em closed_lp_positions ANTES de deletar", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-5");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id, tokenId: "1" })]);
      const entryDate = new Date("2026-08-01T00:00:00Z");

      await updatePositionSnapshot(id, {
        entryValueToken1: 100,
        positionValueToken1: 95,
        feesValueToken1: 3,
        hodlValueToken1: 98,
        ilToken1: -3,
        totalPnlToken1: -2,
        entryDate,
      });

      await archiveAndDelete(user.id, CHAIN, []);

      const closed = await listClosedPositions(user.id);
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({
        chain: CHAIN,
        tokenId: "1",
        token1Address: makeInput().token1Address,
        entryValueToken1: 100,
        finalPositionValueToken1: 95,
        finalFeesValueToken1: 3,
        hodlValueToken1: 98,
        ilToken1: -3,
        totalPnlToken1: -2,
      });
      expect(closed[0]?.openedAt.getTime()).toBe(entryDate.getTime());

      const count = await db.execute<{ count: string }>(sql`SELECT count(*) FROM lp_positions`);
      expect(Number(count.rows[0]?.count)).toBe(0); // ainda deletou a linha viva
    });

    it("mintGasNative/mintGasTxHash fluem de lp_positions pra closed_lp_positions", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-6");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id, tokenId: "1" })]);

      await updatePositionSnapshot(id, {
        entryValueToken1: 100,
        positionValueToken1: 95,
        feesValueToken1: 3,
        hodlValueToken1: 98,
        ilToken1: -3,
        totalPnlToken1: -2,
        entryDate: new Date("2026-08-01T00:00:00Z"),
      });
      await setMintGas(id, { gasNative: 0.00042, txHash: "0xmint" });

      await archiveAndDelete(user.id, CHAIN, []);

      const closed = await listClosedPositions(user.id);
      expect(closed[0]?.mintGasNative).toBeCloseTo(0.00042, 10);
      expect(closed[0]?.mintGasTxHash).toBe("0xmint");
      expect(closed[0]?.nativeGasSymbol).toBe("ETH");
    });

    it("closeGasNative/closeGasTxHashes gravados quando presentes no map, null quando ausentes", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-7");
      const [pos1, pos2] = await upsertPositions([
        makeInput({ userId: user.id, tokenId: "1" }),
        makeInput({ userId: user.id, tokenId: "2" }),
      ]);
      for (const p of [pos1!, pos2!]) {
        await updatePositionSnapshot(p.id, {
          entryValueToken1: 100,
          positionValueToken1: 95,
          feesValueToken1: 3,
          hodlValueToken1: 98,
          ilToken1: -3,
          totalPnlToken1: -2,
          entryDate: new Date("2026-08-01T00:00:00Z"),
        });
      }

      const closeGasByPositionId = new Map<number, CloseGasResult>([
        [pos1!.id, { closeGasNative: 0.0007, closeGasTxHashes: ["0xa", "0xb"] }],
      ]);
      await archiveAndDelete(user.id, CHAIN, [], closeGasByPositionId);

      const closed = await listClosedPositions(user.id);
      const closed1 = closed.find((c) => c.tokenId === "1");
      const closed2 = closed.find((c) => c.tokenId === "2");
      expect(closed1?.closeGasNative).toBeCloseTo(0.0007, 10);
      expect(closed1?.closeGasTxHashes).toBe("0xa,0xb");
      expect(closed2?.closeGasNative).toBeNull();
      expect(closed2?.closeGasTxHashes).toBeNull();
    });
  });

  describe("setMintGas", () => {
    it("grava gasNative/txHash na posição", async () => {
      const user = await findOrCreateUserByTelegramChatId("chat-1");
      const [{ id }] = await upsertPositions([makeInput({ userId: user.id })]);

      await setMintGas(id, { gasNative: 0.00015, txHash: "0xabc" });

      const row = await db.execute<{ mint_gas_native: string; mint_gas_tx_hash: string }>(
        sql`SELECT mint_gas_native, mint_gas_tx_hash FROM lp_positions WHERE id = ${id}`
      );
      expect(Number(row.rows[0]?.mint_gas_native)).toBeCloseTo(0.00015, 10);
      expect(row.rows[0]?.mint_gas_tx_hash).toBe("0xabc");
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

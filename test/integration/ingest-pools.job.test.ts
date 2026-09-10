import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/persistence/db.js";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { watchPool } from "../../src/persistence/repositories/watched-pools.repository.js";
import { truncateAll } from "./db-helper.js";

// fetchAllPools é a única fronteira externa deste job — mockar em vez de
// bater na API real da DefiLlama mantém o teste rápido e determinístico.
vi.mock("../../src/data/defillama/client.js", () => ({
  fetchAllPools: vi.fn(),
}));

// readPoolPrices lê o contrato — mockado pelo mesmo motivo que a DefiLlama.
vi.mock("../../src/data/onchain/pool-price.js", () => ({
  readPoolPrices: vi.fn(),
}));

import { fetchAllPools } from "../../src/data/defillama/client.js";
import { readPoolPrices } from "../../src/data/onchain/pool-price.js";
import { ingestPoolsJob } from "../../src/scheduler/jobs/ingest-pools.job.js";

const mockedFetchAllPools = vi.mocked(fetchAllPools);
const mockedReadPoolPrices = vi.mocked(readPoolPrices);

function makePool(poolId: string, overrides: Record<string, unknown> = {}) {
  return {
    pool: poolId,
    chain: "Arbitrum",
    project: "uniswap-v3",
    symbol: "WETH-USDC",
    tvlUsd: 1_000_000,
    apyBase: 10,
    apyReward: null,
    apy: 10,
    apyPct1D: null,
    apyPct7D: null,
    apyPct30D: null,
    stablecoin: false,
    ilRisk: "no",
    il7d: null,
    sigma: null,
    apyMean30d: null,
    apyBase7d: null,
    volumeUsd1d: null,
    volumeUsd7d: null,
    outlier: false,
    ...overrides,
  };
}

describe("ingestPoolsJob", () => {
  beforeEach(async () => {
    await truncateAll();
    mockedFetchAllPools.mockReset();
    mockedReadPoolPrices.mockReset();
    mockedReadPoolPrices.mockResolvedValue([]);
  });

  it("não chama a API se não há pools observados por ninguém", async () => {
    await ingestPoolsJob();
    expect(mockedFetchAllPools).not.toHaveBeenCalled();
  });

  it("insere um snapshot pro pool observado encontrado na resposta", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    await watchPool(user.id, "pool-a", "Arbitrum");
    mockedFetchAllPools.mockResolvedValue([makePool("pool-a")] as any);

    await ingestPoolsJob();

    const rows = await db.execute<{ count: string }>(sql`SELECT count(*) FROM apy_history WHERE pool_id = 'pool-a'`);
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });

  it("pula pool não encontrado na resposta da DefiLlama sem lançar erro", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-2");
    await watchPool(user.id, "pool-inexistente", "Arbitrum");
    mockedFetchAllPools.mockResolvedValue([]);

    await expect(ingestPoolsJob()).resolves.not.toThrow();
    const rows = await db.execute<{ count: string }>(sql`SELECT count(*) FROM apy_history`);
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  it("falha na API não derruba o job", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-3");
    await watchPool(user.id, "pool-a", "Arbitrum");
    mockedFetchAllPools.mockRejectedValue(new Error("network down"));

    await expect(ingestPoolsJob()).resolves.not.toThrow();
    const rows = await db.execute<{ count: string }>(sql`SELECT count(*) FROM apy_history`);
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  // O buraco que isso fecha (10/09/2026): o preço só era gravado pra pool com
  // POSIÇÃO ABERTA, então a pool que o usuário estava avaliando pra entrar não
  // tinha histórico — justo quando ele precisa decidir a faixa.
  it("grava o preço da pool observada", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-4");
    await watchPool(user.id, "pool-a", "Arbitrum");
    mockedFetchAllPools.mockResolvedValue([makePool("pool-a")] as any);
    mockedReadPoolPrices.mockResolvedValue([
      { chain: "arbitrum", poolAddress: "0xPOOL", price: 76_964, recordedAt: new Date(), source: "onchain_ingest" },
    ]);

    const resumo = await ingestPoolsJob();

    const rows = await db.execute<{ count: string }>(sql`SELECT count(*) FROM pool_price_history`);
    expect(Number(rows.rows[0]?.count)).toBe(1);
    expect(resumo).toContain("1 preço(s)");
  });

  it("só manda pra leitura de preço as pools que a DefiLlama devolveu", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-5");
    await watchPool(user.id, "pool-a", "Arbitrum");
    await watchPool(user.id, "pool-sumida", "Arbitrum");
    mockedFetchAllPools.mockResolvedValue([makePool("pool-a")] as any);

    await ingestPoolsJob();

    expect(mockedReadPoolPrices).toHaveBeenCalledWith([expect.objectContaining({ poolId: "pool-a" })]);
  });

  // O snapshot de APY já foi gravado quando a leitura de preço acontece; uma
  // falha de RPC não pode desfazer o que a DefiLlama já entregou.
  it("falha ao ler preço não perde o snapshot de APY", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-6");
    await watchPool(user.id, "pool-a", "Arbitrum");
    mockedFetchAllPools.mockResolvedValue([makePool("pool-a")] as any);
    mockedReadPoolPrices.mockRejectedValue(new Error("rpc down"));

    await expect(ingestPoolsJob()).resolves.not.toThrow();

    const rows = await db.execute<{ count: string }>(sql`SELECT count(*) FROM apy_history WHERE pool_id = 'pool-a'`);
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });
});

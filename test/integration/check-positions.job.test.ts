import { beforeEach, describe, expect, it, vi } from "vitest";
import { findOrCreateUserByTelegramChatId, setWalletAddress } from "../../src/persistence/repositories/users.repository.js";
import { truncateAll } from "./db-helper.js";

vi.mock("../../src/data/onchain/client.js", () => ({
  fetchPositionsForWallet: vi.fn(),
}));
vi.mock("../../src/notifications/dispatch-signal.js", () => ({
  dispatchSignal: vi.fn().mockResolvedValue(undefined),
}));

import { fetchPositionsForWallet } from "../../src/data/onchain/client.js";
import { dispatchSignal } from "../../src/notifications/dispatch-signal.js";
import { checkPositionsJob } from "../../src/scheduler/jobs/check-positions.job.js";

const mockedFetch = vi.mocked(fetchPositionsForWallet);
const mockedDispatch = vi.mocked(dispatchSignal);

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    tokenId: 1n,
    poolAddress: "0x0000000000000000000000000000000000000001",
    fee: 3000,
    tickLower: -1000,
    tickUpper: 1000,
    currentTick: 0,
    sqrtPriceX96: 2n ** 96n,
    liquidity: 1_000_000_000n,
    token0: { address: "0x0000000000000000000000000000000000000002", decimals: 18, symbol: "WETH" },
    token1: { address: "0x0000000000000000000000000000000000000003", decimals: 6, symbol: "USDC" },
    ...overrides,
  };
}

describe("checkPositionsJob", () => {
  beforeEach(async () => {
    await truncateAll();
    mockedFetch.mockReset();
    mockedDispatch.mockClear();
  });

  it("não chama RPC se nenhum usuário tem wallet vinculada", async () => {
    await checkPositionsJob();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("primeira leitura cria a posição in_range sem notificar", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    await setWalletAddress(user.id, "0xabc");
    mockedFetch.mockResolvedValue([makePosition({ currentTick: 0 })] as any);

    await checkPositionsJob();
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it("notifica quando a posição sai de range entre dois ciclos", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-2");
    await setWalletAddress(user.id, "0xabc");

    mockedFetch.mockResolvedValue([makePosition({ currentTick: 0 })] as any);
    await checkPositionsJob(); // 1º ciclo: cria estado in_range

    mockedFetch.mockResolvedValue([makePosition({ currentTick: 1500 })] as any); // rompeu tickUpper=1000
    await checkPositionsJob(); // 2º ciclo: detecta out_of_range

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
  });

  it("falha de RPC pra um usuário não impede o processamento dos outros", async () => {
    const userA = await findOrCreateUserByTelegramChatId("chat-a");
    await setWalletAddress(userA.id, "0xaaa");
    const userB = await findOrCreateUserByTelegramChatId("chat-b");
    await setWalletAddress(userB.id, "0xbbb");

    mockedFetch.mockImplementation(async (address: string) => {
      if (address === "0xaaa") throw new Error("RPC timeout");
      return [makePosition()] as any;
    });

    await expect(checkPositionsJob()).resolves.not.toThrow();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

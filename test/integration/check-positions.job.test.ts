import { beforeEach, describe, expect, it, vi } from "vitest";
import { chains } from "../../src/config/chains.js";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { addWallet } from "../../src/persistence/repositories/user-wallets.repository.js";
import { truncateAll } from "./db-helper.js";

vi.mock("../../src/data/onchain/client.js", () => ({
  fetchPositionsForWallets: vi.fn(),
  getGasPrice: vi.fn().mockResolvedValue(20_000_000_000n), // 20 gwei, placeholder
  // null = "sem histórico suficiente" (mesmo contrato de uma chamada real
  // que reverteu) — força os testes a caírem no heurístico de range por
  // padrão, sem precisar simular o oráculo TWAP em cada um.
  fetchTickCumulatives: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/notifications/dispatch-signal.js", () => ({
  dispatchSignal: vi.fn().mockResolvedValue(undefined),
}));

import { fetchPositionsForWallets, fetchTickCumulatives, getGasPrice } from "../../src/data/onchain/client.js";
import { dispatchSignal } from "../../src/notifications/dispatch-signal.js";
import { checkPositionsJob } from "../../src/scheduler/jobs/check-positions.job.js";

const mockedFetch = vi.mocked(fetchPositionsForWallets);
const mockedGasPrice = vi.mocked(getGasPrice);
const mockedTickCumulatives = vi.mocked(fetchTickCumulatives);
const mockedDispatch = vi.mocked(dispatchSignal);

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    chain: "arbitrum",
    walletAddress: "0xabc",
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
    mockedGasPrice.mockClear();
    mockedTickCumulatives.mockClear();
    mockedDispatch.mockClear();
  });

  it("não chama RPC se nenhum usuário tem wallet vinculada", async () => {
    await checkPositionsJob();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("primeira leitura cria a posição in_range sem notificar", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-1");
    await addWallet(user.id, "0xabc");
    mockedFetch.mockResolvedValue([{ chain: "arbitrum", positions: [makePosition({ currentTick: 0 })] }] as any);

    await checkPositionsJob();
    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it("notifica quando a posição sai de range entre dois ciclos", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-2");
    await addWallet(user.id, "0xabc");

    mockedFetch.mockResolvedValue([{ chain: "arbitrum", positions: [makePosition({ currentTick: 0 })] }] as any);
    await checkPositionsJob(); // 1º ciclo: cria estado in_range

    mockedFetch.mockResolvedValue([
      { chain: "arbitrum", positions: [makePosition({ currentTick: 1500 })] }, // rompeu tickUpper=1000
    ] as any);
    await checkPositionsJob(); // 2º ciclo: detecta out_of_range

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
  });

  it("ciclo sem nenhuma posição fora de range não busca preço de gas", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-no-gas");
    await addWallet(user.id, "0xabc");
    mockedFetch.mockResolvedValue([{ chain: "arbitrum", positions: [makePosition({ currentTick: 0 })] }] as any);

    await checkPositionsJob();
    expect(mockedGasPrice).not.toHaveBeenCalled();
  });

  it("posição fora de range busca preço de gas e inclui o custo estimado na notificação", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-gas");
    await addWallet(user.id, "0xabc");

    // token0 precisa ser o endereço REAL de WETH na Arbitrum — a detecção
    // em estimate-gas-cost.ts é por endereço, não por símbolo.
    const weth = { address: chains.arbitrum.wethAddress, decimals: 18, symbol: "WETH" };

    mockedFetch.mockResolvedValue([{ chain: "arbitrum", positions: [makePosition({ currentTick: 0, token0: weth })] }] as any);
    await checkPositionsJob(); // 1º ciclo: cria estado in_range, sem gas

    mockedFetch.mockResolvedValue([{ chain: "arbitrum", positions: [makePosition({ currentTick: 1500, token0: weth })] }] as any);
    await checkPositionsJob(); // 2º ciclo: fora de range

    expect(mockedGasPrice).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    const [signal] = mockedDispatch.mock.calls[0]!;
    expect(signal.reason).toContain("Custo estimado de rebalance");
  });

  it("posição fora de range com histórico de preço disponível calibra a faixa por volatilidade real (não cai no heurístico)", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-volatility");
    await addWallet(user.id, "0xabc");

    mockedFetch.mockResolvedValue([{ chain: "arbitrum", positions: [makePosition({ currentTick: 0 })] }] as any);
    await checkPositionsJob(); // 1º ciclo: cria estado in_range

    // simula o oráculo respondendo com histórico suficiente já na 1ª
    // janela tentada (7 dias): 13 checkpoints (12 intervalos), tick médio
    // não-degenerado em cada um.
    mockedTickCumulatives.mockResolvedValue(Array.from({ length: 13 }, (_, i) => BigInt(i) * 1000n) as any);
    mockedFetch.mockResolvedValue([{ chain: "arbitrum", positions: [makePosition({ currentTick: 1500 })] }] as any);
    await checkPositionsJob(); // 2º ciclo: fora de range

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    const [signal] = mockedDispatch.mock.calls[0]!;
    expect(signal.reason).toContain("calibrada por volatilidade real");
    expect(signal.reason).toContain("7d");
  });

  it("falha ao buscar posições de um usuário não impede o processamento dos outros", async () => {
    const userA = await findOrCreateUserByTelegramChatId("chat-a");
    await addWallet(userA.id, "0xaaa");
    const userB = await findOrCreateUserByTelegramChatId("chat-b");
    await addWallet(userB.id, "0xbbb");

    mockedFetch.mockImplementation(async (addresses: string[]) => {
      if (addresses.includes("0xaaa")) throw new Error("RPC timeout");
      return [{ chain: "arbitrum", positions: [makePosition()] }] as any;
    });

    await expect(checkPositionsJob()).resolves.not.toThrow();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("mesmo tokenId em chains diferentes não confunde estado (regressão do bug de chave composta)", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-multi");
    await addWallet(user.id, "0xabc");

    mockedFetch.mockResolvedValue([
      { chain: "arbitrum", positions: [makePosition({ chain: "arbitrum", tokenId: 1n, currentTick: 0 })] },
      { chain: "base", positions: [makePosition({ chain: "base", tokenId: 1n, currentTick: 0 })] },
    ] as any);
    await checkPositionsJob(); // 1º ciclo: cria estado in_range nas duas chains

    mockedFetch.mockResolvedValue([
      { chain: "arbitrum", positions: [makePosition({ chain: "arbitrum", tokenId: 1n, currentTick: 1500 })] }, // saiu de range
      { chain: "base", positions: [makePosition({ chain: "base", tokenId: 1n, currentTick: 0 })] }, // continua in-range
    ] as any);
    await checkPositionsJob(); // 2º ciclo: só a posição da Arbitrum deveria notificar

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
  });

  it("junta as posições de 2 wallets do mesmo usuário antes de reconciliar (não apaga a posição de uma ao processar a outra)", async () => {
    const user = await findOrCreateUserByTelegramChatId("chat-2wallets");
    await addWallet(user.id, "0xaaa", "principal");
    await addWallet(user.id, "0xbbb", "lp");

    mockedFetch.mockResolvedValue([
      {
        chain: "arbitrum",
        positions: [
          makePosition({ walletAddress: "0xaaa", tokenId: 1n, currentTick: 0 }),
          makePosition({ walletAddress: "0xbbb", tokenId: 2n, currentTick: 0 }),
        ],
      },
    ] as any);

    await checkPositionsJob(); // 1º ciclo: cria as duas posições
    await checkPositionsJob(); // 2º ciclo: mesmo conjunto — nenhuma deveria ter sido apagada/recriada

    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(mockedFetch).toHaveBeenCalledWith(expect.arrayContaining(["0xaaa", "0xbbb"]), expect.anything());
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { isAddress } from "viem";
import { chains } from "../../src/config/chains.js";
import { fetchPositionsForWallet, fetchUncollectedFees, type UncollectedFees } from "../../src/data/onchain/client.js";
import type { OnchainPosition } from "../../src/domain/lp-rebalance/types.js";

// Estes testes chamam o RPC real da Arbitrum (o projeto já exige
// ARBITRUM_RPC_URL configurado no .env pra qualquer coisa rodar — não é uma
// dependência nova). Mockar o encadeamento de multicall/simulateContract do
// viem seria frágil (preso à ordem exata das chamadas internas); validar
// contra uma wallet real e conhecida é mais robusto e já pegou bugs reais
// (campo liquidity ausente, preços astronômicos em posições full-range).
//
// fetchPositionsForWallet faz ~5 round-trips de RPC por chamada — os
// fixtures abaixo buscam UMA vez só (beforeAll) e reaproveitam entre os
// `it()`s, pra não multiplicar carga desnecessária no free tier do RPC.
const WALLET_WITH_POSITIONS = "0x4bE3ea1967d4117C93A39048316c058025e237C4";
const WALLET_WITHOUT_POSITIONS = "0x000000000000000000000000000000000000dEaD";
const KNOWN_FEE_TIERS = [100, 500, 3000, 10000];

describe("data/onchain/client (RPC real)", () => {
  let positions: OnchainPosition[];
  let sample: OnchainPosition[];
  let fees: Map<string, UncollectedFees>;

  beforeAll(async () => {
    positions = await fetchPositionsForWallet("arbitrum", WALLET_WITH_POSITIONS);
    sample = positions.slice(0, 3); // limita chamadas de collect() simulado
    fees = await fetchUncollectedFees("arbitrum", WALLET_WITH_POSITIONS, sample);
  }, 30000);

  it("retorna posições reais e ativas (liquidity > 0) pra uma wallet conhecida", () => {
    expect(positions.length).toBeGreaterThan(0);

    for (const p of positions) {
      expect(isAddress(p.poolAddress)).toBe(true);
      expect(isAddress(p.token0.address)).toBe(true);
      expect(isAddress(p.token1.address)).toBe(true);
      expect(p.token0.symbol.length).toBeGreaterThan(0);
      expect(p.token1.symbol.length).toBeGreaterThan(0);
      expect(p.token0.decimals).toBeGreaterThanOrEqual(0);
      expect(p.token1.decimals).toBeGreaterThanOrEqual(0);
      expect(p.tickLower).toBeLessThan(p.tickUpper);
      expect(KNOWN_FEE_TIERS).toContain(p.fee);
      expect(p.liquidity).toBeGreaterThan(0n);
      expect(p.sqrtPriceX96).toBeGreaterThan(0n);
    }
  });

  it("retorna array vazio pra uma wallet sem nenhuma posição", async () => {
    const empty = await fetchPositionsForWallet("arbitrum", WALLET_WITHOUT_POSITIONS);
    expect(empty).toEqual([]);
  }, 30000);

  it("fetchUncollectedFees retorna fees não-negativas, sem gastar gas", () => {
    expect(fees.size).toBe(sample.length); // nenhuma simulação deveria falhar numa wallet válida
    for (const p of sample) {
      const f = fees.get(p.tokenId.toString());
      expect(f).toBeDefined();
      expect(f!.amount0).toBeGreaterThanOrEqual(0n);
      expect(f!.amount1).toBeGreaterThanOrEqual(0n);
    }
  });

  it("fetchUncollectedFees com lista vazia retorna Map vazio sem chamar RPC", async () => {
    const emptyFees = await fetchUncollectedFees("arbitrum", WALLET_WITH_POSITIONS, []);
    expect(emptyFees.size).toBe(0);
  });
});

// Smoke test condicional: só roda se BASE_RPC_URL estiver configurada no
// ambiente (chain opcional, ver src/config/chains.ts). Não valida posição
// real (nenhuma wallet de teste conhecida com posição real na Base ainda) —
// só confirma que o registry resolve os endereços/RPC corretos sem lançar.
describe.skipIf(!chains.base.rpcUrl)("data/onchain/client — Base (RPC real, smoke test)", () => {
  it("resolve o client e não lança pra uma wallet sem posições", async () => {
    const empty = await fetchPositionsForWallet("base", WALLET_WITHOUT_POSITIONS);
    expect(empty).toEqual([]);
  }, 30000);
});

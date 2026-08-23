import { describe, expect, it } from "vitest";
import { findCloseGasCost, findMintGasCost } from "../../src/data/onchain/position-gas.js";

// Chama a RPC real da Arbitrum — mesma convenção de client.test.ts (não
// mocka o encadeamento de chamadas do viem). Desde o upgrade da Alchemy pra
// Pay As You Go (23/08/2026, range de eth_getLogs virou ilimitado), essas
// buscas são rápidas (~1-2s) — antes do upgrade, no free tier (10 blocos
// por chamada), o caso "não achou nada" podia levar mais de 1 minuto.
//
// #5658859 é uma posição real WBTC/USDC (Arbitrum) mintada em 20/08/2026 —
// bem mais antiga que a janela de busca (24h), então o resultado esperado
// e correto pra findMintGasCost é null, não um erro.
const OLD_TOKEN_ID = 5658859n;

describe("data/onchain/position-gas (RPC real)", () => {
  it("findMintGasCost numa posição fora da janela de busca retorna null (não lança)", async () => {
    const result = await findMintGasCost("arbitrum", OLD_TOKEN_ID);
    expect(result).toBeNull();
  }, 30000);

  it("findCloseGasCost numa posição sem evento de close recente retorna null (não lança)", async () => {
    // tokenId praticamente garantido de nunca ter existido — igualmente
    // válido pra exercitar o caminho "nenhum log encontrado" sem depender
    // de timing de uma posição real específica.
    const result = await findCloseGasCost("arbitrum", 999_999_999_999n);
    expect(result).toBeNull();
  }, 30000);
});

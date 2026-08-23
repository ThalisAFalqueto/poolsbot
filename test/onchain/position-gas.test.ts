import { describe, expect, it } from "vitest";
import { findCloseGasCost, findMintGasCost } from "../../src/data/onchain/position-gas.js";

// Chama a RPC real da Arbitrum — mesma convenção de client.test.ts (não
// mocka o encadeamento de chamadas do viem). Achado real ao construir isso
// (23/08/2026): o RPC free tier configurado (Alchemy) só aceita até 10
// blocos por chamada de eth_getLogs — a busca escaneia em chunks de 10, e
// o caso "não achou nada" percorre a janela inteira antes de desistir, o
// que leva bem mais de 1 minuto na prática. Os timeouts longos abaixo
// refletem isso, não são um exagero.
//
// #5658859 é uma posição real WBTC/USDC (Arbitrum) mintada em 20/08/2026 —
// bem mais antiga que a janela de busca (15min), então o resultado
// esperado e correto pra findMintGasCost é null, não um erro.
const OLD_TOKEN_ID = 5658859n;

describe("data/onchain/position-gas (RPC real)", () => {
  it(
    "findMintGasCost numa posição fora da janela de busca retorna null (não lança)",
    async () => {
      const result = await findMintGasCost("arbitrum", OLD_TOKEN_ID);
      expect(result).toBeNull();
    },
    240_000
  );

  it(
    "findCloseGasCost numa posição sem evento de close recente retorna null (não lança)",
    async () => {
      // tokenId praticamente garantido de nunca ter existido — igualmente
      // válido pra exercitar o caminho "nenhum log encontrado" sem
      // depender de timing de uma posição real específica.
      const result = await findCloseGasCost("arbitrum", 999_999_999_999n);
      expect(result).toBeNull();
    },
    240_000
  );
});

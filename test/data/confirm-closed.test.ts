import { describe, expect, it } from "vitest";
import { confirmPositionClosed, type LiquidityReader } from "../../src/data/onchain/confirm-closed.js";

// Sem mock de módulo: a leitura de liquidez é injetada. O que se testa aqui é
// a DECISÃO — arquiva, não arquiva, ou na dúvida não mexe.

const devolve = (liquidez: bigint): LiquidityReader => async () => liquidez;
const falha = (msg: string): LiquidityReader => async () => {
  throw new Error(msg);
};

describe("confirmPositionClosed", () => {
  it("liquidez zero confirma o fechamento", async () => {
    expect(await confirmPositionClosed("arbitrum", "v3", "123", devolve(0n))).toEqual({ closed: true });
  });

  // O caso que motivou tudo: em 03/09/2026 a posição sumiu da lista por falha
  // de RPC mas continuava com liquidez. Arquivar ali custou o gas de mint, a
  // data de abertura e o baseline de IL, e criou uma posição "fechada" falsa.
  it("liquidez maior que zero REJEITA o arquivamento", async () => {
    const r = await confirmPositionClosed("arbitrum", "v3", "5674258", devolve(57_148_856n));
    expect(r.closed).toBe(false);
  });

  // NFT queimado: o contrato reverte porque o tokenId não existe mais. É o
  // fechamento mais definitivo possível.
  it("NFT queimado conta como fechado", async () => {
    expect(await confirmPositionClosed("arbitrum", "v3", "999", falha("ERC721: owner query for nonexistent token"))).toEqual({
      closed: true,
    });
  });

  // NA DÚVIDA NÃO ARQUIVA. Manter um registro a mais custa uma linha; apagar
  // custa dado que não volta. Se este teste quebrar, o bug de 03/09 pode
  // acontecer de novo por outro caminho.
  it("erro de leitura devolve indefinido, nunca 'fechado'", async () => {
    for (const msg of ["fetch failed: ECONNRESET", "request timed out", "429 Too Many Requests", "chain sem RPC"]) {
      const r = await confirmPositionClosed("arbitrum", "v3", "123", falha(msg));
      expect(r.closed, msg).toBeNull();
    }
  });

  it("vale igual pra V4", async () => {
    expect(await confirmPositionClosed("arbitrum", "v4", "198755", devolve(0n))).toEqual({ closed: true });
    expect((await confirmPositionClosed("arbitrum", "v4", "198755", devolve(56_666_324n))).closed).toBe(false);
  });
});

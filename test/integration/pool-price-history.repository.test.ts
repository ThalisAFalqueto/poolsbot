import { beforeEach, describe, expect, it } from "vitest";
import {
  getPriceHistorySince,
  insertPriceHistory,
  insertPriceHistoryIfDue,
  MIN_PRICE_GAP_MS,
} from "../../src/persistence/repositories/pool-price-history.repository.js";
import { truncateAll } from "./db-helper.js";

const POOL_A = "0x0E4831319A50228B9e450861297aB92dee15B44F";
const POOL_B = "0xC6962004f452bE9203591991D15f6b388e09E8D0";

function ponto(poolAddress: string, price: number, recordedAt = new Date()) {
  return { chain: "arbitrum", poolAddress, price, recordedAt, source: "onchain_ingest" };
}

const desde = () => new Date(Date.now() - 86_400_000);

describe("insertPriceHistoryIfDue", () => {
  beforeEach(truncateAll);

  it("grava quando o pool ainda não tem nenhum ponto", async () => {
    expect(await insertPriceHistoryIfDue([ponto(POOL_A, 79_131)])).toBe(1);
    expect(await getPriceHistorySince("arbitrum", POOL_A, desde())).toHaveLength(1);
  });

  // O caso que motivou o guarda: check-positions e ingest-pools gravando o
  // mesmo pool no mesmo ciclo. Dois pontos a segundos de distância viram
  // retorno dividido por um √Δt minúsculo e explodem o σ.
  it("recusa um segundo ponto logo depois do primeiro", async () => {
    await insertPriceHistoryIfDue([ponto(POOL_A, 79_131)]);
    expect(await insertPriceHistoryIfDue([ponto(POOL_A, 79_140)])).toBe(0);
    expect(await getPriceHistorySince("arbitrum", POOL_A, desde())).toHaveLength(1);
  });

  it("volta a gravar depois que o intervalo passou", async () => {
    await insertPriceHistory([ponto(POOL_A, 79_131, new Date(Date.now() - MIN_PRICE_GAP_MS - 60_000))]);
    expect(await insertPriceHistoryIfDue([ponto(POOL_A, 76_964)])).toBe(1);
    expect(await getPriceHistorySince("arbitrum", POOL_A, desde())).toHaveLength(2);
  });

  // Um pool bloqueado não pode bloquear os outros da mesma leva — senão
  // observar duas pools faria uma delas nunca ser gravada.
  it("bloqueia só o pool recente, não a leva inteira", async () => {
    await insertPriceHistoryIfDue([ponto(POOL_A, 79_131)]);
    expect(await insertPriceHistoryIfDue([ponto(POOL_A, 79_140), ponto(POOL_B, 2487)])).toBe(1);
    expect(await getPriceHistorySince("arbitrum", POOL_B, desde())).toHaveLength(1);
  });

  it("lista vazia não vai ao banco", async () => {
    expect(await insertPriceHistoryIfDue([])).toBe(0);
  });
});

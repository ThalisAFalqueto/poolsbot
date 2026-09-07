import { beforeEach, describe, expect, it } from "vitest";
import {
  findLatestMarketVolumeDate,
  insertMarketVolume,
  listMarketVolumeSince,
} from "../../src/persistence/repositories/market.repository.js";
import { findOrCreateUserByTelegramChatId } from "../../src/persistence/repositories/users.repository.js";
import { truncateAll } from "./db-helper.js";

describe("market.repository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("volume de mercado", () => {
    it("grava e lê a série a partir de uma data", async () => {
      await insertMarketVolume([
        { date: "2026-08-01", volumeUsd: 5e9, source: "defillama_backfill" },
        { date: "2026-08-02", volumeUsd: 6e9, source: "defillama_backfill" },
      ]);
      const rows = await listMarketVolumeSince("2026-08-02");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.volumeUsd).toBe(6e9);
    });

    it("devolve em ordem crescente de data (o cálculo de regime depende disso)", async () => {
      await insertMarketVolume([
        { date: "2026-08-03", volumeUsd: 3e9, source: "s" },
        { date: "2026-08-01", volumeUsd: 1e9, source: "s" },
        { date: "2026-08-02", volumeUsd: 2e9, source: "s" },
      ]);
      const rows = await listMarketVolumeSince("2026-01-01");
      expect(rows.map((r) => r.date)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    });

    // Backfill e job diário se sobrepõem de propósito — a segunda gravação da
    // mesma data tem que ser no-op, não erro nem valor trocado.
    it("regravar a mesma data não duplica nem sobrescreve", async () => {
      await insertMarketVolume([{ date: "2026-08-01", volumeUsd: 5e9, source: "defillama_backfill" }]);
      await insertMarketVolume([{ date: "2026-08-01", volumeUsd: 999e9, source: "defillama_daily" }]);

      const rows = await listMarketVolumeSince("2026-01-01");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.volumeUsd).toBe(5e9);
    });

    it("findLatestMarketVolumeDate devolve a mais recente, ou null sem dado", async () => {
      expect(await findLatestMarketVolumeDate()).toBeNull();
      await insertMarketVolume([
        { date: "2026-08-01", volumeUsd: 1e9, source: "s" },
        { date: "2026-08-05", volumeUsd: 2e9, source: "s" },
      ]);
      expect(await findLatestMarketVolumeDate()).toBe("2026-08-05");
    });
  });
});

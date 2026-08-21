import { db } from "../db.js";
import { poolVolumeHistory } from "../schema/index.js";

export type VolumeSnapshotRow = { poolId: string; date: string; volumeUsd: number };

// onConflictDoNothing (não onConflictDoUpdate) de propósito: se já existe
// uma linha pra esse (poolId, date) — seja de um backfill via Dune (mais
// preciso, soma exata dos swaps) ou de um ciclo de ingestão anterior no
// mesmo dia — não sobrescreve. O job de 15min roda ~96x/dia; só a
// primeira chamada do dia grava algo, o resto vira no-op barato.
export async function insertVolumeIfMissing(rows: VolumeSnapshotRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(poolVolumeHistory)
    .values(rows.map((r) => ({ ...r, source: "defillama_ingest" })))
    .onConflictDoNothing({ target: [poolVolumeHistory.poolId, poolVolumeHistory.date] });
}

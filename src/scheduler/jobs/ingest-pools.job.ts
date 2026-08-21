import { fetchAllPools } from "../../data/defillama/client.js";
import { listDistinctWatchedPools } from "../../persistence/repositories/watched-pools.repository.js";
import { insertSnapshots, type ApyHistoryRow } from "../../persistence/repositories/apy-history.repository.js";
import { insertVolumeIfMissing, type VolumeSnapshotRow } from "../../persistence/repositories/pool-volume-history.repository.js";

export async function ingestPoolsJob(): Promise<string> {
  const watched = await listDistinctWatchedPools();
  if (watched.length === 0) return "nenhum pool observado.";

  let pools;
  try {
    pools = await fetchAllPools();
  } catch (err) {
    console.error("[ingest-pools] falha ao buscar dados da DefiLlama, pulando ciclo:", err);
    return "falha ao buscar dados da DefiLlama, ciclo pulado.";
  }

  const byId = new Map(pools.map((p) => [p.pool, p]));
  const rows: ApyHistoryRow[] = [];
  const volumeRows: VolumeSnapshotRow[] = [];
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, granularidade diária de poolVolumeHistory

  for (const { poolId, chain } of watched) {
    const pool = byId.get(poolId);
    if (!pool) {
      console.warn(`[ingest-pools] pool ${poolId} não encontrado na resposta da DefiLlama, pulando.`);
      continue;
    }
    rows.push({
      poolId: pool.pool,
      chain,
      apyBase: pool.apyBase,
      apyReward: pool.apyReward,
      apy: pool.apy,
      tvlUsd: pool.tvlUsd,
      ilRisk: pool.ilRisk,
      il7d: pool.il7d,
      volumeUsd: pool.volumeUsd1d,
    });
    // volumeUsd1d já vem de graça na mesma resposta — sem chamada de API
    // extra. Ausente/null em pools que não são DEX (ex: staking), omitido
    // nesse caso — checagem por typeof, não só "!== null", porque é uma
    // fronteira externa (resposta de API real pode divergir do tipo TS).
    if (typeof pool.volumeUsd1d === "number") {
      volumeRows.push({ poolId: pool.pool, date: today, volumeUsd: pool.volumeUsd1d });
    }
  }

  await insertSnapshots(rows);
  await insertVolumeIfMissing(volumeRows);
  const summary = `${rows.length}/${watched.length} pools atualizados.`;
  console.log(`[ingest-pools] ${summary}`);
  return summary;
}

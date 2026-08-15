import { fetchAllPools } from "../../data/defillama/client.js";
import { listDistinctWatchedPools } from "../../persistence/repositories/watched-pools.repository.js";
import { insertSnapshots, type ApyHistoryRow } from "../../persistence/repositories/apy-history.repository.js";

export async function ingestPoolsJob(): Promise<void> {
  const watched = await listDistinctWatchedPools();
  if (watched.length === 0) return;

  let pools;
  try {
    pools = await fetchAllPools();
  } catch (err) {
    console.error("[ingest-pools] falha ao buscar dados da DefiLlama, pulando ciclo:", err);
    return;
  }

  const byId = new Map(pools.map((p) => [p.pool, p]));
  const rows: ApyHistoryRow[] = [];

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
    });
  }

  await insertSnapshots(rows);
  console.log(`[ingest-pools] ${rows.length}/${watched.length} pools atualizados.`);
}

import { fetchAllPools } from "../../data/defillama/client.js";
import { listDistinctWatchedPools } from "../../persistence/repositories/watched-pools.repository.js";
import { insertSnapshots, type ApyHistoryRow } from "../../persistence/repositories/apy-history.repository.js";

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
  }

  await insertSnapshots(rows);
  const summary = `${rows.length}/${watched.length} pools atualizados.`;
  console.log(`[ingest-pools] ${summary}`);
  return summary;
}

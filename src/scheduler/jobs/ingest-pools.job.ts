import { fetchAllPools } from "../../data/defillama/client.js";
import { readPoolPrices } from "../../data/onchain/pool-price.js";
import { listDistinctWatchedPools } from "../../persistence/repositories/watched-pools.repository.js";
import { insertSnapshots, type ApyHistoryRow } from "../../persistence/repositories/apy-history.repository.js";
import { insertPriceHistoryIfDue } from "../../persistence/repositories/pool-price-history.repository.js";

// Grava a evolução das pools que o usuário acompanha. Duas séries, de fontes
// diferentes de propósito:
//
//   apy_history        — APY, TVL e volume, como a DefiLlama reporta;
//   pool_price_history — PREÇO, lido do contrato.
//
// O preço entrou aqui em 10/09/2026. Antes ele só era gravado pra pool com
// posição aberta, então o histórico de uma pool que o usuário estava avaliando
// pra ENTRAR simplesmente não existia — que é justamente quando ele decide a
// faixa. Ver data/onchain/pool-price.ts.

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
  const encontrados: typeof pools = [];

  for (const { poolId, chain } of watched) {
    const pool = byId.get(poolId);
    if (!pool) {
      console.warn(`[ingest-pools] pool ${poolId} não encontrado na resposta da DefiLlama, pulando.`);
      continue;
    }
    encontrados.push(pool);
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

  // Preço é uma leitura on-chain, independente da DefiLlama: falha aqui não
  // pode perder o snapshot de APY que já foi gravado acima.
  let precos = 0;
  try {
    const lidos = await readPoolPrices(
      encontrados.map((p) => ({
        poolId: p.pool,
        chain: p.chain,
        project: p.project,
        poolMeta: p.poolMeta,
        underlyingTokens: p.underlyingTokens ?? null,
      }))
    );
    precos = await insertPriceHistoryIfDue(lidos);
  } catch (err) {
    console.error("[ingest-pools] falha ao gravar histórico de preço:", err);
  }

  const summary = `${rows.length}/${watched.length} pools atualizados, ${precos} preço(s) gravado(s).`;
  console.log(`[ingest-pools] ${summary}`);
  return summary;
}

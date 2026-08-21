// Script pontual — roda manualmente via `tsx src/scripts/backfill-price-history.ts`,
// NUNCA é chamado pelo bot em produção. Mesmo padrão do backfill-volume-history.ts
// (mesma tabela do Dune, `Pair_evt_Swap`, já confirmada real), mas aqui extraindo
// as colunas de PREÇO (sqrtPriceX96) em vez das de volume (amount0/amount1) —
// alimenta o histórico usado pelo gráfico de linha do /graph.
//
// Exige DUNE_API_KEY no .env (conta gratuita típica é um teste de 14 dias
// com créditos limitados — rodar com moderação, não em loop).
import type { Address } from "viem";
import { chainKeyFromDefillamaName, type ChainKey } from "../config/chains.js";
import { env } from "../config/env.js";
import { getPoolById, parseFeeTierLabel } from "../data/defillama/client.js";
import { sqrtPriceX96ToPrice } from "../domain/lp-rebalance/price-math.js";
import { getPoolInfo } from "../data/onchain/client.js";
import { insertPriceHistory } from "../persistence/repositories/pool-price-history.repository.js";

// Granularidade horária: 30 dias já dá ~720 pontos, suficiente pro gráfico de
// linha do /graph sem pesar demais na conta de créditos do Dune.
const BACKFILL_DAYS = 30;
const DUNE_API_BASE = "https://api.dune.com/api/v1";

// Mesma tabela confirmada em backfill-volume-history.ts — não duplicar a
// validação, só reaproveitar a mesma lista (só "arbitrum" testado até agora).
const SWAP_TABLE_BY_CHAIN: Partial<Record<ChainKey, string>> = {
  arbitrum: "uniswap_v3_arbitrum.Pair_evt_Swap",
};

type DuneRow = { hour_bucket: string; sqrt_price_x96: string };

async function executeDuneSql(sql: string): Promise<DuneRow[]> {
  if (!env.duneApiKey) throw new Error("DUNE_API_KEY não configurada no .env");

  const execRes = await fetch(`${DUNE_API_BASE}/sql/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dune-Api-Key": env.duneApiKey },
    body: JSON.stringify({ sql, performance: "medium" }),
  });
  const execJson = (await execRes.json()) as { execution_id?: string; error?: string };
  if (!execJson.execution_id) {
    throw new Error(`Dune execute falhou: ${JSON.stringify(execJson)}`);
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const resultRes = await fetch(`${DUNE_API_BASE}/execution/${execJson.execution_id}/results`, {
      headers: { "X-Dune-Api-Key": env.duneApiKey },
    });
    const resultJson = (await resultRes.json()) as {
      is_execution_finished: boolean;
      state: string;
      error?: unknown;
      result?: { rows: DuneRow[] };
    };
    if (resultJson.is_execution_finished) {
      if (resultJson.state !== "QUERY_STATE_COMPLETED") {
        throw new Error(`Dune query falhou: ${JSON.stringify(resultJson.error)}`);
      }
      return resultJson.result?.rows ?? [];
    }
  }
  throw new Error("Dune query não terminou a tempo (timeout de polling, 60s)");
}

async function backfillPool(poolId: string): Promise<void> {
  const pool = await getPoolById(poolId);
  if (!pool) {
    console.error(`[backfill-price] pool ${poolId} não encontrado na DefiLlama, pulando.`);
    return;
  }
  if (pool.project !== "uniswap-v3") {
    console.error(`[backfill-price] ${pool.symbol} (${poolId}) não é Uniswap V3 (é "${pool.project}"), pulando.`);
    return;
  }

  const chainKey = chainKeyFromDefillamaName(pool.chain);
  const table = chainKey ? SWAP_TABLE_BY_CHAIN[chainKey] : undefined;
  if (!table || !chainKey) {
    console.error(`[backfill-price] sem tabela Dune confirmada pra chain "${pool.chain}", pulando ${pool.symbol}.`);
    return;
  }

  const fee = parseFeeTierLabel(pool.poolMeta);
  if (fee === null || !pool.underlyingTokens || pool.underlyingTokens.length < 2) {
    console.error(`[backfill-price] sem fee tier/tokens pra ${pool.symbol}, pulando.`);
    return;
  }

  const [tokenA, tokenB] = pool.underlyingTokens as [Address, Address];
  const info = await getPoolInfo(chainKey, tokenA, tokenB, fee);
  if (!info) {
    console.error(`[backfill-price] pool on-chain não resolvido pra ${pool.symbol}, pulando.`);
    return;
  }

  console.log(`[backfill-price] ${pool.symbol} (${pool.chain}) — pool on-chain ${info.poolAddress}...`);

  const sql = `
    SELECT date_trunc('hour', evt_block_time) as hour_bucket,
           CAST(max_by(sqrtPriceX96, evt_block_time) AS VARCHAR) as sqrt_price_x96
    FROM ${table}
    WHERE contract_address = ${info.poolAddress}
      AND evt_block_date >= DATE '${new Date(Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)}'
    GROUP BY 1
    ORDER BY 1 DESC
  `;

  const rows = await executeDuneSql(sql);
  console.log(`[backfill-price] ${pool.symbol}: ${rows.length} horas de histórico encontradas.`);

  const priceRows = rows.map((row) => ({
    chain: chainKey,
    poolAddress: info.poolAddress,
    // Dune devolve algo como "2026-08-21 13:00:00.000 UTC" — remover o
    // sufixo textual antes de virar ISO (senão dá RangeError: Invalid time value).
    recordedAt: new Date(`${row.hour_bucket.replace(" UTC", "").replace(" ", "T")}Z`),
    price: sqrtPriceX96ToPrice(BigInt(row.sqrt_price_x96), info.token0.decimals, info.token1.decimals),
    source: "dune_backfill",
  }));

  await insertPriceHistory(priceRows);
  console.log(`[backfill-price] ${pool.symbol}: gravado no banco.`);
}

async function main() {
  // Mesma posição real do usuário usada em backfill-volume-history.ts
  // (WBTC/USDC 0.05% Arbitrum). Ajustar à mão pra rodar de novo com outro pool.
  const poolIds = ["7127db96-afba-4089-8c9d-daa93c116856"];

  for (const poolId of poolIds) {
    await backfillPool(poolId);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-price] erro fatal:", err);
    process.exit(1);
  });

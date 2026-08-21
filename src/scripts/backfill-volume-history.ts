// Script pontual — roda manualmente via `tsx src/scripts/backfill-volume-history.ts`,
// NUNCA é chamado pelo bot em produção. Usa o Dune Analytics (SQL sobre
// eventos decodificados on-chain) pra preencher de uma vez o histórico
// diário de volume que precisamos pra detectar pico de volume (tipo wash
// trading) — sem isso, teríamos que esperar semanas acumulando dado do
// zero via o job de ingestão normal (ver poolVolumeHistory em schema/index.ts).
//
// Exige DUNE_API_KEY no .env (conta gratuita típica é um teste de 14 dias
// com créditos limitados — rodar com moderação, não em loop).
import { and, eq } from "drizzle-orm";
import type { Address } from "viem";
import { chainKeyFromDefillamaName, type ChainKey } from "../config/chains.js";
import { env } from "../config/env.js";
import { getPoolById, parseFeeTierLabel } from "../data/defillama/client.js";
import { getPoolInfo } from "../data/onchain/client.js";
import { db } from "../persistence/db.js";
import { poolVolumeHistory } from "../persistence/schema/index.js";

const BACKFILL_DAYS = 90;
const DUNE_API_BASE = "https://api.dune.com/api/v1";

// Tabela decodificada de swaps do Uniswap V3 no Dune, uma por chain — só
// "arbitrum" está CONFIRMADA contra dado real (testado manualmente em
// 20/08/2026, bateu com os números que o próprio bot já lia on-chain).
// As outras chains não têm entrada aqui de propósito: não assumir o nome
// sem testar primeiro (mesma disciplina de nunca confiar em endereço/nome
// não verificado).
const SWAP_TABLE_BY_CHAIN: Partial<Record<ChainKey, string>> = {
  arbitrum: "uniswap_v3_arbitrum.Pair_evt_Swap",
};

const STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USD₮0", "BUSD", "USDC.e"]);

type DuneRow = { evt_block_date: string; volume: number };

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
    console.error(`[backfill] pool ${poolId} não encontrado na DefiLlama, pulando.`);
    return;
  }
  if (pool.project !== "uniswap-v3") {
    console.error(`[backfill] ${pool.symbol} (${poolId}) não é Uniswap V3 (é "${pool.project}"), pulando.`);
    return;
  }

  const chainKey = chainKeyFromDefillamaName(pool.chain);
  const table = chainKey ? SWAP_TABLE_BY_CHAIN[chainKey] : undefined;
  if (!table) {
    console.error(`[backfill] sem tabela Dune confirmada pra chain "${pool.chain}", pulando ${pool.symbol}.`);
    return;
  }

  const fee = parseFeeTierLabel(pool.poolMeta);
  if (fee === null || !pool.underlyingTokens || pool.underlyingTokens.length < 2) {
    console.error(`[backfill] sem fee tier/tokens pra ${pool.symbol}, pulando.`);
    return;
  }

  const [tokenA, tokenB] = pool.underlyingTokens as [Address, Address];
  const info = await getPoolInfo(chainKey!, tokenA, tokenB, fee);
  if (!info) {
    console.error(`[backfill] pool on-chain não resolvido pra ${pool.symbol}, pulando.`);
    return;
  }

  // Decide qual lado (amount0/amount1) representa valor em USD — só
  // suporta pares com uma stablecoin reconhecida de um dos lados por
  // enquanto (é o nosso caso real, WBTC/USDC). Generalizar pra pares sem
  // stablecoin fica pra quando for realmente necessário.
  let amountColumn: "amount0" | "amount1";
  let decimals: number;
  if (STABLECOIN_SYMBOLS.has(info.token1.symbol)) {
    amountColumn = "amount1";
    decimals = info.token1.decimals;
  } else if (STABLECOIN_SYMBOLS.has(info.token0.symbol)) {
    amountColumn = "amount0";
    decimals = info.token0.decimals;
  } else {
    console.error(`[backfill] ${pool.symbol}: nenhum dos dois tokens é uma stablecoin reconhecida, pulando (não sei estimar USD).`);
    return;
  }

  console.log(`[backfill] ${pool.symbol} (${pool.chain}) — pool on-chain ${info.poolAddress}, usando ${amountColumn}...`);

  const sql = `
    SELECT evt_block_date, SUM(ABS(CAST(${amountColumn} AS DOUBLE))) / 1e${decimals} as volume
    FROM ${table}
    WHERE contract_address = ${info.poolAddress}
      AND evt_block_date >= DATE '${new Date(Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)}'
    GROUP BY evt_block_date
    ORDER BY evt_block_date DESC
  `;

  const rows = await executeDuneSql(sql);
  console.log(`[backfill] ${pool.symbol}: ${rows.length} dias de histórico encontrados.`);

  for (const row of rows) {
    await db
      .insert(poolVolumeHistory)
      .values({ poolId, date: row.evt_block_date, volumeUsd: row.volume, source: "dune_backfill" })
      .onConflictDoUpdate({
        target: [poolVolumeHistory.poolId, poolVolumeHistory.date],
        set: { volumeUsd: row.volume, source: "dune_backfill" },
      });
  }
  console.log(`[backfill] ${pool.symbol}: gravado no banco.`);
}

async function main() {
  // Pools a preencher — hoje é só a posição real do usuário (WBTC/USDC
  // 0.05% Arbitrum). Ajustar essa lista à mão quando quiser rodar de novo
  // pra outro pool específico; de propósito NÃO varre watchedPools direto
  // (o único pool observado hoje é um leftover de teste antigo, Balancer,
  // sem relação com o uso real).
  const poolIds = ["7127db96-afba-4089-8c9d-daa93c116856"];

  for (const poolId of poolIds) {
    await backfillPool(poolId);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] erro fatal:", err);
    process.exit(1);
  });

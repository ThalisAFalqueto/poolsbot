// Backfill de histórico de preço lendo a PRÓPRIA BLOCKCHAIN, sem Dune.
//
// Uso: tsx src/scripts/backfill-price-onchain.ts <poolId> [<poolId> ...] [--dias 30] [--passo 1h]
//
// POR QUE ESTE EXISTE, tendo backfill-price-history.ts.
//
// O outro depende do Dune, e o Dune quebrou na prática: a conta bateu o limite
// de datapoints do ciclo de cobrança ("would exceed your configured datapoint
// limit"). A memória do projeto já avisava pra não deixar nada depender dele
// sem checar validade — e é exatamente isso que aconteceu.
//
// Ler direto da chain é estritamente melhor: não tem crédito pra acabar, não
// tem conta pra expirar, funciona em qualquer chain que o bot tenha RPC, e usa
// a mesma técnica já testada em data/onchain/measure-pool-yield.ts (amostrar
// slot0 em blocos históricos).
//
// O QUE ELE NÃO FAZ: reconstruir o preço trade a trade. Ele AMOSTRA — pega o
// preço vigente a cada N minutos. Pra estimar volatilidade e rodar backtest de
// largura, que é o uso, amostra é suficiente e é o que a ingestão normal do
// bot já faz (a cada 15min). Pra contar swaps individuais, não serve.

import { parseAbi, type Address } from "viem";
import { chainKeyFromDefillamaName } from "../config/chains.js";
import { getPoolById, parseFeeTierLabel } from "../data/defillama/client.js";
import { getPoolInfo, getPublicClient } from "../data/onchain/client.js";
import { getV4PoolInfo } from "../data/onchain/client-v4.js";
import { findBlockNearTimestamp } from "../data/onchain/fee-growth.js";
import { sqrtPriceX96ToPrice } from "../domain/lp-rebalance/price-math.js";
import { insertPriceHistory, type PriceHistoryRow } from "../persistence/repositories/pool-price-history.repository.js";

const v3Abi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
]);
const v4Abi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

/** Quantas leituras disparar de uma vez. RPC pago aguenta bem mais, mas rajada
 *  grande demais vira erro de rate limit no meio e perde o lote inteiro. */
const LOTE = 25;

function parseArgs() {
  const args = process.argv.slice(2);
  const poolIds: string[] = [];
  let dias = 30;
  let passoMin = 60;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dias") {
      dias = Number(args[++i]);
    } else if (a === "--passo") {
      const v = args[++i]!;
      passoMin = v.endsWith("h") ? Number(v.slice(0, -1)) * 60 : Number(v.replace("m", ""));
    } else {
      poolIds.push(a);
    }
  }
  return { poolIds, dias, passoMin };
}

async function main() {
  const { poolIds, dias, passoMin } = parseArgs();
  if (poolIds.length === 0) {
    console.error("Uso: tsx src/scripts/backfill-price-onchain.ts <poolId> [...] [--dias 30] [--passo 1h]");
    process.exit(1);
  }

  for (const poolId of poolIds) {
    const pool = await getPoolById(poolId);
    if (!pool) {
      console.error(`  ${poolId}: não achei na DefiLlama, pulando`);
      continue;
    }
    const chainKey = chainKeyFromDefillamaName(pool.chain);
    const fee = parseFeeTierLabel(pool.poolMeta);
    if (!chainKey || fee === null || !pool.underlyingTokens || pool.underlyingTokens.length < 2) {
      console.error(`  ${pool.symbol}: chain/fee/tokens não resolvidos, pulando`);
      continue;
    }
    const isV4 = pool.project === "uniswap-v4";
    const [tokenA, tokenB] = pool.underlyingTokens as [Address, Address];
    const info = isV4
      ? await getV4PoolInfo(chainKey, tokenA, tokenB, fee)
      : await getPoolInfo(chainKey, tokenA, tokenB, fee);
    if (!info) {
      console.error(`  ${pool.symbol}: não achei o pool on-chain, pulando`);
      continue;
    }

    const client = getPublicClient(chainKey);
    const agora = Math.floor(Date.now() / 1000);
    const [blocoIni, blocoFim] = await Promise.all([
      findBlockNearTimestamp(chainKey, agora - dias * 86400),
      findBlockNearTimestamp(chainKey, agora),
    ]);

    const amostras = Math.max(2, Math.floor((dias * 24 * 60) / passoMin));
    const passo = (blocoFim - blocoIni) / BigInt(amostras - 1);
    if (passo <= 0n) {
      console.error(`  ${pool.symbol}: janela curta demais pro passo pedido, pulando`);
      continue;
    }

    console.log(
      `${pool.symbol} ${pool.poolMeta} (${pool.chain} ${pool.project})\n` +
        `  pool ${info.poolAddress}\n` +
        `  ${amostras} amostras a cada ${passoMin}min, blocos ${blocoIni}–${blocoFim}`
    );

    const blocos = Array.from({ length: amostras }, (_, i) => blocoIni + passo * BigInt(i));
    const linhas: PriceHistoryRow[] = [];
    let falhas = 0;

    for (let i = 0; i < blocos.length; i += LOTE) {
      const fatia = blocos.slice(i, i + LOTE);
      const resultados = await Promise.allSettled(
        fatia.map(async (blockNumber) => {
          const [bloco, slot0] = await Promise.all([
            client.getBlock({ blockNumber }),
            isV4
              ? client.readContract({
                  address: (await import("../config/chains.js")).chains[chainKey].uniswapV4!.stateView,
                  abi: v4Abi,
                  functionName: "getSlot0",
                  args: [info.poolAddress as `0x${string}`],
                  blockNumber,
                })
              : client.readContract({ address: info.poolAddress as Address, abi: v3Abi, functionName: "slot0", blockNumber }),
          ]);
          const sqrtPriceX96 = (slot0 as readonly unknown[])[0] as bigint;
          if (sqrtPriceX96 === 0n) return null; // pool ainda não existia nesse bloco
          return {
            chain: chainKey,
            poolAddress: info.poolAddress,
            recordedAt: new Date(Number(bloco.timestamp) * 1000),
            price: sqrtPriceX96ToPrice(sqrtPriceX96, info.token0.decimals, info.token1.decimals),
            source: "onchain_backfill",
          } as PriceHistoryRow;
        })
      );
      for (const r of resultados) {
        if (r.status === "fulfilled" && r.value) linhas.push(r.value);
        else if (r.status === "rejected") falhas++;
      }
      process.stdout.write(`\r  lidos ${linhas.length}/${amostras}${falhas > 0 ? ` (${falhas} falhas)` : ""}`);
    }
    process.stdout.write("\n");

    if (linhas.length === 0) {
      console.error("  nada pra gravar\n");
      continue;
    }
    await insertPriceHistory(linhas);
    const precos = linhas.map((l) => l.price);
    console.log(
      `  gravados ${linhas.length} pontos · preço de ${Math.min(...precos).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} a ${Math.max(...precos).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}\n`
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

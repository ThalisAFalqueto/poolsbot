// Script pontual — refaz os recibos do /closed a partir da chain.
//
// Uso: tsx src/scripts/repair-closed-receipts.ts [--aplicar]
//
// POR QUE ISSO EXISTE. Até 11/09/2026 o recibo de fechamento vinha do
// snapshot do último /positions, não da transação de fechamento — ver
// domain/lp-rebalance/close-receipt.ts. Todo recibo gravado antes disso tem o
// mesmo defeito, em grau que depende de quanto tempo passou entre o último
// /positions e o fechamento.
//
// Usa EXATAMENTE a mesma leitura do arquivamento novo (readV3CloseReceipt), de
// propósito: um reparo com conta própria seria uma segunda versão da verdade.
//
// Só V3. V4 não tem DecreaseLiquidity/Collect; esses recibos ficam como estão,
// marcados como snapshot pra o /closed avisar.
//
// FAÇA UM DUMP DO BANCO ANTES de rodar com --aplicar.

import { eq } from "drizzle-orm";
import type { Address } from "viem";
import { chains, type ChainKey } from "../config/chains.js";
import { nonfungiblePositionManagerAbi } from "../data/onchain/abis.js";
import { getPoolInfo, getPublicClient } from "../data/onchain/client.js";
import { readV3CloseReceipt } from "../data/onchain/close-receipt.js";
import { db } from "../persistence/db.js";
import { closedLpPositions } from "../persistence/schema/index.js";

const aplicar = process.argv.includes("--aplicar");
const n = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2);
const col = (v: number) => v.toFixed(2).padStart(9);

async function main() {
  const linhas = await db.select().from(closedLpPositions).orderBy(closedLpPositions.id);

  for (const row of linhas) {
    console.log(`\n#${row.tokenId} (${row.chain} ${row.protocol}) ${row.token0Symbol}/${row.token1Symbol}`);

    if (row.protocol !== "v3") {
      console.log("  V4 — sem DecreaseLiquidity/Collect; fica no snapshot, marcado como tal");
      if (aplicar && row.receiptSource === null) {
        await db.update(closedLpPositions).set({ receiptSource: "snapshot" }).where(eq(closedLpPositions.id, row.id));
      }
      continue;
    }

    // O recibo arquivado não guarda o pool; o NPM guarda. positions() segue
    // respondendo depois do fechamento enquanto o NFT não for queimado.
    const chainKey = row.chain as ChainKey;
    let pos;
    try {
      pos = await getPublicClient(chainKey).readContract({
        address: chains[chainKey].uniswapV3.nonfungiblePositionManager as Address,
        abi: nonfungiblePositionManagerAbi,
        functionName: "positions",
        args: [BigInt(row.tokenId)],
      });
    } catch {
      console.log("  NFT queimado — sem positions() não dá pra achar o pool, fica como está");
      continue;
    }
    const [, , token0, token1, fee] = pos;
    const info = await getPoolInfo(chainKey, token0, token1, fee);
    if (!info) {
      console.log("  pool não encontrado, fica como está");
      continue;
    }

    const r = await readV3CloseReceipt({
      chainKey,
      tokenId: BigInt(row.tokenId),
      poolAddress: info.poolAddress,
      decimals0: info.token0.decimals,
      decimals1: info.token1.decimals,
      mintTxHash: row.mintGasTxHash,
    });
    if (!r) {
      console.log("  eventos não formam recibo completo, fica como está");
      continue;
    }

    console.log(`                   gravado      chain`);
    console.log(`  entrada        ${col(row.entryValueToken1)}  ${col(r.entryValueToken1)}`);
    console.log(`  final          ${col(row.finalPositionValueToken1)}  ${col(r.finalPositionValueToken1)}`);
    console.log(`  fees           ${col(row.finalFeesValueToken1)}  ${col(r.finalFeesValueToken1)}   (${r.feesAmount0.toPrecision(4)} ${row.token0Symbol} + ${r.feesAmount1.toPrecision(4)} ${row.token1Symbol})`);
    console.log(`  P&L total      ${n(row.totalPnlToken1).padStart(9)}  ${n(r.totalPnlToken1).padStart(9)}`);
    console.log(`  vs HOLD        ${n(row.ilToken1 + row.finalFeesValueToken1).padStart(9)}  ${n(r.ilToken1 + r.finalFeesValueToken1).padStart(9)}`);
    console.log(`  aberta   ${row.openedAt.toISOString()} -> ${r.openedAt.toISOString()}`);
    console.log(`  fechada  ${row.closedAt.toISOString()} -> ${r.closedAt.toISOString()}`);

    if (!aplicar) continue;
    await db
      .update(closedLpPositions)
      .set({
        openedAt: r.openedAt,
        closedAt: r.closedAt,
        entryValueToken1: r.entryValueToken1,
        finalPositionValueToken1: r.finalPositionValueToken1,
        finalFeesValueToken1: r.finalFeesValueToken1,
        hodlValueToken1: r.hodlValueToken1,
        ilToken1: r.ilToken1,
        totalPnlToken1: r.totalPnlToken1,
        feesAmount0: r.feesAmount0,
        feesAmount1: r.feesAmount1,
        receiptSource: "onchain",
      })
      .where(eq(closedLpPositions.id, row.id));
    console.log("  APLICADO");
  }

  if (!aplicar) console.log("\n(simulação — faça um dump e rode com --aplicar pra escrever)");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

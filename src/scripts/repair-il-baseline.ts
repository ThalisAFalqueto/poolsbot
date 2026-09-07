// Script pontual — recoloca o baseline de IL no preço de ABERTURA da posição,
// lido da blockchain.
//
// Uso: tsx src/scripts/repair-il-baseline.ts [--aplicar]
//
// POR QUE ISSO EXISTE. O baseline guarda o preço do pool no instante em que a
// posição foi aberta; o IL é a comparação desse preço com o de agora. Quando
// uma posição é recriada no banco (aconteceu em 03/09/2026, ver
// repair-false-close.ts), o baseline nasce com o preço DE HOJE — e o IL passa
// a ser medido a partir da data errada, mostrando ~zero.
//
// Eu cheguei a dizer ao usuário que esse dado era irrecuperável. Estava
// errado: o preço de abertura está na chain, no bloco da transação de mint, e
// o hash dessa transação está guardado em lp_positions.mint_gas_tx_hash. É a
// mesma leitura histórica de slot0 que backfill-price-onchain.ts já faz.
//
// Só toca em baseline cujo recordedAt é MUITO posterior à abertura da posição
// — o sinal de que ele foi recriado em vez de nascer junto.

import { parseAbi, type Address } from "viem";
import { eq } from "drizzle-orm";
import type { ChainKey } from "../config/chains.js";
import { getPublicClient } from "../data/onchain/client.js";
import { db } from "../persistence/db.js";
import { lpPositionIlBaseline, lpPositions } from "../persistence/schema/index.js";

const aplicar = process.argv.includes("--aplicar");

/** Folga entre a abertura da posição e o baseline antes de considerar que ele
 *  foi recriado. 1h cobre o atraso normal (o job só vê a posição no ciclo
 *  seguinte ao mint) sem confundir com recriação dias depois. */
const FOLGA_MS = 3600_000;

const slot0Abi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
]);

async function main() {
  const linhas = await db
    .select({ pos: lpPositions, base: lpPositionIlBaseline })
    .from(lpPositions)
    .innerJoin(lpPositionIlBaseline, eq(lpPositionIlBaseline.lpPositionId, lpPositions.id));

  let achou = 0;

  for (const { pos, base } of linhas) {
    const atraso = base.recordedAt.getTime() - pos.createdAt.getTime();
    if (atraso <= FOLGA_MS) continue;
    achou++;

    console.log(`\n#${pos.tokenId} (${pos.chain} ${pos.protocol})`);
    console.log(`  posição aberta em ${pos.createdAt.toISOString()}`);
    console.log(`  baseline gravado em ${base.recordedAt.toISOString()}  (${(atraso / 86400000).toFixed(1)} dias depois)`);

    if (!pos.mintGasTxHash) {
      console.log("  sem hash da transação de mint — não dá pra achar o bloco de abertura, pulando");
      continue;
    }
    if (pos.protocol !== "v3") {
      console.log("  só V3 por enquanto: no V4 o poolAddress é um PoolId e a leitura histórica é pelo StateView, pulando");
      continue;
    }

    const client = getPublicClient(pos.chain as ChainKey);
    const receipt = await client.getTransactionReceipt({ hash: pos.mintGasTxHash as `0x${string}` });
    const slot0 = await client.readContract({
      address: pos.poolAddress as Address,
      abi: slot0Abi,
      functionName: "slot0",
      blockNumber: receipt.blockNumber,
    });

    console.log(`  bloco do mint ${receipt.blockNumber}`);
    console.log(`  tick   ${base.tick}  ->  ${slot0[1]}`);
    console.log(`  sqrtP  ${base.sqrtPriceX96}  ->  ${slot0[0]}`);

    if (!aplicar) continue;

    // wasReset fica FALSE: o baseline volta a ser o da abertura real, então
    // não há nada a ressalvar no texto do /positions. Marcar como reset diria
    // ao usuário que o IL está truncado quando ele deixou de estar.
    await db
      .update(lpPositionIlBaseline)
      .set({ sqrtPriceX96: slot0[0].toString(), tick: slot0[1], recordedAt: pos.createdAt, wasReset: false })
      .where(eq(lpPositionIlBaseline.id, base.id));
    console.log("  APLICADO");
  }

  if (achou === 0) console.log("Nenhum baseline parece ter sido recriado — nada a fazer.");
  else if (!aplicar) console.log("\n(simulação — rode com --aplicar pra escrever)");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

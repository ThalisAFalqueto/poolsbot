// Script pontual — repara posições ARQUIVADAS POR ENGANO como fechadas.
//
// Uso: tsx src/scripts/repair-false-close.ts [--aplicar]
// Sem --aplicar, só mostra o que faria.
//
// O QUE ACONTECEU. Até 07/09/2026 o job decidia "fechou" por ausência: se a
// posição sumia da lista lida on-chain, era arquivada em closed_lp_positions e
// apagada de lp_positions. Uma falha PARCIAL de RPC encolhia essa lista sem
// erro nenhum (ver assertNoPartialFailure em data/onchain/client.ts), e uma
// posição aberta era dada como fechada — perdendo gas de mint, data de
// abertura e baseline de IL, e ganhando uma entrada falsa no /closed.
//
// Aconteceu com a WBTC/USDC #5674258 em 03/09 16:00, recriada 16:15.
//
// A causa está corrigida (confirmação on-chain antes de arquivar). Este script
// conserta o que já estragou: acha tokenId que aparece nas DUAS tabelas,
// confirma on-chain que ainda tem liquidez, e devolve pra linha ativa o que
// ficou preservado na linha fantasma.

import { and, eq } from "drizzle-orm";
import type { ChainKey } from "../config/chains.js";
import { confirmPositionClosed } from "../data/onchain/confirm-closed.js";
import { db } from "../persistence/db.js";
import { closedLpPositions, lpPositionIlBaseline, lpPositions } from "../persistence/schema/index.js";

const aplicar = process.argv.includes("--aplicar");

async function main() {
  const ativas = await db.select().from(lpPositions);
  const fechadas = await db.select().from(closedLpPositions);

  // Fantasma = mesmo (chain, protocol, tokenId) nas duas tabelas. Uma posição
  // de verdade fechada não existe mais em lp_positions.
  const suspeitas = fechadas.filter((f) =>
    ativas.some((a) => a.tokenId === f.tokenId && a.chain === f.chain && a.protocol === f.protocol)
  );

  if (suspeitas.length === 0) {
    console.log("Nenhuma posição aparece nas duas tabelas — nada a reparar.");
    process.exit(0);
  }

  console.log(`${suspeitas.length} posição(ões) em lp_positions E closed_lp_positions:\n`);

  for (const f of suspeitas) {
    const ativa = ativas.find((a) => a.tokenId === f.tokenId && a.chain === f.chain && a.protocol === f.protocol)!;

    // Confirma antes de reparar — se ela de fato fechou e foi reaberta com o
    // MESMO tokenId (impossível no Uniswap, mas o script não precisa apostar
    // nisso), reparar seria o erro oposto.
    const r = await confirmPositionClosed(f.chain as ChainKey, f.protocol, f.tokenId);
    if (r.closed !== false) {
      console.log(`  #${f.tokenId}: on-chain diz ${r.closed === true ? "FECHADA" : "indeterminado"} — deixando como está.`);
      continue;
    }

    console.log(`  #${f.tokenId} (${f.chain} ${f.protocol}) — aberta on-chain, arquivamento foi engano`);
    console.log(`     created_at   ${ativa.createdAt.toISOString()}  ->  ${f.openedAt.toISOString()}`);
    console.log(`     mint_gas     ${ativa.mintGasNative ?? "(perdido)"}  ->  ${f.mintGasNative ?? "(não tinha)"}`);
    console.log(`     apaga closed_lp_positions #${f.id} (P&L falso de ${f.totalPnlToken1.toFixed(4)})`);

    if (!aplicar) continue;

    await db.transaction(async (tx) => {
      await tx
        .update(lpPositions)
        .set({ createdAt: f.openedAt, mintGasNative: f.mintGasNative, mintGasTxHash: f.mintGasTxHash })
        .where(eq(lpPositions.id, ativa.id));

      // O baseline de IL foi recriado junto com a linha, então mede a partir
      // da data errada. Apagar faz o job recriar na próxima passagem — não
      // recupera o IL desde a abertura real (esse dado não existe mais), mas
      // pelo menos para de afirmar uma data que não é verdade.
      await tx.delete(lpPositionIlBaseline).where(eq(lpPositionIlBaseline.lpPositionId, ativa.id));

      await tx.delete(closedLpPositions).where(eq(closedLpPositions.id, f.id));
    });
    console.log("     APLICADO");
  }

  if (!aplicar) console.log("\n(simulação — rode com --aplicar pra escrever)");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

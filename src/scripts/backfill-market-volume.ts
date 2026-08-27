// Script pontual — roda manualmente via `tsx src/scripts/backfill-market-volume.ts`,
// NUNCA é chamado pelo bot em produção.
//
// Preenche de uma vez o histórico diário de volume agregado de DEXs, que é o
// pano de fundo do /mercado e do resumo diário. Diferente do backfill de
// preço/volume por pool (que depende do Dune, pago e com prazo), aqui a
// própria DefiLlama devolve a série INTEIRA desde 2014 numa chamada — ~19 MB,
// gratuita, sem chave de API.
//
// Idempotente: a gravação é onConflictDoNothing por data, então rodar de novo
// não duplica nem sobrescreve.
import { fetchMarketVolumeSeries } from "../data/defillama/dexs.js";
import { insertMarketVolume } from "../persistence/repositories/market.repository.js";

async function main() {
  console.log("Buscando série histórica de volume de DEXs na DefiLlama (~19 MB)...");
  const series = await fetchMarketVolumeSeries();

  if (series.length === 0) {
    console.error("Série vazia — nada gravado. A API mudou de formato?");
    process.exit(1);
  }

  const first = series[0]!;
  const last = series[series.length - 1]!;
  console.log(`${series.length} dias fechados, de ${first.date} a ${last.date}.`);
  console.log("(o dia em curso fica de fora de propósito — é parcial e distorceria médias/percentis)");

  // Em blocos: são milhares de linhas e um INSERT único ficaria grande demais
  // pro driver montar de uma vez.
  const CHUNK = 500;
  for (let i = 0; i < series.length; i += CHUNK) {
    const chunk = series.slice(i, i + CHUNK).map((p) => ({ ...p, source: "defillama_backfill" }));
    await insertMarketVolume(chunk);
    process.stdout.write(`\r  gravados ${Math.min(i + CHUNK, series.length)}/${series.length}`);
  }
  console.log("\nBackfill concluído.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Falha no backfill de volume de mercado:", err);
  process.exit(1);
});

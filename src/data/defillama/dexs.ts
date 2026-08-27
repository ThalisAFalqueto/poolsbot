// Volume agregado de TODAS as DEXs, de todas as chains — a leitura de "como
// está o mercado" que o /mercado e o resumo diário usam. Fica separado de
// client.ts (que é sobre POOLS individuais) porque é outro endpoint, outro
// formato e outro ciclo de vida: a série histórica vem inteira de uma vez.
//
// Dois pesos MUITO diferentes (medidos em 27/08/2026):
//   - com a série histórica: ~19 MB, 4575 pontos diários desde 2014
//   - sem ela:                ~1,8 MB, só os totais
// Por isso a série completa é usada só no backfill (1x, script à mão) e o dia
// a dia usa a variante leve — mesmo padrão de pool_volume_history.

const DEXS_ENDPOINT = "https://api.llama.fi/overview/dexs";
const LIGHT_PARAMS = "excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";

export type MarketVolumePoint = { date: string; volumeUsd: number };

type DexsResponse = {
  total24h?: number;
  change_1d?: number;
  change_7d?: number;
  change_1m?: number;
  totalDataChart?: [number, number][];
};

async function fetchDexs(url: string): Promise<DexsResponse> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DefiLlama dexs falhou: ${res.status} ${res.statusText}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as DexsResponse;
  } catch {
    // Mesmo cuidado do client.ts: o Cloudflare da DefiLlama já foi visto
    // servindo corpo inválido com status 200.
    throw new Error(`DefiLlama dexs não devolveu JSON válido: "${text.slice(0, 100)}"`);
  }
}

function toUtcDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

// Série diária completa — só pro backfill. Descarta o dia de HOJE: o último
// ponto é do dia em CURSO, ainda parcial, e entraria como se fosse um dia
// fechado (afundando qualquer percentil/média calculado em cima).
export async function fetchMarketVolumeSeries(): Promise<MarketVolumePoint[]> {
  const json = await fetchDexs(DEXS_ENDPOINT);
  const chart = json.totalDataChart ?? [];
  const today = new Date().toISOString().slice(0, 10);

  return chart
    .map(([ts, volumeUsd]) => ({ date: toUtcDate(ts), volumeUsd }))
    .filter((p) => p.date < today && p.volumeUsd > 0);
}

export type MarketVolumeNow = {
  /** Janela MÓVEL de 24h (não o dia-calendário) — é o número "agora". */
  total24h: number;
  changePct1d: number | null;
  changePct7d: number | null;
  changePct1m: number | null;
};

export async function fetchMarketVolumeNow(): Promise<MarketVolumeNow> {
  const json = await fetchDexs(`${DEXS_ENDPOINT}?${LIGHT_PARAMS}`);
  return {
    total24h: json.total24h ?? 0,
    changePct1d: json.change_1d ?? null,
    changePct7d: json.change_7d ?? null,
    changePct1m: json.change_1m ?? null,
  };
}

// O ponto de ONTEM (último dia fechado), que é o que pode ser gravado como
// histórico. Usa a série completa porque a variante leve não traz dia-a-dia —
// chamada 1x/dia pelo job, não a cada ciclo.
export async function fetchLastClosedDay(): Promise<MarketVolumePoint | null> {
  const series = await fetchMarketVolumeSeries();
  return series.at(-1) ?? null;
}

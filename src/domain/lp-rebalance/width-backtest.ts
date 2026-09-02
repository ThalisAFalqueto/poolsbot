import { aprForWidth } from "../market/fee-per-liquidity.js";
import { MAX_GAP_DAYS, MIN_POINTS, type PricePoint } from "./range-from-history.js";

// Que largura de faixa usar — respondido pelo histórico real do par, não por
// modelo.
//
// POR QUE ISSO EXISTE. O /range respondia "qual faixa cobre ±1σ no horizonte
// X". Útil, mas não é a pergunta: cobrir mais cenários custa concentração, e
// concentração é de onde vem a taxa. A pergunta certa é qual largura MAXIMIZA
// o que você ganha, contando as duas forças ao mesmo tempo:
//
//   faixa estreita  -> mais taxa por dólar enquanto está dentro
//                      ... e mais tempo fora, ganhando zero
//   faixa larga     -> quase sempre dentro
//                      ... rendendo pouco
//
// Rodado nos 42 dias de histórico do WBTC/USDC em 01/09/2026, janelas móveis
// de 7 dias, o resultado contraria a intuição:
//
//     ±2%   75% do tempo em faixa   147%/ano bruto   109% efetivo
//     ±3%   92%                      98%              90%
//     ±4%   98%                      74%              72%
//     ±8,3% 99%                      36%              36%
//
// Ficar parado fora da faixa custa MUITO menos que perder concentração. Uma
// recomendação anterior de alargar pra ±8,3% (pra mirar 3%/mês) teria cortado
// a taxa em 60% sem ganho real.
//
// Isso é backtest, não previsão: mede o que teria acontecido no regime que já
// passou. Regime muda.

export type WidthResult = {
  halfWidthLog: number;
  /** Fração média do tempo dentro da faixa, entre todas as janelas. */
  timeInRange: number;
  /** Retorno anualizado ENQUANTO em faixa, escalado pela concentração. */
  grossApr: number;
  /** grossApr × timeInRange — o que a largura de fato entrega. */
  effectiveApr: number;
  /** Quantas janelas sustentam o número. Poucas = não confie. */
  windows: number;
};

export type BacktestOptions = {
  widths: number[];
  horizonDays: number;
  /** Taxa medida on-chain numa largura conhecida (ver measurePoolYields). */
  aprAtReferenceWidth: number;
  referenceWidth: number;
};

/** Teto de janelas avaliadas. O passo entre pontos iniciais é ajustado pra
 *  caber nisso — janelas móveis se sobrepõem muito, e a 2000ª não acrescenta
 *  informação que a 400ª já não tenha, só tempo de CPU. */
const MAX_WINDOWS = 400;

/**
 * Simula cada largura contra o histórico real, com janelas móveis.
 *
 * Para cada ponto inicial, centra a faixa no preço DAQUELE instante (é o que
 * você faria ao abrir), anda `horizonDays` e conta a fração de amostras que
 * caiu dentro. Devolve null com histórico curto demais — mesmo critério de
 * `estimateVolatility`, e pelo mesmo motivo: número de amostra pequena aqui
 * vira recomendação de largura, que custa dinheiro.
 */
export function backtestWidths(history: PricePoint[], opts: BacktestOptions): WidthResult[] | null {
  if (history.length < MIN_POINTS || opts.widths.length === 0 || opts.horizonDays <= 0) return null;

  const sorted = [...history].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const ts = sorted.map((p) => p.recordedAt.getTime());
  const px = sorted.map((p) => p.price);

  const horizonMs = opts.horizonDays * 86_400_000;
  const gapMs = MAX_GAP_DAYS * 86_400_000;

  // Índice final de cada janela, achado uma vez e reaproveitado por todas as
  // larguras — a varredura é a parte cara.
  type Janela = { ini: number; fim: number };
  const janelas: Janela[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const alvo = ts[i]! + horizonMs;
    let j = i;
    while (j + 1 < sorted.length && ts[j + 1]! <= alvo) j++;
    if (ts[j]! < alvo) break; // daqui pra frente não cabe mais uma janela inteira

    // Buraco de coleta (bot fora do ar) invalida a janela: não dá pra saber se
    // o preço saiu da faixa enquanto ninguém estava olhando.
    let temBuraco = false;
    for (let k = i; k < j; k++) {
      if (ts[k + 1]! - ts[k]! > gapMs) {
        temBuraco = true;
        break;
      }
    }
    if (!temBuraco) janelas.push({ ini: i, fim: j });
  }
  if (janelas.length === 0) return null;

  const passo = Math.max(1, Math.ceil(janelas.length / MAX_WINDOWS));
  const amostradas = janelas.filter((_, i) => i % passo === 0);

  return opts.widths.map((d) => {
    let soma = 0;
    for (const { ini, fim } of amostradas) {
      const centro = px[ini]!;
      const piso = centro * Math.exp(-d);
      const teto = centro * Math.exp(d);
      let dentro = 0;
      for (let k = ini; k <= fim; k++) {
        if (px[k]! >= piso && px[k]! <= teto) dentro++;
      }
      soma += dentro / (fim - ini + 1);
    }
    const timeInRange = soma / amostradas.length;
    const grossApr = aprForWidth(opts.aprAtReferenceWidth, opts.referenceWidth, d);
    return {
      halfWidthLog: d,
      timeInRange,
      grossApr,
      effectiveApr: grossApr * timeInRange,
      windows: amostradas.length,
    };
  });
}

/** A largura de maior retorno efetivo. Null se o backtest não rodou. */
export function bestWidth(results: WidthResult[] | null): WidthResult | null {
  if (!results || results.length === 0) return null;
  return results.reduce((melhor, r) => (r.effectiveApr > melhor.effectiveApr ? r : melhor));
}

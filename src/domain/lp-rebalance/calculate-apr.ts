const MIN_RELIABLE_DAYS = 1; // abaixo disso, extrapolar pra 30/365 dias é só ruído de amostra pequena

// Checado DEPOIS de anualizar, não no retorno bruto: um retorno bruto
// moderado (ex. 37%) sobre uma janela curta (ex. 2 dias) já vira um número
// anualizado absurdo só pelo fator de extrapolação (~18x nesse caso) — não
// precisa de um retorno bruto exagerado pra isso acontecer. Na prática isso
// captura tanto posições-poeira (valor de entrada residual, tipo 0.0019
// LINK, onde qualquer fee ínfima já é uma fração enorme da base) quanto
// qualquer extrapolação de janela curta que não é mais um sinal útil. Sem
// oráculo de preço USD (decisão deliberada do projeto) não dá pra
// distinguir "posição pequena real" de "poeira" pelo valor absoluto, mas um
// retorno anualizado de 1000%+ não é informativo de qualquer forma.
const MAX_PLAUSIBLE_ANNUALIZED_RETURN = 10; // 1000%

export type CalculateAprInput = {
  entryValueToken1: number;
  totalPnlToken1: number;
  since: Date;
  now: Date;
};

export type AprUnreliableReason = "too_new" | "implausible" | null;

export type AprResult = {
  elapsedDays: number;
  simpleReturnPct: number; // totalPnl / entryValue, sem anualizar
  monthlyEquivalentPct: number; // simpleReturnPct * (30 / elapsedDays)
  annualizedPct: number; // simpleReturnPct * (365 / elapsedDays)
  reliable: boolean;
  unreliableReason: AprUnreliableReason;
};

function unreliable(elapsedDays: number, reason: AprUnreliableReason): AprResult {
  return { elapsedDays, simpleReturnPct: 0, monthlyEquivalentPct: 0, annualizedPct: 0, reliable: false, unreliableReason: reason };
}

// Extrapolação LINEAR (não composta) de propósito: compor um retorno
// observado em poucos dias a cada 30 dias amplificaria ruído de amostra
// pequena de forma enganosa. Linear é mais honesto pra janelas curtas, que
// é o caso comum aqui (posições observadas há dias/semanas, não meses).
export function calculateRealizedApr(input: CalculateAprInput): AprResult {
  const { entryValueToken1, totalPnlToken1, since, now } = input;
  const elapsedDays = (now.getTime() - since.getTime()) / (1000 * 60 * 60 * 24);

  if (entryValueToken1 <= 0 || elapsedDays < MIN_RELIABLE_DAYS) {
    return unreliable(elapsedDays, "too_new");
  }

  const simpleReturnPct = totalPnlToken1 / entryValueToken1;
  const annualizedPct = simpleReturnPct * (365 / elapsedDays);
  if (Math.abs(annualizedPct) > MAX_PLAUSIBLE_ANNUALIZED_RETURN) {
    return unreliable(elapsedDays, "implausible");
  }

  return {
    elapsedDays,
    simpleReturnPct,
    monthlyEquivalentPct: simpleReturnPct * (30 / elapsedDays),
    annualizedPct,
    reliable: true,
    unreliableReason: null,
  };
}

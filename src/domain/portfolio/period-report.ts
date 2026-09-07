// Resultado do mês pelo método de DIFERENÇA DE PATRIMÔNIO.
//
//   P&L = nav_fim − nav_início − depósitos + saques
//
// A vantagem sobre somar componentes (fees − gas − IL ...) é que nenhum custo
// precisa ser enumerado: gas, slippage e taxa de swap saem de algum saldo, e
// portanto já estão embutidos na diferença. Somar componentes esquece em
// silêncio qualquer custo que ninguém programou — e o silêncio é o problema.

export type CashFlow = { direction: "deposit" | "withdrawal"; valueUsdc: number; occurredAt: Date };

/** Resultado de um período qualquer — dia, semana ou mês. Já era genérico
 *  (Modified Dietz sobre periodStart/periodEnd); o nome "monthly" só descrevia
 *  o único chamador que existia. Renomeado em 07/09/2026 junto com /dia e
 *  /semana. */
export type PeriodReport = {
  pnlUsdc: number;
  /** Retorno sobre o capital médio empregado no período (0.03 = +3%). */
  returnPct: number;
  depositsUsdc: number;
  withdrawalsUsdc: number;
  /** Base usada como denominador do retorno — capital inicial + aportes ponderados no tempo. */
  averageCapitalUsdc: number;
};

// Ponderar aporte pelo tempo evita um erro grosseiro: dinheiro que entrou no
// dia 28 não teve o mês inteiro pra render, e dividir o lucro pelo capital
// final faria o retorno parecer artificialmente baixo. Um aporte no primeiro
// dia pesa 1; no último dia, ~0.
function timeWeight(occurredAt: Date, start: Date, end: Date): number {
  const total = end.getTime() - start.getTime();
  if (total <= 0) return 0;
  const remaining = end.getTime() - occurredAt.getTime();
  return Math.min(1, Math.max(0, remaining / total));
}

export function calculatePeriodReport(input: {
  navStartUsdc: number;
  navEndUsdc: number;
  flows: CashFlow[];
  periodStart: Date;
  periodEnd: Date;
}): PeriodReport {
  const { navStartUsdc, navEndUsdc, flows, periodStart, periodEnd } = input;

  let depositsUsdc = 0;
  let withdrawalsUsdc = 0;
  let weightedFlow = 0;

  for (const f of flows) {
    const weight = timeWeight(f.occurredAt, periodStart, periodEnd);
    if (f.direction === "deposit") {
      depositsUsdc += f.valueUsdc;
      weightedFlow += f.valueUsdc * weight;
    } else {
      withdrawalsUsdc += f.valueUsdc;
      weightedFlow -= f.valueUsdc * weight;
    }
  }

  const pnlUsdc = navEndUsdc - navStartUsdc - depositsUsdc + withdrawalsUsdc;
  const averageCapitalUsdc = navStartUsdc + weightedFlow;

  return {
    pnlUsdc,
    // Sem capital empregado não existe "retorno" — devolve 0 em vez de dividir
    // por zero e produzir Infinity/NaN, que vazaria pro texto do Telegram.
    returnPct: averageCapitalUsdc > 0 ? pnlUsdc / averageCapitalUsdc : 0,
    depositsUsdc,
    withdrawalsUsdc,
    averageCapitalUsdc,
  };
}

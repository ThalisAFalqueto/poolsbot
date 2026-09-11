import { isoDate, type PeriodBounds } from "../domain/portfolio/periods.js";
import { findNavAt, listCashFlowsBetween, type CashFlowRow, type NavPointRow } from "../persistence/repositories/wallet-nav.repository.js";

// Os dois patrimônios que um relatório de período compara, e os aportes e
// saques entre eles. Usado por /dia, /semana, /mes e pelo resumo semanal —
// um lugar só, porque a escolha errada da foto já produziu dois bugs.
//
// DOIS BUGS CORRIGIDOS EM 11/09/2026:
//
// 1. Um dia de deslocamento. A foto com data D é tirada às 00:00 UTC de D, ou
//    seja, é o patrimônio no INÍCIO do dia. A abertura era "a última foto
//    ANTES do período" — pra setembro, a de 31/08 00:00 —, então o "setembro"
//    medido ia de 31/08 a 30/09, e o /dia de hoje media ontem. Real: abertura
//    $57,96 (31/08) em vez de $58,68 (01/09).
//
// 2. Fechamento parado na meia-noite. Com o período em andamento, o fechamento
//    era a foto das 00:00 de hoje. O usuário fechou uma posição às 13:13 e o
//    /mes não mudou. Agora o fechamento de período em andamento é medido na
//    hora (measureLive), e só cai na foto se a medição falhar — dizendo isso.
//
// Os aportes e saques contam entre os DOIS INSTANTES MEDIDOS, não entre as
// fronteiras do calendário: é isso que garante que cada aporte seja subtraído
// exatamente uma vez, mesmo quando a foto atrasou porque o bot estava fora.

export type NavPoint = {
  navUsdc: number;
  idleUsdc: number;
  positionsUsdc: number;
  feesUsdc: number;
  at: Date;
  /** true = medido na hora; false = foto diária. */
  live: boolean;
};

export type LiveNavMeasurer = () => Promise<Omit<NavPoint, "live"> | null>;

export type PeriodNav =
  | { status: "ok"; abertura: NavPoint; fechamento: NavPoint; fluxos: CashFlowRow[]; liveFalhou: boolean }
  | { status: "sem-abertura"; fechamento: NavPoint }
  | { status: "sem-dados" };

function daFoto(row: NavPointRow): NavPoint {
  return {
    navUsdc: row.navUsdc,
    idleUsdc: row.idleUsdc,
    positionsUsdc: row.positionsUsdc,
    feesUsdc: row.feesUsdc,
    at: row.recordedAt,
    live: false,
  };
}

/**
 * @param measureLive chamado SÓ com o período em andamento. Sem ele (o resumo
 *   semanal, que mede semana fechada), o fechamento é sempre foto.
 */
export async function loadPeriodNav(
  userId: number,
  periodo: PeriodBounds,
  now: Date,
  measureLive?: LiveNavMeasurer
): Promise<PeriodNav> {
  const emAndamento = now >= periodo.start && now < periodo.end;

  // A foto datada do PRIMEIRO dia do período é a das 00:00 dele — o patrimônio
  // na fronteira. Se o bot estava fora, vale a última anterior (o texto diz de
  // quando ela é).
  const aberturaRow = await findNavAt(userId, isoDate(periodo.start));

  let fechamento: NavPoint | null = null;
  let liveFalhou = false;
  if (emAndamento && measureLive) {
    try {
      const agora = await measureLive();
      if (agora) fechamento = { ...agora, live: true };
      else liveFalhou = true;
    } catch (err) {
      console.error("[period-nav] falha ao medir o patrimônio agora, usando a última foto:", err);
      liveFalhou = true;
    }
  }
  if (!fechamento) {
    // Período fechado: a foto datada do dia SEGUINTE ao último é a das 00:00
    // dele — o patrimônio exatamente no fim do período.
    const row = await findNavAt(userId, isoDate(emAndamento ? now : periodo.end));
    if (row) fechamento = daFoto(row);
  }

  if (!fechamento) return { status: "sem-dados" };
  if (!aberturaRow) return { status: "sem-abertura", fechamento };

  const abertura = daFoto(aberturaRow);
  // A mesma foto dos dois lados (ex.: /dia com só a foto de hoje e a medição
  // ao vivo falhando) não é um período — é zero disfarçado de resultado.
  if (fechamento.at.getTime() <= abertura.at.getTime()) return { status: "sem-dados" };

  const fluxos = await listCashFlowsBetween(userId, abertura.at, fechamento.at);
  return { status: "ok", abertura, fechamento, fluxos, liveFalhou };
}

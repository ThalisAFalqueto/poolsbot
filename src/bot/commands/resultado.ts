import type { CommandContext, Context } from "grammy";
import { loadPeriodNav } from "../../data/period-nav.js";
import { calculatePeriodReport, type CashFlow } from "../../domain/portfolio/period-report.js";
import { boundsFor, isoDate, targetForDays, type PeriodBounds, type PeriodKind } from "../../domain/portfolio/periods.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { measureNavNow } from "../../scheduler/jobs/snapshot-nav.job.js";

// Resultado do período pelo método de diferença de PATRIMÔNIO — ver
// domain/portfolio/period-report.ts pro porquê do método.
//
// Um handler só pra /dia, /semana e /mes: a conta é a mesma (Modified Dietz),
// só mudam os limites e a meta escalada. Antes isso vivia amarrado a mês em
// mes.ts; generalizado em 07/09/2026 a pedido do usuário.
//
// Quais dois patrimônios comparar é decidido em data/period-nav.ts — onde
// estão os dois bugs de 11/09/2026 (abertura um dia antes; fechamento parado
// na foto da meia-noite com o período em andamento).

function formatUsdc(value: number): string {
  return value.toFixed(2);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatUsdc(value)}`;
}

/** "01/09 00:00", em UTC — o instante exato de cada medição, porque é entre
 *  eles que o resultado é calculado. */
function quando(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Lê a data de referência do argumento. Cada período aceita a forma que faz
 *  sentido pra ele; sem argumento, é o período corrente. */
function parseRef(kind: PeriodKind, arg: string | undefined, now: Date): Date | null {
  const texto = arg?.trim();
  if (!texto) return now;

  if (kind === "mes") {
    const m = /^(\d{4})-(\d{2})$/.exec(texto);
    if (!m) return null;
    const mes = Number(m[2]);
    if (mes < 1 || mes > 12) return null;
    return new Date(Date.UTC(Number(m[1]), mes - 1, 15));
  }

  // dia e semana aceitam uma data qualquer (na semana, qualquer dia dela)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!m) return null;
  const d = new Date(`${texto}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const USO: Record<PeriodKind, string> = {
  dia: "Uso: /dia [AAAA-MM-DD] — sem data, o dia de hoje.",
  semana: "Uso: /semana [AAAA-MM-DD] — sem data, a semana atual (segunda a domingo).",
  mes: "Uso: /mes [AAAA-MM] — sem data, o mês atual.",
};

const NOME: Record<PeriodKind, string> = { dia: "dia", semana: "semana", mes: "mês" };
/** "do dia" / "da semana" / "do mês" — o artigo muda com o gênero. */
const DO: Record<PeriodKind, string> = { dia: "do dia", semana: "da semana", mes: "do mês" };
/** "esse dia" / "essa semana" / "esse mês" */
const ESSE: Record<PeriodKind, string> = { dia: "esse dia", semana: "essa semana", mes: "esse mês" };

export function resultadoHandler(kind: PeriodKind) {
  return async (ctx: CommandContext<Context>) => {
    const now = new Date();
    const ref = parseRef(kind, ctx.match?.toString(), now);
    if (!ref) {
      await ctx.reply(USO[kind]);
      return;
    }

    const periodo = boundsFor(kind, ref);
    await responder(ctx, kind, periodo, now);
  };
}

async function responder(ctx: CommandContext<Context>, kind: PeriodKind, periodo: PeriodBounds, now: Date) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const emAndamento = now >= periodo.start && now < periodo.end;
  const medido = await loadPeriodNav(user.id, periodo, now, () => measureNavNow(user.id));

  if (medido.status === "sem-dados") {
    await ctx.reply(
      [
        `📅 ${periodo.label} — sem dados ainda.`,
        "",
        `O resultado ${DO[kind]} compara o patrimônio no início do período com o do fim (ou o de agora, se ainda está em andamento), e ainda não há essas duas medições.`,
      ].join("\n")
    );
    return;
  }

  if (medido.status === "sem-abertura") {
    // Sem abertura não existe diferença a calcular. Usar a primeira foto DO
    // período como abertura zeraria justamente o resultado já decorrido.
    const f = medido.fechamento;
    await ctx.reply(
      [
        `📅 ${periodo.label} — resultado indisponível (sem foto de abertura).`,
        "",
        `Patrimônio ${f.live ? "agora" : `em ${quando(f.at)} UTC`}: ${formatUsdc(f.navUsdc)} USDC`,
        `   em pool ${formatUsdc(f.positionsUsdc)} · parado ${formatUsdc(f.idleUsdc)} · fees a coletar ${formatUsdc(f.feesUsdc)}`,
        "",
        `Pra calcular ${ESSE[kind]} eu precisaria de uma foto do patrimônio de até ${isoDate(periodo.start)}, e a primeira só foi tirada depois.`,
      ].join("\n")
    );
    return;
  }

  const { abertura, fechamento, fluxos, liveFalhou } = medido;
  const report = calculatePeriodReport({
    navStartUsdc: abertura.navUsdc,
    navEndUsdc: fechamento.navUsdc,
    flows: fluxos.map((f): CashFlow => ({ direction: f.direction, valueUsdc: f.valueUsdc, occurredAt: f.occurredAt })),
    // Os instantes MEDIDOS, não as fronteiras do calendário — ver period-nav.ts.
    periodStart: abertura.at,
    periodEnd: fechamento.at,
  });

  // Meta escalada pro período, composta — ver targetForDays.
  const meta = targetForDays(periodo.days);
  const bateu = report.returnPct >= meta;
  const metaLinha = `${bateu ? "✅ acima" : "⚠️ abaixo"} da meta de ${(meta * 100).toFixed(2)}%/${NOME[kind]} (3%/mês)`;

  const fluxoLinhas: string[] = [];
  if (report.depositsUsdc > 0) fluxoLinhas.push(`aportes ${formatUsdc(report.depositsUsdc)}`);
  if (report.withdrawalsUsdc > 0) fluxoLinhas.push(`saques ${formatUsdc(report.withdrawalsUsdc)}`);

  const paradoPct = fechamento.navUsdc > 0 ? (fechamento.idleUsdc / fechamento.navUsdc) * 100 : 0;

  // A linha do capital médio só aparece quando houve movimentação: sem
  // aporte/saque ele é igual ao patrimônio de abertura, e repetir o número
  // seria ruído. COM movimentação ela é essencial — senão o denominador
  // parece arbitrário.
  const capitalLinha =
    fluxoLinhas.length > 0
      ? [`   sobre ${formatUsdc(report.averageCapitalUsdc)} USDC de capital médio — cada aporte conta proporcionalmente aos dias que ficou aplicado`]
      : [];

  // Num único dia o patrimônio é dominado por PREÇO, não por taxa: com σ de
  // ~2,7%/dia no ETH, o BTC/ETH move o número muito mais que a taxa rende.
  // Sem este aviso o /dia vira leitura de humor do mercado com cara de
  // desempenho.
  const avisoRuido =
    kind === "dia"
      ? [
          "",
          "⚠️ Num único dia esse número é quase todo movimento de preço, não taxa. O ETH anda ~2,7%/dia; sua taxa rende uma fração disso. Pra medir o que a pool fez, olhe a semana ou o mês.",
        ]
      : [];

  // A medição ao vivo falhou: o número existe, mas para na foto. Dizer isso é
  // o que separa "não mudou" de "não vi mudar".
  const avisoFoto =
    emAndamento && liveFalhou
      ? ["", `⚠️ Não consegui medir o patrimônio agora; o fechamento é a foto de ${quando(fechamento.at)} UTC e não inclui o que aconteceu depois dela.`]
      : [];

  const medicoes = `Abertura: foto de ${quando(abertura.at)} UTC · fechamento: ${
    fechamento.live ? `agora (${quando(fechamento.at)} UTC), medido na hora` : `foto de ${quando(fechamento.at)} UTC`
  }. Aportes e saques contam entre esses dois instantes.`;

  await ctx.reply(
    [
      `📅 Resultado de ${periodo.label}${emAndamento ? ` (${NOME[kind]} em andamento)` : ""}`,
      "",
      `Patrimônio: ${formatUsdc(abertura.navUsdc)} → ${formatUsdc(fechamento.navUsdc)} USDC`,
      fluxoLinhas.length > 0 ? `Movimentações: ${fluxoLinhas.join(" · ")} USDC` : "Movimentações: nenhuma (nem aporte nem saque)",
      "",
      `P&L: ${signed(report.pnlUsdc)} USDC (${signed(report.returnPct * 100)}%) ${metaLinha}`,
      ...capitalLinha,
      ...avisoRuido,
      ...avisoFoto,
      "",
      `Composição ${fechamento.live ? "agora" : `em ${quando(fechamento.at)}`}: em pool ${formatUsdc(fechamento.positionsUsdc)} · parado ${formatUsdc(fechamento.idleUsdc)} (${paradoPct.toFixed(0)}%) · fees a coletar ${formatUsdc(fechamento.feesUsdc)}`,
      "",
      `* Mede a variação do patrimônio TOTAL, então já desconta gas, slippage e taxa de swap — nada precisa ser somado à parte. Diferente do /positions, o capital parado entra na conta e puxa o retorno pra baixo. Valores em USDC a preço de pool on-chain (aproximado, não é cotação em dólar). ${medicoes}`,
    ].join("\n")
  );
}

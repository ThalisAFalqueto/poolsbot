import type { CommandContext, Context } from "grammy";
import { formatPrice } from "../../domain/lp-rebalance/format-reason.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { listClosedPositions, type ClosedPositionRow } from "../../persistence/repositories/lp-positions.repository.js";

function buildClosedBlock(row: ClosedPositionRow): string {
  const name = row.label ?? `#${row.tokenId}`;
  const opened = row.openedAt.toLocaleDateString("pt-BR");
  const closed = row.closedAt.toLocaleDateString("pt-BR");
  const vsHold = row.ilToken1 + row.finalFeesValueToken1;

  return [
    `${row.token0Symbol}/${row.token1Symbol} (${name}) — ${opened} a ${closed}`,
    `   Entrada: ${formatPrice(row.entryValueToken1)} ${row.token1Symbol} · Final: ${formatPrice(row.finalPositionValueToken1)} ${row.token1Symbol} · Fees: ${formatPrice(row.finalFeesValueToken1)} ${row.token1Symbol}`,
    `   P&L total (com fees): ${row.totalPnlToken1 >= 0 ? "+" : ""}${formatPrice(row.totalPnlToken1)} ${row.token1Symbol} · vs HOLD: ${vsHold >= 0 ? "+" : ""}${formatPrice(vsHold)} ${row.token1Symbol}`,
  ].join("\n");
}

export async function closedCommand(ctx: CommandContext<Context>) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const rows = await listClosedPositions(user.id);

  if (rows.length === 0) {
    await ctx.reply(
      "Nenhuma posição fechada registrada ainda. Só fica registrado aqui o que foi arquivado a partir de um /positions rodado antes do fechamento — ver /status se uma posição sumiu sem aparecer aqui."
    );
    return;
  }

  const blocks = rows.map(buildClosedBlock);
  await ctx.reply(["Posições de LP fechadas:", "", ...blocks].join("\n\n"));
}

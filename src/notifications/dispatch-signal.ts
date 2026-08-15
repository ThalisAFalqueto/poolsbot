import type { Signal } from "../domain/signals/types.js";
import { getPoolById } from "../data/defillama/client.js";
import { telegramChannel } from "./channels/telegram.channel.js";
import type { NotificationChannel } from "./notification.interface.js";

export async function dispatchSignal(
  signal: Signal,
  chatId: string,
  channel: NotificationChannel = telegramChannel
): Promise<void> {
  // rebalance_lp não é identificado por um pool da DefiLlama (poolId aqui é
  // o tokenId da posição on-chain) — o próprio reason já é autossuficiente
  // (gerado por domain/lp-rebalance/format-reason.ts, com call-to-action
  // própria), então pula o enriquecimento e o rodapé fixo de /pool//alerts.
  if (signal.type === "rebalance_lp") {
    await channel.send(chatId, signal.reason);
    return;
  }

  const pool = await getPoolById(signal.poolId).catch(() => undefined);
  const header = pool ? `${pool.project} — ${pool.symbol} (${pool.chain})` : `Pool ${signal.poolId}`;
  const text = [header, signal.reason, "", `Use /pool ${signal.poolId} ou /alerts para gerenciar.`].join("\n");
  await channel.send(chatId, text);
}

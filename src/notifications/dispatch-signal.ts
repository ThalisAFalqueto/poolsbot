import type { Signal } from "../domain/signals/types.js";
import { getPoolById } from "../data/defillama/client.js";
import { telegramChannel } from "./channels/telegram.channel.js";
import type { NotificationChannel } from "./notification.interface.js";

export async function dispatchSignal(
  signal: Signal,
  chatId: string,
  channel: NotificationChannel = telegramChannel
): Promise<void> {
  const pool = await getPoolById(signal.poolId).catch(() => undefined);
  const header = pool ? `${pool.project} — ${pool.symbol} (${pool.chain})` : `Pool ${signal.poolId}`;
  const text = [header, signal.reason, "", `Use /pool ${signal.poolId} ou /alerts para gerenciar.`].join("\n");
  await channel.send(chatId, text);
}

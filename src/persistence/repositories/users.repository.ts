import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { users } from "../schema/index.js";

export async function findOrCreateUserByTelegramChatId(chatId: string) {
  const existing = await db.select().from(users).where(eq(users.telegramChatId, chatId)).limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(users)
    .values({ telegramChatId: chatId })
    .onConflictDoNothing({ target: users.telegramChatId })
    .returning();

  if (inserted[0]) return inserted[0];

  // corrida rara: outra chamada concorrente inseriu entre o select e o insert
  const [row] = await db.select().from(users).where(eq(users.telegramChatId, chatId)).limit(1);
  if (!row) {
    throw new Error(`Falha ao resolver usuário para chatId ${chatId} após inserção concorrente.`);
  }
  return row;
}

/** Liga/desliga o aviso de aproximação da borda pro usuário. Devolve o estado
 *  novo, pra quem chama poder confirmar sem uma segunda consulta. */
export async function setNearEdgeAlerts(userId: number, enabled: boolean): Promise<boolean> {
  await db.update(users).set({ nearEdgeAlerts: enabled }).where(eq(users.id, userId));
  return enabled;
}

export async function getNearEdgeAlerts(userId: number): Promise<boolean> {
  const [row] = await db.select({ on: users.nearEdgeAlerts }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.on ?? false;
}

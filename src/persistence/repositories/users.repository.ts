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

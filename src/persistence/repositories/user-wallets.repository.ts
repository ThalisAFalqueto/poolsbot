import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { userWallets } from "../schema/index.js";

export type UserWallet = { id: number; address: string; label: string | null; createdAt: Date };

export async function addWallet(userId: number, address: string, label?: string): Promise<{ wasNew: boolean }> {
  const [existing] = await db
    .select({ id: userWallets.id })
    .from(userWallets)
    .where(and(eq(userWallets.userId, userId), eq(userWallets.address, address)))
    .limit(1);
  if (existing) return { wasNew: false };

  await db.insert(userWallets).values({ userId, address, label: label ?? null });
  return { wasNew: true };
}

export async function removeWallet(userId: number, address: string): Promise<boolean> {
  const deleted = await db
    .delete(userWallets)
    .where(and(eq(userWallets.userId, userId), eq(userWallets.address, address)))
    .returning({ id: userWallets.id });
  return deleted.length > 0;
}

export async function listWallets(userId: number): Promise<UserWallet[]> {
  return db.select().from(userWallets).where(eq(userWallets.userId, userId));
}

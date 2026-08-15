import {
  pgTable,
  serial,
  text,
  timestamp,
  doublePrecision,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    telegramChatId: text("telegram_chat_id").notNull(),
    walletAddress: text("wallet_address"), // endereço público (nunca chave privada)
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    telegramChatIdIdx: uniqueIndex("users_telegram_chat_id_idx").on(table.telegramChatId),
  })
);

export const watchedPools = pgTable("watched_pools", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  poolId: text("pool_id").notNull(), // id do pool na DefiLlama
  chain: text("chain").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const alertsConfig = pgTable("alerts_config", {
  id: serial("id").primaryKey(),
  watchedPoolId: integer("watched_pool_id")
    .notNull()
    .references(() => watchedPools.id),
  metric: text("metric").notNull(), // 'apy_drop' | 'tvl_drop' | 'il_threshold'
  thresholdValue: doublePrecision("threshold_value").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Série temporal de APY/TVL por pool. Candidata a hypertable do TimescaleDB
// (docker-compose já usa a imagem timescaledb) quando o volume justificar.
export const apyHistory = pgTable("apy_history", {
  id: serial("id").primaryKey(),
  poolId: text("pool_id").notNull(),
  chain: text("chain").notNull(),
  apyBase: doublePrecision("apy_base"),
  apyReward: doublePrecision("apy_reward"),
  apy: doublePrecision("apy").notNull(),
  tvlUsd: doublePrecision("tvl_usd").notNull(),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
});

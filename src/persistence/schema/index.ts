import {
  pgTable,
  pgEnum,
  serial,
  text,
  timestamp,
  doublePrecision,
  integer,
  boolean,
  uniqueIndex,
  index,
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

export const watchedPools = pgTable(
  "watched_pools",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    poolId: text("pool_id").notNull(), // id do pool na DefiLlama
    chain: text("chain").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userPoolIdx: uniqueIndex("watched_pools_user_id_pool_id_idx").on(table.userId, table.poolId),
  })
);

export const alertMetricEnum = pgEnum("alert_metric", [
  "apy_drop_relative",
  "apy_below_absolute",
  "tvl_drop_relative",
  "tvl_below_absolute",
  "reward_apy_ending",
  "il_risk_proxy",
]);

export const alertStatusEnum = pgEnum("alert_status", ["ok", "triggered"]);

export const alertRules = pgTable(
  "alert_rules",
  {
    id: serial("id").primaryKey(),
    watchedPoolId: integer("watched_pool_id")
      .notNull()
      .references(() => watchedPools.id, { onDelete: "cascade" }),
    metric: alertMetricEnum("metric").notNull(),
    thresholdValue: doublePrecision("threshold_value").notNull(),
    // null para métricas absolutas e reward_apy_ending (que sempre compara vs. snapshot anterior)
    windowHours: integer("window_hours"),
    reminderIntervalHours: integer("reminder_interval_hours").notNull().default(6),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    watchedPoolIdx: index("alert_rules_watched_pool_id_idx").on(table.watchedPoolId),
  })
);

// Estado de disparo separado da definição da regra: alertRules é escrita
// raramente (usuário criando/removendo), alertState é escrita a cada ciclo
// de 15min para toda regra ativa.
export const alertState = pgTable(
  "alert_state",
  {
    id: serial("id").primaryKey(),
    alertRuleId: integer("alert_rule_id")
      .notNull()
      .references(() => alertRules.id, { onDelete: "cascade" }),
    status: alertStatusEnum("status").notNull().default("ok"),
    lastValue: doublePrecision("last_value"),
    triggeredAt: timestamp("triggered_at"),
    lastNotifiedAt: timestamp("last_notified_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    alertRuleIdx: uniqueIndex("alert_state_alert_rule_id_idx").on(table.alertRuleId),
  })
);

// Série temporal de APY/TVL por pool. Candidata a hypertable do TimescaleDB
// (docker-compose já usa a imagem timescaledb) quando o volume justificar.
export const apyHistory = pgTable(
  "apy_history",
  {
    id: serial("id").primaryKey(),
    poolId: text("pool_id").notNull(),
    chain: text("chain").notNull(),
    apyBase: doublePrecision("apy_base"),
    apyReward: doublePrecision("apy_reward"),
    apy: doublePrecision("apy").notNull(),
    tvlUsd: doublePrecision("tvl_usd").notNull(),
    ilRisk: text("il_risk"), // passthrough categórico da DefiLlama ('yes'|'no')
    il7d: doublePrecision("il7d"), // passthrough numérico da DefiLlama, geralmente null
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => ({
    poolIdRecordedAtIdx: index("apy_history_pool_id_recorded_at_idx").on(table.poolId, table.recordedAt),
  })
);

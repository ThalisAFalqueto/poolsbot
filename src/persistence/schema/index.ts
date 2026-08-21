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
  date,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    telegramChatId: text("telegram_chat_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    telegramChatIdIdx: uniqueIndex("users_telegram_chat_id_idx").on(table.telegramChatId),
  })
);

// Um usuário pode vincular mais de uma wallet (endereço público, nunca
// chave privada) — ex: uma wallet separada só pra LP. lp_positions não
// referencia esta tabela diretamente: cada posição já é identificada por
// (tokenId, chain) e associada ao userId, não a uma wallet específica.
export const userWallets = pgTable(
  "user_wallets",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdAddressIdx: uniqueIndex("user_wallets_user_id_address_idx").on(table.userId, table.address),
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
  "volume_spike_relative",
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
    // volumeUsd1d da DefiLlama, já buscado de graça na mesma chamada que
    // abastece o resto da linha — usado pelo alerta volume_spike_relative
    // (reusa o mesmo mecanismo de baseline windowHours/findClosestBefore
    // já existente pros outros metrics, em vez de inventar um caminho
    // novo). Null em pools que não são DEX (ex: staking).
    volumeUsd: doublePrecision("volume_usd"),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => ({
    poolIdRecordedAtIdx: index("apy_history_pool_id_recorded_at_idx").on(table.poolId, table.recordedAt),
  })
);

// Volume diário por pool — granularidade de DIA (não a cada 15min como
// apy_history), é o que a detecção de pico de volume (tipo wash trading,
// regra de +500% dia-sobre-dia) precisa. Duas fontes possíveis: backfill
// pontual via Dune (script manual, roda uma vez, alta precisão — soma
// exata dos swaps do dia) ou ingestão contínua via DefiLlama (job de
// 15min, grava 1x/dia o volumeUsd1d que já vem de graça na mesma chamada
// que abastece apy_history) — "source" existe pra não confundir as duas
// precisões na hora de debugar.
export const poolVolumeHistory = pgTable(
  "pool_volume_history",
  {
    id: serial("id").primaryKey(),
    poolId: text("pool_id").notNull(), // mesmo id da DefiLlama usado em watchedPools/apyHistory
    date: date("date").notNull(),
    volumeUsd: doublePrecision("volume_usd").notNull(),
    source: text("source").notNull(), // "dune_backfill" | "defillama_ingest"
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => ({
    poolIdDateIdx: uniqueIndex("pool_volume_history_pool_id_date_idx").on(table.poolId, table.date),
  })
);

export const lpPositionStatusEnum = pgEnum("lp_position_status", ["in_range", "out_of_range"]);

// Diferente de alertRules (só muda quando o usuário interage com o bot), a
// "definição" de uma posição de LP pode mudar FORA do bot a qualquer
// momento — abrir, fechar, ou transferir o NFT pra outra wallet. Por isso
// esta tabela é RECONCILIADA a cada ciclo do scheduler (upsert do que está
// ativo on-chain + delete de qualquer tokenId que não apareça mais no
// conjunto ativo daquele usuário/chain), não só escrita sob comando do
// usuário.
export const lpPositions = pgTable(
  "lp_positions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chain: text("chain").notNull(),
    tokenId: text("token_id").notNull(), // uint256 on-chain; texto evita overflow, mesmo padrão de poolId
    poolAddress: text("pool_address").notNull(),
    token0Address: text("token0_address").notNull(),
    token1Address: text("token1_address").notNull(),
    token0Symbol: text("token0_symbol").notNull(),
    token1Symbol: text("token1_symbol").notNull(),
    token0Decimals: integer("token0_decimals").notNull(),
    token1Decimals: integer("token1_decimals").notNull(),
    fee: integer("fee").notNull(), // hundredths of a bip: 500/3000/10000
    tickLower: integer("tick_lower").notNull(),
    tickUpper: integer("tick_upper").notNull(),
    // Apelido opcional pra referenciar a posição sem o tokenId cru (usado
    // por /labelposition e /graph). ATENÇÃO: nunca incluir em
    // PositionUpsertInput — a reconciliação de 15min faz .update(...).set({
    // ...input }), e como label não está no tipo do input, o spread não
    // sobrescreve a coluna. Só escrever nela via setPositionLabel().
    label: text("label"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    tokenIdChainIdx: uniqueIndex("lp_positions_token_id_chain_idx").on(table.tokenId, table.chain),
    userIdx: index("lp_positions_user_id_idx").on(table.userId),
  })
);

// Estado de disparo separado da definição, espelhando alertState — escrito a
// cada ciclo de 15min, 1:1 com lp_positions.
export const lpPositionState = pgTable(
  "lp_position_state",
  {
    id: serial("id").primaryKey(),
    lpPositionId: integer("lp_position_id")
      .notNull()
      .references(() => lpPositions.id, { onDelete: "cascade" }),
    status: lpPositionStatusEnum("status").notNull().default("in_range"),
    outOfRangeSince: timestamp("out_of_range_since"),
    lastNotifiedAt: timestamp("last_notified_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    lpPositionIdx: uniqueIndex("lp_position_state_lp_position_id_idx").on(table.lpPositionId),
  })
);

// Baseline de IL: snapshot do preço + liquidez no momento em que o poolsbot
// passou a observar essa CONFIGURAÇÃO da posição. Quase-imutável — só muda
// (é resetada) quando a liquidez detectada diverge da liquidez salva aqui,
// sinalizando add/remove liquidity feito fora do bot. wasReset diferencia
// "baseline original" de "resetado ao menos uma vez" pra exibição honesta.
export const lpPositionIlBaseline = pgTable(
  "lp_position_il_baseline",
  {
    id: serial("id").primaryKey(),
    lpPositionId: integer("lp_position_id")
      .notNull()
      .references(() => lpPositions.id, { onDelete: "cascade" }),
    liquidity: text("liquidity").notNull(), // uint128 on-chain; texto evita overflow
    sqrtPriceX96: text("sqrt_price_x96").notNull(), // uint160 on-chain; texto evita overflow
    tick: integer("tick").notNull(), // não usado no cálculo; só debug/auditoria
    wasReset: boolean("was_reset").notNull().default(false),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => ({
    lpPositionIdx: uniqueIndex("lp_position_il_baseline_lp_position_id_idx").on(table.lpPositionId),
  })
);

// Estado de disparo do alerta de IL alto, espelhando lp_position_state (que
// cobre a dimensão in/out-of-range) — mas pra dimensão de IL, independente.
// Reaproveita alertStatusEnum (ok/triggered) já definido pro motor de
// alertas do v1, mesmo domínio de valores.
export const lpPositionIlAlertState = pgTable(
  "lp_position_il_alert_state",
  {
    id: serial("id").primaryKey(),
    lpPositionId: integer("lp_position_id")
      .notNull()
      .references(() => lpPositions.id, { onDelete: "cascade" }),
    status: alertStatusEnum("status").notNull().default("ok"),
    triggeredAt: timestamp("triggered_at"),
    lastNotifiedAt: timestamp("last_notified_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    lpPositionIdx: uniqueIndex("lp_position_il_alert_state_lp_position_id_idx").on(table.lpPositionId),
  })
);

// Snapshot do último run de cada job do scheduler (não um log completo,
// só o estado atual) — usado pelo /status pra observabilidade operacional
// sem precisar olhar os logs do pm2. jobName é texto livre (só 3 valores
// hoje: ingest-pools, evaluate-alerts, check-positions), 1 linha por job,
// sobrescrita a cada ciclo de 15min via onConflictDoUpdate.
export const jobStatus = pgTable("job_status", {
  jobName: text("job_name").primaryKey(),
  lastRunAt: timestamp("last_run_at").notNull(),
  lastSuccess: boolean("last_success").notNull(),
  lastSummary: text("last_summary"), // null se falhou antes de gerar um resumo
  lastErrorMessage: text("last_error_message"), // null quando lastSuccess = true
});

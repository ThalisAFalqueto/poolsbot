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

// Preço ao longo do tempo, por pool — usado pro gráfico de linha do /graph
// (mesmo espírito de pool_volume_history, mas chaveado por (chain,
// poolAddress) em vez do poolId da DefiLlama: as duas fontes de escrita
// (backfill via Dune, ingestão contínua) já têm o endereço on-chain do
// pool em mãos — DefiLlama não entra no caminho aqui, então não faz
// sentido depender do id dela. Sem índice único: cada escrita tem um
// recordedAt genuinamente distinto (bucket de hora no backfill, ciclo de
// 15min na ingestão contínua), não precisa de dedup.
export const poolPriceHistory = pgTable(
  "pool_price_history",
  {
    id: serial("id").primaryKey(),
    chain: text("chain").notNull(),
    poolAddress: text("pool_address").notNull(),
    recordedAt: timestamp("recorded_at").notNull(),
    price: doublePrecision("price").notNull(), // token1 por token0, mesma convenção do resto do bot
    source: text("source").notNull(), // "dune_backfill" | "onchain_ingest"
  },
  (table) => ({
    poolRecordedAtIdx: index("pool_price_history_pool_recorded_at_idx").on(table.chain, table.poolAddress, table.recordedAt),
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
    // "v3" | "v4" — tokenId só é único DENTRO de um contrato (NPM V3 e
    // PositionManager V4 são contratos diferentes na mesma chain, podem
    // colidir em tokenId). Default 'v3' cobre a migração sem quebrar linhas
    // já existentes (todas eram V3 antes do V4 existir no bot).
    protocol: text("protocol").notNull().default("v3"),
    // V3: endereço real do pool. V4: guarda o PoolId (bytes32) — não existe
    // endereço de pool próprio no V4 (arquitetura singleton), ver comentário
    // em domain/lp-rebalance/types.ts.
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
    // "Último snapshot conhecido" do P&L completo — escrito só pelo /positions
    // (não pelo job de 15min, que não busca fees por custo de RPC). Existe
    // pra não perder o histórico quando a posição fecha de vez: liquidity=0
    // some do fetch on-chain, e SEM isso a reconciliação simplesmente
    // apagava a linha (IL, fees, P&L, tudo) sem deixar rastro. Ver
    // archiveAndDeleteStalePositions em lp-positions.repository.ts — usa
    // essas colunas pra gravar em closed_lp_positions ANTES de deletar.
    // Todas nullable: uma posição que nunca passou por /positions (só pelo
    // job automático) não tem snapshot pra arquivar, e o fechamento cai de
    // volta no comportamento antigo (sem histórico) — limitação conhecida.
    lastKnownEntryValueToken1: doublePrecision("last_known_entry_value_token1"),
    lastKnownPositionValueToken1: doublePrecision("last_known_position_value_token1"),
    lastKnownFeesValueToken1: doublePrecision("last_known_fees_value_token1"),
    lastKnownHodlValueToken1: doublePrecision("last_known_hodl_value_token1"),
    lastKnownIlToken1: doublePrecision("last_known_il_token1"),
    lastKnownTotalPnlToken1: doublePrecision("last_known_total_pnl_token1"),
    lastKnownEntryDate: timestamp("last_known_entry_date"),
    lastSnapshotAt: timestamp("last_snapshot_at"),
    // Custo real de gas do mint (não estimativa) — gravado 1x, no momento
    // em que upsertPositions sinaliza isNew=true pela 1ª vez (ver
    // findMintGasCost em data/onchain/position-gas.ts). Nullable: posições
    // que já existiam antes dessa coluna existir nunca terão esse dado
    // (isNew só dispara na criação) — limitação aceita.
    mintGasNative: doublePrecision("mint_gas_native"),
    mintGasTxHash: text("mint_gas_tx_hash"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    tokenIdChainIdx: uniqueIndex("lp_positions_token_id_chain_idx").on(table.tokenId, table.chain, table.protocol),
    userIdx: index("lp_positions_user_id_idx").on(table.userId),
  })
);

// Registro PERMANENTE de uma posição depois que ela fecha de vez (liquidez
// zerada, some do fetch on-chain) — sem isso, fechar uma posição apagava
// todo o histórico dela (ver comentário nas colunas lastKnown* acima).
// Nunca é atualizada depois de criada — é o "recibo final" da posição.
export const closedLpPositions = pgTable(
  "closed_lp_positions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chain: text("chain").notNull(),
    tokenId: text("token_id").notNull(),
    protocol: text("protocol").notNull().default("v3"), // ver lpPositions.protocol
    label: text("label"),
    token0Symbol: text("token0_symbol").notNull(),
    token1Symbol: text("token1_symbol").notNull(),
    // Endereço de token1 (não só o símbolo) — necessário pra achar um pool
    // WETH/token1 ao vivo na exibição (/closed), quando token1 é uma
    // stablecoin e a chain paga gas em ETH (ver findUniswapV3Pool/getPoolInfo).
    token1Address: text("token1_address").notNull(),
    openedAt: timestamp("opened_at").notNull(),
    closedAt: timestamp("closed_at").notNull().defaultNow(),
    entryValueToken1: doublePrecision("entry_value_token1").notNull(),
    finalPositionValueToken1: doublePrecision("final_position_value_token1").notNull(),
    finalFeesValueToken1: doublePrecision("final_fees_value_token1").notNull(),
    hodlValueToken1: doublePrecision("hodl_value_token1").notNull(),
    ilToken1: doublePrecision("il_token1").notNull(),
    totalPnlToken1: doublePrecision("total_pnl_token1").notNull(),
    // Custo real de gas (não estimativa) — no token nativo de gas da chain
    // (ETH ou POL, ver nativeGasSymbol abaixo). Nullable: só populado
    // quando o bot conseguiu achar as transações de mint/close dentro da
    // janela de busca (ver position-gas.ts) — "não encontrado" é honesto,
    // não vira 0 disfarçado.
    mintGasNative: doublePrecision("mint_gas_native"),
    mintGasTxHash: text("mint_gas_tx_hash"),
    closeGasNative: doublePrecision("close_gas_native"),
    closeGasTxHashes: text("close_gas_tx_hashes"), // hashes separados por vírgula
    nativeGasSymbol: text("native_gas_symbol"), // "ETH" | "POL" — copiado de chains[chain] no momento do arquivamento
  },
  (table) => ({
    userIdx: index("closed_lp_positions_user_id_idx").on(table.userId),
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

// Fotografia diária do PATRIMÔNIO da carteira (NAV), em USDC. É a base do
// /mes: o resultado do mês sai de `nav_fim − nav_início − depósitos + saques`,
// método que captura QUALQUER custo (gas, slippage, taxa de swap) sem precisar
// enumerá-los — todo custo sai de algum saldo, então aparece sozinho na
// diferença. O caminho por componentes (calculate-pnl.ts) continua existindo e
// é EXATO em token1; este aqui é aproximado por construção, porque converte
// tudo pra USDC a preço de pool do instante da foto (ver data/onchain/
// token-price.ts). Não misturar os dois números sem essa ressalva.
//
// Escrito 1x por dia pelo snapshot-nav.job (que sai cedo se já houver linha
// de hoje, pra não gastar RPC nos outros 95 ciclos de 15min do dia).
// As parcelas ficam em colunas próprias, não só o total, pra o /mes conseguir
// mostrar quanto do capital está parado — que é justamente o que o
// /positions, por olhar só a posição, não revela.
export const walletNavSnapshots = pgTable(
  "wallet_nav_snapshots",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    walletAddress: text("wallet_address").notNull(),
    chain: text("chain").notNull(),
    date: date("date").notNull(), // UTC — fronteira de mês do /mes é UTC, não horário local
    navUsdc: doublePrecision("nav_usdc").notNull(),
    idleUsdc: doublePrecision("idle_usdc").notNull(), // tokens soltos + reserva de gas
    positionsUsdc: doublePrecision("positions_usdc").notNull(),
    feesUsdc: doublePrecision("fees_usdc").notNull(), // fees ainda não coletadas
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => ({
    walletDateIdx: uniqueIndex("wallet_nav_snapshots_wallet_date_idx").on(
      table.userId,
      table.walletAddress,
      table.chain,
      table.date
    ),
  })
);

export const cashFlowDirectionEnum = pgEnum("cash_flow_direction", ["deposit", "withdrawal"]);

// Entradas e saídas de capital da carteira. Sem isso o NAV mente: você
// deposita R$100 e o bot lê como lucro.
//
// Como são detectados (regra validada ao vivo contra as transferências reais
// do usuário): chegou token numa transação que a carteira NÃO assinou =
// depósito (quem manda é a exchange). Se a própria carteira assinou, é
// resultado de operação dela (swap, retirada de pool) e não é dinheiro novo.
// Pro saque, o espelho: saiu token pra um endereço SEM código (carteira
// comum) — pool e router são contratos. A regra de saque ainda não tem
// exemplo real pra validar (o usuário nunca sacou), é a parte mais frágil.
//
// `uniqueId` é o id que a Alchemy dá pra cada transferência — chave natural
// de dedup, já que o job relê janelas sobrepostas.
export const walletCashFlows = pgTable(
  "wallet_cash_flows",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    walletAddress: text("wallet_address").notNull(),
    chain: text("chain").notNull(),
    uniqueId: text("unique_id").notNull(),
    direction: cashFlowDirectionEnum("direction").notNull(),
    asset: text("asset").notNull(),
    amount: doublePrecision("amount").notNull(),
    // Valorado no preço do MOMENTO DA DETECÇÃO (o job roda diariamente), não
    // no instante exato da transação — aproximação assumida. Só existe
    // porque o P&L precisa somar fluxos de moedas diferentes.
    valueUsdc: doublePrecision("value_usdc").notNull(),
    txHash: text("tx_hash").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqueIdIdx: uniqueIndex("wallet_cash_flows_unique_id_idx").on(table.uniqueId),
    userOccurredAtIdx: index("wallet_cash_flows_user_occurred_at_idx").on(table.userId, table.occurredAt),
  })
);

// Volume agregado de TODAS as DEXs por dia — o pano de fundo de mercado que o
// /mercado e o resumo diário usam pra dizer se o momento está aquecido ou
// fraco. Só dias FECHADOS entram: o dia em curso é parcial e distorceria
// qualquer percentil ou média calculada em cima (ver data/defillama/dexs.ts).
//
// Preenchida de uma vez por src/scripts/backfill-market-volume.ts (a API
// devolve a série inteira desde 2014 numa chamada) e mantida pelo job diário.
// Espelha o desenho de pool_volume_history: chave por data, onConflictDoNothing.
export const marketVolumeHistory = pgTable(
  "market_volume_history",
  {
    id: serial("id").primaryKey(),
    date: date("date").notNull(),
    volumeUsd: doublePrecision("volume_usd").notNull(),
    source: text("source").notNull(), // "defillama_backfill" | "defillama_daily"
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => ({
    dateIdx: uniqueIndex("market_volume_history_date_idx").on(table.date),
  })
);

// Pares que o usuário quer acompanhar na comparação entre chains, ALÉM dos
// que ele já tem em posição (esses saem das próprias posições, sem precisar
// configurar nada). Guardado como chave NORMALIZADA (símbolos ordenados, ex:
// "USDC-WBTC") porque cross-chain não dá pra casar por endereço: o mesmo token
// tem contrato diferente em cada chain. Ver domain/market/pair-compare.ts.
export const watchedPairs = pgTable(
  "watched_pairs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pairKey: text("pair_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userPairIdx: uniqueIndex("watched_pairs_user_id_pair_key_idx").on(table.userId, table.pairKey),
  })
);

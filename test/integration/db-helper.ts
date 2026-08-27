import { sql } from "drizzle-orm";
import { db } from "../../src/persistence/db.js";

const TABLES = [
  "users",
  "watched_pools",
  "alert_rules",
  "alert_state",
  "apy_history",
  "lp_positions",
  "lp_position_state",
  "lp_position_il_baseline",
  "lp_position_il_alert_state",
  // As duas abaixo não têm FK pra nenhuma outra tabela — o TRUNCATE CASCADE
  // das demais não alcança elas, então precisam ser listadas na mão. Vazamento
  // real: sem market_volume_history aqui, linhas de um teste sobreviviam pro
  // seguinte e quebravam a asserção de "banco vazio".
  "job_status",
  "market_volume_history",
];

// TRUNCATE com múltiplas tabelas numa única instrução não exige ordem de
// dependência explícita (diferente de DELETE); CASCADE cobre qualquer FK não
// listada. RESTART IDENTITY zera as sequences (ids previsíveis entre testes).
export async function truncateAll(): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE;`));
}

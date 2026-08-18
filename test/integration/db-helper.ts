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
  "job_status", // sem FK pra nenhuma outra tabela — TRUNCATE CASCADE das demais não alcança, precisa listar
];

// TRUNCATE com múltiplas tabelas numa única instrução não exige ordem de
// dependência explícita (diferente de DELETE); CASCADE cobre qualquer FK não
// listada. RESTART IDENTITY zera as sequences (ids previsíveis entre testes).
export async function truncateAll(): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE;`));
}

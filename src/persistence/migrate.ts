import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./db.js";

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations aplicadas com sucesso.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Falha ao aplicar migrations:", err);
  process.exit(1);
});

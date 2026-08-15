import { createBot } from "./bot/bot.js";

async function main() {
  const bot = createBot();
  console.log("Poolsbot iniciando...");
  await bot.start({
    onStart: (info) => console.log(`Bot @${info.username} rodando.`),
  });
}

main().catch((err) => {
  console.error("Falha ao iniciar o bot:", err);
  process.exit(1);
});

import { GrammyError } from "grammy";
import { createBot } from "./bot/bot.js";
import { startScheduler } from "./scheduler/index.js";

// O Telegram só aceita UM long-poll por token. Quando duas instâncias
// disputam (deploy com o processo antigo ainda drenando, ou — o caso real que
// derrubou o bot em 27/08/2026 — uma instância esquecida em outra máquina),
// a que perde recebe 409 e, antes, morria na hora.
//
// Morrer é o pior comportamento possível aqui: o pm2 reinicia em ~1s, o
// processo novo colide de novo, e vira um loop de crash que não sai sozinho —
// exatamente o que aconteceu (283 restarts, bot fora do ar). Esperar e tentar
// de novo transforma isso numa espera que se resolve sozinha assim que a
// outra ponta libera.
const CONFLICT_RETRY_DELAY_MS = 15_000;

function isConflictError(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 409;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const bot = createBot();
  console.log("Poolsbot iniciando...");
  // O scheduler sobe ANTES e independente do bot: monitorar posições e gravar
  // histórico não depende do Telegram estar acessível. Numa disputa de token,
  // o ciclo automático continua rodando enquanto o poll não é resolvido.
  startScheduler();

  // Sem teto de tentativas de propósito: um conflito de token é transitório
  // por natureza (a outra instância cai, ou alguém a desliga) e o processo
  // sendo ÚTIL enquanto espera é melhor que ele morrer. Cada tentativa é
  // logada, então o problema fica visível em `pm2 logs` e no /status.
  for (;;) {
    try {
      await bot.start({ onStart: (info) => console.log(`Bot @${info.username} rodando.`) });
      return; // start() só retorna quando o bot é parado de propósito
    } catch (err) {
      if (!isConflictError(err)) throw err; // erro de verdade (token inválido, rede): deixa subir
      console.error(
        `[main] outra instância está usando este token do bot (409). Nova tentativa em ${CONFLICT_RETRY_DELAY_MS / 1000}s — o ciclo automático segue rodando.`
      );
      await sleep(CONFLICT_RETRY_DELAY_MS);
    }
  }
}

main().catch((err) => {
  console.error("Falha ao iniciar o bot:", err);
  process.exit(1);
});

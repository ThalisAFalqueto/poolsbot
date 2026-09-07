import { Bot } from "grammy";
import { env } from "../config/env.js";
import { startCommand } from "./commands/start.js";
import { sitesCommand } from "./commands/sites.js";
import { watchCommand } from "./commands/watch.js";
import { unwatchCommand } from "./commands/unwatch.js";
import { yieldCommand } from "./commands/yield.js";
import { addWalletCommand } from "./commands/addwallet.js";
import { walletsCommand } from "./commands/wallets.js";
import { removeWalletCommand } from "./commands/removewallet.js";
import { positionsCommand } from "./commands/positions.js";
import { statusCommand } from "./commands/status.js";
import { rangeCommand } from "./commands/range.js";
import { graphCommand } from "./commands/graph.js";
import { labelPositionCommand } from "./commands/labelposition.js";
import { closedCommand } from "./commands/closed.js";
import { resultadoHandler } from "./commands/resultado.js";
import { compararCommand } from "./commands/comparar.js";
import { explicacoesCommand } from "./commands/explicacoes.js";
import { fecharCommand, fechamentosCommand } from "./commands/fechar.js";
import { bordaAlertaCommand } from "./commands/bordaalerta.js";

export function createBot(): Bot {
  const bot = new Bot(env.telegramBotToken);

  bot.command("start", startCommand);
  bot.command("sites", sitesCommand);
  bot.command("watch", watchCommand);
  bot.command("unwatch", unwatchCommand);
  bot.command("yield", yieldCommand);
  bot.command("addwallet", addWalletCommand);
  bot.command("wallets", walletsCommand);
  bot.command("removewallet", removeWalletCommand);
  bot.command("positions", positionsCommand);
  bot.command("status", statusCommand);
  bot.command("range", rangeCommand);
  bot.command("graph", graphCommand);
  bot.command("labelposition", labelPositionCommand);
  bot.command("closed", closedCommand);
  bot.command("dia", resultadoHandler("dia"));
  bot.command("semana", resultadoHandler("semana"));
  bot.command("mes", resultadoHandler("mes"));
  bot.command("comparar", compararCommand);
  bot.command("explicacoes", explicacoesCommand);
  bot.command("fechar", fecharCommand);
  bot.command("fechamentos", fechamentosCommand);
  bot.command("bordaalerta", bordaAlertaCommand);

  bot.catch((err) => {
    console.error("Erro não tratado no bot:", err.error);
  });

  return bot;
}

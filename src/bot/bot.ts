import { Bot } from "grammy";
import { env } from "../config/env.js";
import { startCommand } from "./commands/start.js";
import { poolCommand } from "./commands/pool.js";
import { findCommand } from "./commands/find.js";
import { watchCommand } from "./commands/watch.js";
import { unwatchCommand } from "./commands/unwatch.js";
import { alertsCommand } from "./commands/alerts.js";
import { unalertCommand } from "./commands/unalert.js";
import { yieldCommand } from "./commands/yield.js";
import { addWalletCommand } from "./commands/addwallet.js";
import { walletsCommand } from "./commands/wallets.js";
import { removeWalletCommand } from "./commands/removewallet.js";
import { positionsCommand } from "./commands/positions.js";

export function createBot(): Bot {
  const bot = new Bot(env.telegramBotToken);

  bot.command("start", startCommand);
  bot.command("pool", poolCommand);
  bot.command("find", findCommand);
  bot.command("watch", watchCommand);
  bot.command("unwatch", unwatchCommand);
  bot.command("alerts", alertsCommand);
  bot.command("unalert", unalertCommand);
  bot.command("yield", yieldCommand);
  bot.command("addwallet", addWalletCommand);
  bot.command("wallets", walletsCommand);
  bot.command("removewallet", removeWalletCommand);
  bot.command("positions", positionsCommand);

  bot.catch((err) => {
    console.error("Erro não tratado no bot:", err.error);
  });

  return bot;
}

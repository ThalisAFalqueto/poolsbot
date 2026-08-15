import { Bot } from "grammy";
import { env } from "../config/env.js";
import { startCommand } from "./commands/start.js";
import { poolCommand } from "./commands/pool.js";
import { findCommand } from "./commands/find.js";

export function createBot(): Bot {
  const bot = new Bot(env.telegramBotToken);

  bot.command("start", startCommand);
  bot.command("pool", poolCommand);
  bot.command("find", findCommand);

  bot.catch((err) => {
    console.error("Erro não tratado no bot:", err.error);
  });

  return bot;
}

import { Api } from "grammy";
import { env } from "../../config/env.js";
import type { NotificationChannel } from "../notification.interface.js";

// Instanciado standalone (sem depender da instância Bot em polling), pra
// desacoplar notificações do ciclo de vida do bot e facilitar testes.
const api = new Api(env.telegramBotToken);

export const telegramChannel: NotificationChannel = {
  // parse_mode "HTML" existe pro bloco <pre> da tabela do /comparar: o
  // Telegram só usa fonte monoespaçada dentro dele, e sem isso qualquer
  // alinhamento por espaços vira uma coluna torta na tela do celular.
  async send(chatId, text, options) {
    await api.sendMessage(chatId, text, options?.parseMode ? { parse_mode: options.parseMode } : undefined);
  },
};

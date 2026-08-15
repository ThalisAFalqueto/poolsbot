import { Api } from "grammy";
import { env } from "../../config/env.js";
import type { NotificationChannel } from "../notification.interface.js";

// Instanciado standalone (sem depender da instância Bot em polling), pra
// desacoplar notificações do ciclo de vida do bot e facilitar testes.
const api = new Api(env.telegramBotToken);

export const telegramChannel: NotificationChannel = {
  async send(chatId, text) {
    await api.sendMessage(chatId, text);
  },
};

export type SendOptions = { parseMode?: "HTML" };

export type NotificationChannel = {
  send(chatId: string, text: string, options?: SendOptions): Promise<void>;
};

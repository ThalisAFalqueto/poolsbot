export type NotificationChannel = {
  send(chatId: string, text: string): Promise<void>;
};

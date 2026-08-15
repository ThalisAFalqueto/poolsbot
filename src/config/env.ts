import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  arbitrumRpcUrl: required("ARBITRUM_RPC_URL"),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
};

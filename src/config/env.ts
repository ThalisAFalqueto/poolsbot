import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  arbitrumRpcUrl: required("ARBITRUM_RPC_URL"),
  baseRpcUrl: optional("BASE_RPC_URL"),
  optimismRpcUrl: optional("OPTIMISM_RPC_URL"),
  polygonRpcUrl: optional("POLYGON_RPC_URL"),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
};

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
  duneApiKey: optional("DUNE_API_KEY"),
  databaseUrl: required("DATABASE_URL"),

  // FECHAMENTO AUTOMÁTICO — as duas OPCIONAIS de propósito. Sem elas, o job
  // check-close-triggers não arma nada e o bot segue 100% somente-leitura, que
  // é a postura padrão do projeto.
  //
  // Esta é a ÚNICA chave privada que o bot toca. Ela não deve ter fundos além
  // do gas, e não consegue mover valor: o CloseOnlyController manda tudo pro
  // dono da posição, lido do NFT na hora (ver contracts/src/CloseOnlyController.sol).
  // O pior caso de um vazamento é alguém fechar posições na hora errada —
  // prejuízo possível, roubo não. O botão de pânico é revogar
  // setApprovalForAll no NonfungiblePositionManager, que é uma chamada ERC-721
  // padrão e não depende do contrato cooperar.
  closeAutomationPrivateKey: optional("CLOSE_AUTOMATION_PRIVATE_KEY"),
  closeControllerArbitrum: optional("CLOSE_CONTROLLER_ARBITRUM"),
};

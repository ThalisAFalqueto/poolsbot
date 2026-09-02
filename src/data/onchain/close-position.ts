import { createWalletClient, http, parseAbi, getAddress, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chains, type ChainKey } from "../../config/chains.js";
import { env } from "../../config/env.js";
import { getPublicClient } from "./client.js";

// A ÚNICA escrita on-chain do projeto inteiro. Todo o resto do bot lê.
//
// Chama `close()` no CloseOnlyController, que remove a liquidez e manda tudo
// pro dono da posição. O contrato não tem código de mint: o bot não consegue
// abrir posição nem que queira, e isso é garantia estrutural, não configuração.
// Ver contracts/src/CloseOnlyController.sol.
//
// DESLIGADO POR PADRÃO. Sem CLOSE_AUTOMATION_PRIVATE_KEY e o endereço do
// controller da chain, `closeAvailableOn` devolve false e o job nem tenta.

const controllerAbi = parseAbi([
  "function close(uint256 tokenId, uint256 deadline) returns (uint256 amount0, uint256 amount1)",
  "function automationKeyOf(address user) view returns (address)",
  "function paused(address user) view returns (bool)",
]);

/** Margem do deadline da transação. Curto de propósito: se ela ficar pendurada
 *  no mempool por mais que isso, o preço que motivou o fechamento já não é o
 *  mesmo, e é melhor a transação morrer do que executar num mundo diferente. */
const DEADLINE_SECONDS = 300;

function controllerAddress(chainKey: ChainKey): Address | null {
  // Só a Arbitrum por enquanto — o contrato precisa ser deployado por chain, e
  // endereço não entra aqui sem conferência. Mesma disciplina de chains.ts.
  const raw = chainKey === "arbitrum" ? env.closeControllerArbitrum : undefined;
  if (!raw) return null;
  try {
    return getAddress(raw);
  } catch {
    console.error(`[close-position] CLOSE_CONTROLLER_${chainKey.toUpperCase()} não é um endereço válido`);
    return null;
  }
}

/** O fechamento automático está configurado nesta chain? */
export function closeAvailableOn(chainKey: ChainKey): boolean {
  return Boolean(env.closeAutomationPrivateKey) && controllerAddress(chainKey) !== null;
}

/** Endereço da chave de automação, pra mostrar ao usuário na hora de ele
 *  autorizar. Null quando não configurada. */
export function automationAddress(): Address | null {
  if (!env.closeAutomationPrivateKey) return null;
  try {
    return privateKeyToAccount(env.closeAutomationPrivateKey as `0x${string}`).address;
  } catch {
    return null;
  }
}

export function controllerAddressFor(chainKey: ChainKey): Address | null {
  return controllerAddress(chainKey);
}

export type CloseReadiness =
  | { ready: true }
  | { ready: false; reason: string };

/**
 * Confere, ANTES de gastar gas, se este contrato consegue fechar a posição
 * desta wallet. Cada motivo aqui é uma trava que o usuário controla, e dizer
 * qual delas está fechada é mais útil que uma transação revertida.
 */
export async function checkCloseReadiness(chainKey: ChainKey, owner: Address): Promise<CloseReadiness> {
  const controller = controllerAddress(chainKey);
  const automation = automationAddress();
  if (!controller || !automation) return { ready: false, reason: "fechamento automático não está configurado nesta chain" };

  const client = getPublicClient(chainKey);
  const npmAbi = parseAbi(["function isApprovedForAll(address owner, address operator) view returns (bool)"]);

  try {
    const [aprovado, chave, pausado] = await Promise.all([
      client.readContract({
        address: chains[chainKey].uniswapV3.nonfungiblePositionManager,
        abi: npmAbi,
        functionName: "isApprovedForAll",
        args: [owner, controller],
      }),
      client.readContract({ address: controller, abi: controllerAbi, functionName: "automationKeyOf", args: [owner] }),
      client.readContract({ address: controller, abi: controllerAbi, functionName: "paused", args: [owner] }),
    ]);

    if (!aprovado) return { ready: false, reason: `sua wallet ainda não aprovou o controller ${controller} (setApprovalForAll no NonfungiblePositionManager)` };
    if (chave.toLowerCase() !== automation.toLowerCase()) {
      return { ready: false, reason: `a chave de automação registrada no contrato (${chave}) não é a que o bot usa (${automation}) — chame setAutomationKey` };
    }
    if (pausado) return { ready: false, reason: "sua automação está PAUSADA no contrato (setPaused)" };
    return { ready: true };
  } catch (err) {
    console.error("[close-position] falha ao checar prontidão:", err);
    return { ready: false, reason: "não consegui ler o estado do contrato agora" };
  }
}

export type CloseResult = { ok: true; txHash: Hash } | { ok: false; error: string };

/**
 * Fecha a posição. Simula ANTES de enviar: uma simulação que reverte custa
 * zero, uma transação que reverte custa gas e não fecha nada — e as revert
 * reasons do contrato (UserPaused, PriceDeviationTooHigh, ...) são
 * informativas o bastante pra valer o round-trip.
 */
export async function closePosition(chainKey: ChainKey, tokenId: string): Promise<CloseResult> {
  const controller = controllerAddress(chainKey);
  if (!controller || !env.closeAutomationPrivateKey) return { ok: false, error: "fechamento automático não configurado" };

  const def = chains[chainKey];
  if (!def.rpcUrl) return { ok: false, error: `chain ${chainKey} sem RPC` };

  const account = privateKeyToAccount(env.closeAutomationPrivateKey as `0x${string}`);
  const publicClient = getPublicClient(chainKey);
  const wallet = createWalletClient({ account, chain: def.viemChain, transport: http(def.rpcUrl) });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

  try {
    const { request } = await publicClient.simulateContract({
      address: controller,
      abi: controllerAbi,
      functionName: "close",
      args: [BigInt(tokenId), deadline],
      account,
    });
    const txHash = await wallet.writeContract(request);
    // Espera a confirmação: sem isso, "fechei" viraria "mandei e não sei o que
    // aconteceu", e o gatilho seria desarmado com base em nada.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return { ok: false, error: `transação ${txHash} reverteu na chain` };
    return { ok: true, txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ok: false, error: msg ?? "erro desconhecido" };
  }
}

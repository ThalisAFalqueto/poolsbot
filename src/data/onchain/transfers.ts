import type { Address, Hash } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import { getPublicClient } from "./client.js";

// Detecção de ENTRADA e SAÍDA de capital da carteira — o que separa "lucro"
// de "você depositou mais dinheiro". Sem isso o NAV mente: aportar 100 USDC
// apareceria como 100 USDC de lucro.
//
// A regra, validada ao vivo contra as transferências reais do usuário
// (26/08/2026), separou corretamente os 2 aportes de exchange das 5
// operações próprias:
//
//   ENTRADA  → é depósito se a transação NÃO foi assinada pela carteira.
//              Quando a Binance te manda USDC, quem assina é a Binance. Um
//              swap também faz token "chegar", mas aí quem assinou foi você.
//   SAÍDA    → é saque se o destino é um endereço SEM código (carteira
//              comum). Pool e router são contratos; endereço de depósito de
//              exchange normalmente não é.
//
// A regra de saída ainda NÃO tem exemplo real pra validar (o usuário nunca
// sacou) — é a parte mais frágil daqui. Se um dia um saque for classificado
// errado, é o primeiro lugar pra olhar.

export type RawTransfer = {
  uniqueId: string; // id da Alchemy — chave natural de dedup
  hash: Hash;
  from: string;
  to: string;
  asset: string;
  amount: number;
  tokenAddress: string | null; // null = token nativo da chain
  occurredAt: Date;
};

export type ClassifiedFlow = RawTransfer & { direction: "deposit" | "withdrawal" };

type AlchemyTransfer = {
  uniqueId: string;
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  rawContract: { address: string | null };
  metadata: { blockTimestamp: string };
};

async function alchemyGetAssetTransfers(
  chainKey: ChainKey,
  params: Record<string, unknown>
): Promise<AlchemyTransfer[]> {
  const rpcUrl = chains[chainKey].rpcUrl;
  if (!rpcUrl) return [];

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{ category: ["external", "erc20"], withMetadata: true, maxCount: "0x3e8", ...params }],
    }),
  });
  if (!res.ok) throw new Error(`alchemy_getAssetTransfers falhou: ${res.status} ${res.statusText}`);

  const json = (await res.json()) as { result?: { transfers?: AlchemyTransfer[] }; error?: { message: string } };
  if (json.error) throw new Error(`alchemy_getAssetTransfers: ${json.error.message}`);
  return json.result?.transfers ?? [];
}

function toRawTransfer(t: AlchemyTransfer): RawTransfer | null {
  if (t.value === null || t.to === null || !t.asset) return null;
  return {
    uniqueId: t.uniqueId,
    hash: t.hash as Hash,
    from: t.from.toLowerCase(),
    to: t.to.toLowerCase(),
    asset: t.asset,
    amount: t.value,
    tokenAddress: t.rawContract.address?.toLowerCase() ?? null,
    occurredAt: new Date(t.metadata.blockTimestamp),
  };
}

// Sempre varre do bloco 0, mas em ordem DECRESCENTE e com teto de 1000 por
// direção. Parece contraintuitivo — o natural seria guardar uma marca d'água
// e ler só o que é novo. A ordem decrescente é mais robusta justamente por
// não depender disso: a gravação já é idempotente (dedup por `uniqueId`), e
// pegar "as 1000 mais RECENTES" garante que nada novo se perde nem que uma
// marca d'água errada crie um buraco silencioso. O teto só seria atingido se
// a carteira fizesse mais de 1000 transferências entre duas execuções
// diárias, o que não acontece numa carteira de uso pessoal.
export async function fetchTransfers(
  chainKey: ChainKey,
  wallet: Address
): Promise<{ incoming: RawTransfer[]; outgoing: RawTransfer[] }> {
  const [incomingRaw, outgoingRaw] = await Promise.all([
    alchemyGetAssetTransfers(chainKey, { fromBlock: "0x0", toBlock: "latest", toAddress: wallet, order: "desc" }),
    alchemyGetAssetTransfers(chainKey, { fromBlock: "0x0", toBlock: "latest", fromAddress: wallet, order: "desc" }),
  ]);
  const clean = (list: AlchemyTransfer[]) => list.map(toRawTransfer).filter((t): t is RawTransfer => t !== null);
  return { incoming: clean(incomingRaw), outgoing: clean(outgoingRaw) };
}

// Classifica o que é dinheiro NOVO entrando/saindo. Faz 2 tipos de chamada
// extra, ambas cacheadas por hash/endereço: quem assinou a transação
// (entradas) e se o destino tem código (saídas). Como depósito e saque são
// raros, na prática isso é quase sempre zero chamada.
export async function classifyCashFlows(
  chainKey: ChainKey,
  wallet: Address,
  transfers: { incoming: RawTransfer[]; outgoing: RawTransfer[] }
): Promise<ClassifiedFlow[]> {
  const publicClient = getPublicClient(chainKey);
  const walletLower = wallet.toLowerCase();
  const flows: ClassifiedFlow[] = [];

  const signerByHash = new Map<string, string>();
  for (const t of transfers.incoming) {
    let signer = signerByHash.get(t.hash);
    if (signer === undefined) {
      const tx = await publicClient.getTransaction({ hash: t.hash });
      signer = tx.from.toLowerCase();
      signerByHash.set(t.hash, signer);
    }
    // Assinada por terceiro = alguém te MANDOU dinheiro. Assinada por você =
    // resultado de operação sua (swap, retirada de pool), não capital novo.
    if (signer !== walletLower) flows.push({ ...t, direction: "deposit" });
  }

  const isContractByAddress = new Map<string, boolean>();
  for (const t of transfers.outgoing) {
    let isContract = isContractByAddress.get(t.to);
    if (isContract === undefined) {
      const code = await publicClient.getCode({ address: t.to as Address });
      isContract = code !== undefined && code !== "0x";
      isContractByAddress.set(t.to, isContract);
    }
    // Destino é contrato (pool, router) = você está operando, não sacando.
    if (!isContract) flows.push({ ...t, direction: "withdrawal" });
  }

  return flows;
}

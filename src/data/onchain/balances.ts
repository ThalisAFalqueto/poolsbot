import type { Address } from "viem";
import type { ChainKey } from "../../config/chains.js";
import { erc20Abi } from "./abis.js";
import { getPublicClient } from "./client.js";

// Saldos da carteira — token nativo + ERC-20. Até o NAV existir, o bot lia
// SÓ posições de LP e nunca quanto de token solto a wallet tinha; por isso
// isso não estava em client.ts (que é todo sobre posições).
//
// Quem chama passa a lista de tokens a consultar — nunca "descobre" tokens
// varrendo a carteira. É de propósito: airdrop de scam é comum na Arbitrum, e
// um token falso entraria no patrimônio com preço inventado. Ver
// domain/portfolio/token-allowlist.ts pra origem da lista.

export type TokenBalance = { address: Address; symbol: string; decimals: number; amount: number };
export type WalletBalances = { native: number; tokens: TokenBalance[] };

export async function fetchWalletBalances(chainKey: ChainKey, owner: Address, tokens: Address[]): Promise<WalletBalances> {
  const publicClient = getPublicClient(chainKey);

  const nativeWei = await publicClient.getBalance({ address: owner });
  const native = Number(nativeWei) / 1e18;

  if (tokens.length === 0) return { native, tokens: [] };

  // 3 chamadas por token (saldo/decimais/símbolo) numa multicall só — a
  // alternativa (3 round-trips por token) ficaria lenta com a carteira
  // crescendo, e isso roda 1x/dia no snapshot.
  const results = await publicClient.multicall({
    contracts: tokens.flatMap(
      (address) =>
        [
          { address, abi: erc20Abi, functionName: "balanceOf", args: [owner] } as const,
          { address, abi: erc20Abi, functionName: "decimals" } as const,
          { address, abi: erc20Abi, functionName: "symbol" } as const,
        ] as const
    ),
    allowFailure: true,
  });

  const balances: TokenBalance[] = [];
  tokens.forEach((address, i) => {
    const balance = results[i * 3];
    const decimals = results[i * 3 + 1];
    const symbol = results[i * 3 + 2];
    // Token que falhou em qualquer uma das 3 leituras fica de FORA em vez de
    // entrar com zero: zero seria indistinguível de "não tenho esse token" e
    // subestimaria o patrimônio silenciosamente.
    if (balance?.status !== "success" || decimals?.status !== "success" || symbol?.status !== "success") {
      console.error(`[balances] falha ao ler ${address} em ${chainKey}`);
      return;
    }
    const d = decimals.result as number;
    balances.push({
      address,
      symbol: symbol.result as string,
      decimals: d,
      amount: Number(balance.result as bigint) / 10 ** d,
    });
  });

  return { native, tokens: balances };
}

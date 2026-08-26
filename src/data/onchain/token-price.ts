import type { Address } from "viem";
import { chains, type ChainKey } from "../../config/chains.js";
import { sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { isStablecoinSymbol } from "../../domain/lp-rebalance/stablecoins.js";
import { getPoolInfo } from "./client.js";

// Preço de um token em USDC, lido de pool Uniswap V3 on-chain.
//
// ATENÇÃO — isto abre uma exceção deliberada a uma postura do projeto.
// `buildPortfolioSummary` (bot/commands/positions.ts) se recusa a somar
// valores de moedas diferentes, porque isso exigiria um oráculo de preço em
// USD que o projeto não usa. O NAV (patrimônio total da carteira) precisa
// exatamente dessa soma, então a exceção é consciente e limitada:
//
//   - a conversão NÃO usa oráculo externo: sai do preço de um pool Uniswap,
//     mesma técnica que `closed.ts` já usava pra rotular custo de gas;
//   - a unidade é USDC-o-TOKEN, não "dólar" — se o USDC desancorar, o número
//     acompanha, e isso é uma limitação real, não um detalhe;
//   - é preço à VISTA, do instante da consulta. Bom pra fotografar patrimônio,
//     inadequado pra qualquer decisão de execução.
//
// Generaliza o `findEthPriceInToken1` que era privado de `closed.ts` e só
// sabia converter WETH -> stablecoin.

// Os 4 fee tiers padrão do V3. `closed.ts` usava só 3 (omitia o 0.01%, que é
// justamente o mais líquido em pares stable-stable) — aqui entra completo,
// do mais provável de ter liquidez pro menos, já que a busca para no
// primeiro pool encontrado.
const FEE_TIERS = [500, 3000, 10000, 100];

export type TokenPriceResolver = (token: Address, symbol: string) => Promise<number | null>;

async function findPriceViaPool(chainKey: ChainKey, token: Address, usdc: Address): Promise<number | null> {
  for (const fee of FEE_TIERS) {
    const pool = await getPoolInfo(chainKey, token, usdc, fee);
    if (!pool) continue;
    const price = sqrtPriceX96ToPrice(pool.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals);
    // getPoolInfo devolve token0/token1 na ordem CANÔNICA (por endereço), que
    // não é necessariamente a ordem em que foram pedidos — o preço sai
    // invertido dependendo de qual lado o USDC caiu.
    if (pool.token1.address.toLowerCase() === usdc.toLowerCase()) return price; // já é USDC por token
    if (pool.token0.address.toLowerCase() === usdc.toLowerCase()) return price > 0 ? 1 / price : null;
  }
  return null;
}

// Cria um resolver com cache por (chain, token) — várias posições e saldos
// costumam compartilhar os mesmos tokens num mesmo snapshot, e cada resolução
// custa até 4 chamadas de RPC. O cache guarda a Promise, não o valor, pra
// duas resoluções simultâneas do mesmo token não dispararem buscas paralelas.
export function createTokenPriceResolver(chainKey: ChainKey): TokenPriceResolver {
  const usdc = chains[chainKey].usdcAddress;
  const cache = new Map<string, Promise<number | null>>();

  return (token: Address, symbol: string): Promise<number | null> => {
    if (!usdc) return Promise.resolve(null); // chain sem USDC configurado: NAV não roda nela
    if (token.toLowerCase() === usdc.toLowerCase()) return Promise.resolve(1);
    // Stablecoin reconhecida vale 1 sem consultar pool. É aproximação
    // assumida (ignora desvio de âncora), consistente com o resto do projeto,
    // que já trata stablecoin por símbolo em vez de preço (ver stablecoins.ts).
    if (isStablecoinSymbol(symbol)) return Promise.resolve(1);

    const key = token.toLowerCase();
    let pending = cache.get(key);
    if (!pending) {
      pending = findPriceViaPool(chainKey, token, usdc).catch((err) => {
        console.error(`[token-price] falha ao resolver preço de ${symbol} (${token}) em ${chainKey}:`, err);
        return null;
      });
      cache.set(key, pending);
    }
    return pending;
  };
}

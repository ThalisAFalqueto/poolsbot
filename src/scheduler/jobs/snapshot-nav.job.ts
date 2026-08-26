import type { Address } from "viem";
import { chains, getActiveChains, type ChainKey } from "../../config/chains.js";
import { fetchWalletBalances } from "../../data/onchain/balances.js";
import { fetchPositionsForWallets, fetchUncollectedFees } from "../../data/onchain/client.js";
import { fetchV4UncollectedFees } from "../../data/onchain/client-v4.js";
import { createTokenPriceResolver, type TokenPriceResolver } from "../../data/onchain/token-price.js";
import { classifyCashFlows, fetchTransfers } from "../../data/onchain/transfers.js";
import { getAmountsForLiquidity } from "../../domain/lp-rebalance/liquidity-math.js";
import type { OnchainPosition } from "../../domain/lp-rebalance/types.js";
import { composeNav, type ValuedHolding } from "../../domain/portfolio/nav.js";
import { buildTokenAllowlist, isAllowedToken } from "../../domain/portfolio/token-allowlist.js";
import { listKnownTokenAddresses, listUserWallets } from "../../persistence/repositories/lp-positions.repository.js";
import {
  hasSnapshotForDate,
  insertCashFlows,
  insertNavSnapshots,
  type CashFlowInput,
  type NavSnapshotInput,
} from "../../persistence/repositories/wallet-nav.repository.js";

// Fotografia diária do patrimônio (NAV) + detecção de aportes/saques — base
// do /mes. Ver o comentário das tabelas em persistence/schema/index.ts pro
// porquê do método (diferença de patrimônio em vez de soma de componentes).
//
// Roda dentro do ciclo de 15min como os outros jobs, mas SAI CEDO se já
// existe foto de hoje: assim o custo de RPC acontece 1x/dia, não 96x. Mesmo
// padrão de dedup diário de pool_volume_history.

/** Data em UTC (YYYY-MM-DD) — fronteira de mês do /mes é UTC, não local. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function valuePositions(
  chain: ChainKey,
  positions: OnchainPosition[],
  resolvePrice: TokenPriceResolver
): Promise<{ positionsUsdc: number; feesUsdc: number } | null> {
  if (positions.length === 0) return { positionsUsdc: 0, feesUsdc: 0 };

  // Fees vêm por caminhos diferentes em V3 (simula collect()) e V4 (leitura
  // pura no StateView) — mesma divisão já feita no /positions.
  const v3ByWallet = new Map<Address, OnchainPosition[]>();
  for (const p of positions) {
    if (p.protocol !== "v3") continue;
    v3ByWallet.set(p.walletAddress, [...(v3ByWallet.get(p.walletAddress) ?? []), p]);
  }
  const [v3FeeMaps, v4Fees] = await Promise.all([
    Promise.all([...v3ByWallet.entries()].map(([wallet, ps]) => fetchUncollectedFees(chain, wallet, ps))),
    fetchV4UncollectedFees(chain, positions),
  ]);
  const fees = new Map([...v3FeeMaps.flatMap((m) => [...m.entries()]), ...v4Fees.entries()]);

  let positionsUsdc = 0;
  let feesUsdc = 0;
  for (const p of positions) {
    // Cada lado é convertido pro seu próprio preço em USDC, em vez de assumir
    // que token1 é a moeda de conta. Sem isso, um par que não envolve USDC
    // (ex: WBTC/WETH) entraria no patrimônio com a unidade errada.
    const [price0, price1] = await Promise.all([
      resolvePrice(p.token0.address, p.token0.symbol),
      resolvePrice(p.token1.address, p.token1.symbol),
    ]);
    if (price0 === null || price1 === null) {
      console.error(`[snapshot-nav] sem preço pra ${p.token0.symbol}/${p.token1.symbol} em ${chain}, abortando foto`);
      return null; // melhor não gravar do que gravar patrimônio incompleto
    }

    const { amount0, amount1 } = getAmountsForLiquidity({
      liquidity: p.liquidity,
      sqrtPriceX96: p.sqrtPriceX96,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      decimals0: p.token0.decimals,
      decimals1: p.token1.decimals,
    });
    positionsUsdc += amount0 * price0 + amount1 * price1;

    const f = fees.get(p.tokenId.toString());
    if (f) {
      feesUsdc +=
        (Number(f.amount0) / 10 ** p.token0.decimals) * price0 + (Number(f.amount1) / 10 ** p.token1.decimals) * price1;
    }
  }

  return { positionsUsdc, feesUsdc };
}

async function snapshotWallet(
  userId: number,
  chain: ChainKey,
  wallet: Address,
  date: string,
  resolvePrice: TokenPriceResolver
): Promise<NavSnapshotInput | null> {
  const allowlist = buildTokenAllowlist({
    positionTokens: await listKnownTokenAddresses(userId, chain),
    referenceTokens: [chains[chain].usdcAddress, chains[chain].wethAddress, ...chains[chain].trustedTokens],
  });

  const balances = await fetchWalletBalances(chain, wallet, [...allowlist] as Address[]);

  const idle: ValuedHolding[] = [];
  // Token nativo (ETH) — é a reserva de gas. O usuário decidiu que ela conta
  // no patrimônio: segurar gas faz parte da estratégia.
  const nativePrice = await resolvePrice(chains[chain].wethAddress as Address, chains[chain].nativeGasSymbol);
  if (nativePrice === null) {
    console.error(`[snapshot-nav] sem preço pro token nativo em ${chain}, abortando foto`);
    return null;
  }
  idle.push({ symbol: chains[chain].nativeGasSymbol, amount: balances.native, priceUsdc: nativePrice });

  for (const t of balances.tokens) {
    if (t.amount === 0) continue;
    if (!isAllowedToken(allowlist, t.address)) continue; // defesa dupla: já filtrado na consulta
    const price = await resolvePrice(t.address, t.symbol);
    if (price === null) {
      console.error(`[snapshot-nav] sem preço pra ${t.symbol} em ${chain}, abortando foto`);
      return null;
    }
    idle.push({ symbol: t.symbol, amount: t.amount, priceUsdc: price });
  }

  const perChain = await fetchPositionsForWallets([wallet], [chain]);
  const positions = perChain.flatMap((c) => c.positions);
  const valued = await valuePositions(chain, positions, resolvePrice);
  if (!valued) return null;

  const nav = composeNav({ idle, positionsUsdc: valued.positionsUsdc, feesUsdc: valued.feesUsdc });
  return {
    userId,
    walletAddress: wallet,
    chain,
    date,
    navUsdc: nav.navUsdc,
    idleUsdc: nav.idleUsdc,
    positionsUsdc: nav.positionsUsdc,
    feesUsdc: nav.feesUsdc,
  };
}

async function detectCashFlows(
  userId: number,
  chain: ChainKey,
  wallet: Address,
  allowlist: Set<string>,
  resolvePrice: TokenPriceResolver
): Promise<CashFlowInput[]> {
  const transfers = await fetchTransfers(chain, wallet);
  const flows = await classifyCashFlows(chain, wallet, transfers);

  const rows: CashFlowInput[] = [];
  for (const f of flows) {
    // tokenAddress null = token nativo (ETH), sempre aceito. Qualquer ERC-20
    // fora da allowlist é IGNORADO — airdrop de scam chega exatamente como um
    // depósito legítimo (transferência assinada por terceiro), e sem este
    // filtro entraria como aporte, sujando o P&L do mês.
    // O teste fica inline (e não numa variável isNative) porque é ele que faz
    // o compilador estreitar tokenAddress de `string | null` pra `string`.
    if (f.tokenAddress !== null && !isAllowedToken(allowlist, f.tokenAddress)) continue;

    // Token nativo é precificado pelo WETH (mesma moeda, versão embrulhada).
    const priceToken = f.tokenAddress === null ? (chains[chain].wethAddress as Address) : (f.tokenAddress as Address);
    const price = await resolvePrice(priceToken, f.asset);
    if (price === null) {
      console.warn(`[snapshot-nav] fluxo de ${f.asset} ignorado: sem preço`);
      continue;
    }

    rows.push({
      userId,
      walletAddress: wallet,
      chain,
      uniqueId: f.uniqueId,
      direction: f.direction,
      asset: f.asset,
      amount: f.amount,
      valueUsdc: f.amount * price,
      txHash: f.hash,
      occurredAt: f.occurredAt,
    });
  }
  return rows;
}

export async function snapshotNavJob(): Promise<string> {
  const walletRows = await listUserWallets();
  if (walletRows.length === 0) return "nenhuma wallet vinculada.";

  const date = utcDate(new Date());
  // Só chains com USDC confirmado on-chain participam (ver chains.ts) — sem
  // moeda de conta não há como medir patrimônio.
  const activeChains = getActiveChains().filter((c) => chains[c].usdcAddress !== undefined);
  if (activeChains.length === 0) return "nenhuma chain com USDC configurado.";

  const byUser = new Map<number, Address[]>();
  for (const row of walletRows) {
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.address as Address]);
  }

  let snapshotCount = 0;
  let flowCount = 0;
  let skipped = 0;

  for (const [userId, wallets] of byUser) {
    if (await hasSnapshotForDate(userId, date)) {
      skipped += 1;
      continue; // já fotografado hoje — não gasta RPC
    }

    for (const chain of activeChains) {
      const resolvePrice = createTokenPriceResolver(chain);
      try {
        const snapshots: NavSnapshotInput[] = [];
        for (const wallet of wallets) {
          const snapshot = await snapshotWallet(userId, chain, wallet, date, resolvePrice);
          if (snapshot) snapshots.push(snapshot);
        }
        await insertNavSnapshots(snapshots);
        snapshotCount += snapshots.length;

        for (const wallet of wallets) {
          const allowlist = buildTokenAllowlist({
            positionTokens: await listKnownTokenAddresses(userId, chain),
            referenceTokens: [chains[chain].usdcAddress, chains[chain].wethAddress, ...chains[chain].trustedTokens],
          });
          const flows = await detectCashFlows(userId, chain, wallet, allowlist, resolvePrice);
          await insertCashFlows(flows);
          flowCount += flows.length;
        }
      } catch (err) {
        // Falha numa chain não pode derrubar as outras nem os outros usuários
        // — mesmo isolamento do check-positions.
        console.error(`[snapshot-nav] falha em ${chain} pro usuário ${userId}:`, err);
      }
    }
  }

  const summary =
    skipped > 0 && snapshotCount === 0
      ? `foto de hoje (${date}) já existia, nada a fazer.`
      : `${snapshotCount} foto(s) de patrimônio em ${date}, ${flowCount} fluxo(s) de caixa conhecidos.`;
  console.log(`[snapshot-nav] ${summary}`);
  return summary;
}

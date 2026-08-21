import { InputFile, type CommandContext, type Context } from "grammy";
import type { Address } from "viem";
import { getActiveChains } from "../../config/chains.js";
import { fetchPositionsForWallets } from "../../data/onchain/client.js";
import { renderRangePlot } from "../../data/chart/plot-range.js";
import { sqrtPriceX96ToPrice, tickToPrice } from "../../domain/lp-rebalance/price-math.js";
import type { OnchainPosition } from "../../domain/lp-rebalance/types.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import { listWallets } from "../../persistence/repositories/user-wallets.repository.js";
import {
  findPositionByLabelOrTokenId,
  getIlBaseline,
  listPositionRefs,
  type PositionRef,
} from "../../persistence/repositories/lp-positions.repository.js";

async function resolvePositionRef(userId: number, identifier: string | undefined): Promise<PositionRef | { error: string }> {
  if (identifier) {
    const ref = await findPositionByLabelOrTokenId(userId, identifier);
    return ref ?? { error: `Não achei nenhuma posição com o nome/tokenId "${identifier}".` };
  }

  const refs = await listPositionRefs(userId);
  if (refs.length === 0) {
    return { error: "Você não tem nenhuma posição vinculada ainda. Use /addwallet primeiro." };
  }
  if (refs.length === 1) {
    return refs[0]!;
  }
  const list = refs.map((r) => `#${r.tokenId} (${r.chain})`).join(", ");
  return { error: `Você tem ${refs.length} posições — especifique qual: ${list}\nEx: /graph ${refs[0]!.tokenId}` };
}

export async function graphCommand(ctx: CommandContext<Context>) {
  const identifier = ctx.match?.toString().trim() || undefined;
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));

  const resolved = await resolvePositionRef(user.id, identifier);
  if ("error" in resolved) {
    await ctx.reply(resolved.error);
    return;
  }

  const wallets = await listWallets(user.id);
  if (wallets.length === 0) {
    await ctx.reply("Nenhuma wallet vinculada ainda. Use /addwallet primeiro.");
    return;
  }

  const activeChains = getActiveChains();
  const perChain = await fetchPositionsForWallets(
    wallets.map((w) => w.address as Address),
    activeChains
  );

  let position: OnchainPosition | undefined;
  for (const { chain, positions } of perChain) {
    if (chain !== resolved.chain) continue;
    position = positions.find((p) => p.tokenId.toString() === resolved.tokenId);
    if (position) break;
  }

  if (!position) {
    await ctx.reply(
      `Posição #${resolved.tokenId} não apareceu na leitura on-chain agora — pode ter sido fechada ou transferida. Confere com /positions.`
    );
    return;
  }

  const baseline = await getIlBaseline(resolved.id);
  const entry = baseline ? sqrtPriceX96ToPrice(baseline.sqrtPriceX96, position.token0.decimals, position.token1.decimals) : null;

  const low = tickToPrice(position.tickLower, position.token0.decimals, position.token1.decimals);
  const high = tickToPrice(position.tickUpper, position.token0.decimals, position.token1.decimals);
  const current = sqrtPriceX96ToPrice(position.sqrtPriceX96, position.token0.decimals, position.token1.decimals);
  const symbolPair = `${position.token1.symbol} por ${position.token0.symbol}`;

  try {
    const png = await renderRangePlot({ symbolPair, low, high, entry, current });
    await ctx.replyWithPhoto(new InputFile(png, "range.png"));
  } catch (err) {
    console.error("[graph] falha ao gerar imagem:", err);
    await ctx.reply("Não consegui gerar o gráfico agora (problema de configuração do lado do servidor) — tente de novo mais tarde.");
  }
}

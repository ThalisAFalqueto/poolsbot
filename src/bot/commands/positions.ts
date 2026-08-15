import type { CommandContext, Context } from "grammy";
import type { Address } from "viem";
import { fetchPositionsForWallet } from "../../data/onchain/client.js";
import { calculateImpermanentLoss } from "../../domain/lp-rebalance/calculate-il.js";
import { formatBoundaryPrice, formatPrice } from "../../domain/lp-rebalance/format-reason.js";
import { isInRange, sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";
import {
  syncIlBaseline,
  toPositionUpsertInput,
  upsertPositions,
} from "../../persistence/repositories/lp-positions.repository.js";

const CHAIN = "arbitrum";
const IL_DISCLAIMER =
  "* IL calculado desde que o poolsbot passou a monitorar cada posição (não é a abertura on-chain real) e não desconta fees ganhas.";

// Telegram limita mensagens a 4096 caracteres. Em vez de truncar e esconder
// posições (silenciosamente omitir uma que esteja fora de range seria um
// problema real, não só estético), a lista inteira é paginada em várias
// mensagens quando não cabe numa só.
const MAX_MESSAGE_CHARS = 3500;

function buildPositionLine(
  p: Awaited<ReturnType<typeof fetchPositionsForWallet>>[number],
  ilLine: string
): string {
  const inRange = isInRange(p.currentTick, p.tickLower, p.tickUpper);
  const low = formatBoundaryPrice(p.tickLower, p.token0.decimals, p.token1.decimals);
  const high = formatBoundaryPrice(p.tickUpper, p.token0.decimals, p.token1.decimals);
  const current = formatPrice(sqrtPriceX96ToPrice(p.sqrtPriceX96, p.token0.decimals, p.token1.decimals));
  const status = inRange ? "✅" : "🚨";
  const positionLine = `${status} ${p.token0.symbol}/${p.token1.symbol} ${(p.fee / 10000).toFixed(2)}% — faixa ${low}–${high}, atual ${current} ${p.token1.symbol} por ${p.token0.symbol} (#${p.tokenId})`;
  return `${positionLine}\n   ${ilLine}`;
}

function chunkLines(lines: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 pro "\n" de junção
    if (current.length > 0 && currentLen + lineLen > maxChars) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function positionsCommand(ctx: CommandContext<Context>) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  if (!user.walletAddress) {
    await ctx.reply("Nenhuma wallet vinculada ainda. Use /addwallet <endereço> primeiro.");
    return;
  }

  const positions = await fetchPositionsForWallet(user.walletAddress as Address);
  if (positions.length === 0) {
    await ctx.reply("Nenhuma posição de liquidez ativa encontrada nessa wallet em Arbitrum (Uniswap V3).");
    return;
  }

  // /positions continua "sempre fresco" pros dados exibidos (nunca lê a
  // lista de posições do banco) — mas grava identidade+baseline como efeito
  // colateral idempotente, resolvendo o caso de uma wallet nova que ainda
  // não passou pelo ciclo de 15min do scheduler. Não chama
  // deleteStalePositions aqui: reconciliação completa fica só no job, pra
  // evitar duas fontes de escrita concorrentes na mesma linha.
  const upserted = await upsertPositions(positions.map((p) => toPositionUpsertInput(user.id, CHAIN, p)));
  const upsertedByTokenId = new Map(upserted.map((u) => [u.tokenId, u]));

  // Fora de range primeiro — é o que precisa de atenção. Com paginação isso
  // já bastaria, mas também garante que a 1ª mensagem sempre traz o que
  // importa mesmo que o usuário não role até a última página.
  const sorted = [...positions].sort((a, b) => {
    const aOut = isInRange(a.currentTick, a.tickLower, a.tickUpper) ? 1 : 0;
    const bOut = isInRange(b.currentTick, b.tickLower, b.tickUpper) ? 1 : 0;
    return aOut - bOut;
  });

  const lines = await Promise.all(
    sorted.map(async (p) => {
      const record = upsertedByTokenId.get(p.tokenId.toString());
      if (!record) return buildPositionLine(p, "IL: indisponível (falha ao sincronizar posição)");

      const baseline = await syncIlBaseline(record.id, {
        liquidity: p.liquidity,
        sqrtPriceX96: p.sqrtPriceX96,
        tick: p.currentTick,
      });
      const il = calculateImpermanentLoss({
        liquidity: p.liquidity,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        decimals0: p.token0.decimals,
        decimals1: p.token1.decimals,
        baselineSqrtPriceX96: baseline.sqrtPriceX96,
        baselineRecordedAt: baseline.recordedAt,
        currentSqrtPriceX96: p.sqrtPriceX96,
      });
      const resetNote = baseline.wasReset ? " (resetado)" : "";
      return buildPositionLine(p, `IL: ${(il.ilPct * 100).toFixed(2)}%${resetNote}`);
    })
  );

  const pages = chunkLines(lines, MAX_MESSAGE_CHARS);

  for (const [i, pageLines] of pages.entries()) {
    const header =
      i === 0
        ? `Suas posições de LP em Arbitrum (${positions.length}):`
        : `Suas posições de LP em Arbitrum — continuação (${i + 1}/${pages.length}):`;
    const footer = i === pages.length - 1 ? `\n\n${IL_DISCLAIMER}` : "";
    await ctx.reply([header, ...pageLines].join("\n") + footer);
  }
}

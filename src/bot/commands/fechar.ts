import type { CommandContext, Context } from "grammy";
import type { Address } from "viem";
import { chainKeyFromDefillamaName, type ChainKey } from "../../config/chains.js";
import { automationAddress, checkCloseReadiness, closeAvailableOn, controllerAddressFor } from "../../data/onchain/close-position.js";
import { fetchPositionsForWallet } from "../../data/onchain/client.js";
import { fetchV4PositionsForWallet } from "../../data/onchain/client-v4.js";
import { validateBounds } from "../../domain/lp-rebalance/close-trigger.js";
import { sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import {
  disableCloseTrigger,
  listCloseTriggers,
  upsertCloseTrigger,
} from "../../persistence/repositories/close-triggers.repository.js";
import { findPositionByLabelOrTokenId, listUserWallets } from "../../persistence/repositories/lp-positions.repository.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";

// /fechar — arma o fechamento automático por preço-limite.
//
// O bot só sabe FECHAR. Não abre posição, e a garantia é do contrato: o
// CloseOnlyController não tem código de mint, e manda tudo pro dono da posição
// lido do NFT na hora. Ver contracts/src/CloseOnlyController.sol.
//
// O texto avisa duas coisas que o usuário PRECISA saber antes de confiar
// nisso: o ciclo é de 15min (não é proteção contra queda rápida), e o contrato
// não é auditado.

const USO = [
  "Uso: /fechar <tokenId|apelido> abaixo <preço> acima <preço>",
  "",
  "Ex: /fechar 5674258 abaixo 70000",
  "Ex: /fechar p1 abaixo 70000 acima 90000",
  "Ex: /fechar off 5674258      (desarma)",
  "",
  "Qualquer um dos dois lados é opcional. Os preços são na mesma unidade do /positions.",
].join("\n");

/** Lê "abaixo X acima Y" em qualquer ordem. Devolve null quando nada foi dito
 *  pra aquele lado — diferente de zero, que é um limite inválido. */
function parseLimites(tokens: string[]): { belowPrice: number | null; abovePrice: number | null } {
  let belowPrice: number | null = null;
  let abovePrice: number | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const chave = tokens[i]!.toLowerCase();
    const valor = Number(tokens[i + 1]?.replace(/[.,]/g, (m) => (m === "," ? "." : "")));
    if ((chave === "abaixo" || chave === "below") && !Number.isNaN(valor)) {
      belowPrice = valor;
      i++;
    } else if ((chave === "acima" || chave === "above") && !Number.isNaN(valor)) {
      abovePrice = valor;
      i++;
    }
  }
  return { belowPrice, abovePrice };
}

async function precoAtual(chainKey: ChainKey, wallet: Address, protocol: string, tokenId: string): Promise<number | null> {
  const posicoes = protocol === "v4" ? await fetchV4PositionsForWallet(chainKey, wallet) : await fetchPositionsForWallet(chainKey, wallet);
  const pos = posicoes.find((p) => p.tokenId.toString() === tokenId);
  if (!pos) return null;
  return sqrtPriceX96ToPrice(pos.sqrtPriceX96, pos.token0.decimals, pos.token1.decimals);
}

export async function fecharCommand(ctx: CommandContext<Context>) {
  const tokens = ctx.match?.toString().trim().split(/\s+/).filter(Boolean) ?? [];
  if (tokens.length === 0) {
    await ctx.reply(USO);
    return;
  }

  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));

  // /fechar off <id>
  if (tokens[0]!.toLowerCase() === "off") {
    const alvo = tokens[1];
    if (!alvo) {
      await ctx.reply("Uso: /fechar off <tokenId|apelido>");
      return;
    }
    const pos = await findPositionByLabelOrTokenId(user.id, alvo);
    if (!pos) {
      await ctx.reply(`Não achei a posição "${alvo}" vinculada a você — confira em /positions.`);
      return;
    }
    const ok = await disableCloseTrigger(user.id, pos.chain, pos.protocol, pos.tokenId);
    await ctx.reply(ok ? `Gatilho da posição #${pos.tokenId} desarmado.` : `A posição #${pos.tokenId} não tinha gatilho armado.`);
    return;
  }

  const pos = await findPositionByLabelOrTokenId(user.id, tokens[0]!);
  if (!pos) {
    await ctx.reply(`Não achei a posição "${tokens[0]}" vinculada a você — confira o tokenId em /positions.`);
    return;
  }

  const { belowPrice, abovePrice } = parseLimites(tokens.slice(1));
  if (belowPrice === null && abovePrice === null) {
    await ctx.reply(USO);
    return;
  }

  const chainKey = chainKeyFromDefillamaName(pos.chain) ?? (pos.chain as ChainKey);
  if (!closeAvailableOn(chainKey)) {
    await ctx.reply(
      [
        `O fechamento automático ainda não está configurado pra ${pos.chain}.`,
        "",
        "Falta o contrato CloseOnlyController deployado nessa chain e a chave de automação no servidor. Enquanto isso não existir, o bot é 100% somente-leitura.",
      ].join("\n")
    );
    return;
  }

  // O preço atual é necessário pra recusar um gatilho que já está satisfeito —
  // armar um assim fecharia a posição no próximo ciclo sem o usuário perceber.
  const wallets = (await listUserWallets()).filter((w) => w.userId === user.id);
  let preco: number | null = null;
  for (const w of wallets) {
    preco = await precoAtual(chainKey, w.address as Address, pos.protocol, pos.tokenId);
    if (preco !== null) break;
  }
  if (preco === null) {
    await ctx.reply(`Não consegui ler o preço da posição #${pos.tokenId} on-chain agora. Sem isso não arma — não quero configurar um gatilho no escuro.`);
    return;
  }

  const validacao = validateBounds({ belowPrice, abovePrice }, preco);
  if (!validacao.ok) {
    await ctx.reply(`${validacao.reason}\n\nPreço atual: ${preco.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`);
    return;
  }

  // Só arma depois de conferir que o contrato de fato consegue agir — caso
  // contrário o gatilho ficaria armado e falharia no momento em que importa.
  const prontidao = await checkCloseReadiness(chainKey, (wallets[0]?.address ?? "0x") as Address);
  if (!prontidao.ready) {
    await ctx.reply(
      [
        `Não vou armar ainda: ${prontidao.reason}.`,
        "",
        "Pra autorizar, com a SUA wallet (nenhuma dessas chamadas move fundos):",
        `1. setApprovalForAll(${controllerAddressFor(chainKey)}, true) no NonfungiblePositionManager`,
        `2. setAutomationKey(${automationAddress()}) no controller`,
        "",
        "Pra revogar depois, basta o setApprovalForAll com false — é ERC-721 padrão, não depende do contrato cooperar.",
      ].join("\n")
    );
    return;
  }

  await upsertCloseTrigger({
    userId: user.id,
    chain: pos.chain,
    protocol: pos.protocol,
    tokenId: pos.tokenId,
    belowPrice,
    abovePrice,
  });

  const limites = [
    belowPrice !== null ? `abaixo de ${belowPrice.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}` : null,
    abovePrice !== null ? `acima de ${abovePrice.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}` : null,
  ].filter(Boolean);

  await ctx.reply(
    [
      `Armado: fecho a posição #${pos.tokenId} (${pos.chain} ${pos.protocol}) se o preço ficar ${limites.join(" ou ")}.`,
      `Preço agora: ${preco.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}`,
      "",
      "O QUE VAI ACONTECER",
      "Removo toda a liquidez e coleto as taxas. Os fundos vão DIRETO pra sua wallet — o contrato não consegue mandar pra outro lugar. Aviso aqui antes e depois.",
      "",
      "O QUE VOCÊ PRECISA SABER",
      "• Checo a cada 15 minutos. O preço pode atravessar seu limite e voltar, ou cair bem além dele, entre duas checagens. Isso serve pra sair num preço sem pressa — NÃO é proteção contra queda rápida.",
      "• O contrato não é auditado.",
      "• Pra cancelar: /fechar off " + pos.tokenId + " — ou revogue a aprovação na sua carteira, que corta o acesso na hora.",
    ].join("\n")
  );
}

export async function fechamentosCommand(ctx: CommandContext<Context>) {
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));
  const gatilhos = await listCloseTriggers(user.id);

  const armados = gatilhos.filter((g) => g.enabled);
  if (armados.length === 0) {
    const jaDispararam = gatilhos.filter((g) => g.firedAt);
    await ctx.reply(
      [
        "Nenhum gatilho de fechamento armado.",
        ...(jaDispararam.length > 0
          ? ["", `(${jaDispararam.length} já dispararam antes — depois de fechar, o gatilho é desarmado.)`]
          : []),
        "",
        "Pra armar: /fechar <tokenId> abaixo <preço> acima <preço>",
      ].join("\n")
    );
    return;
  }

  const linhas = armados.map((g) => {
    const limites = [
      g.belowPrice !== null ? `abaixo de ${g.belowPrice.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}` : null,
      g.abovePrice !== null ? `acima de ${g.abovePrice.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}` : null,
    ].filter(Boolean);
    return `#${g.tokenId} (${g.chain} ${g.protocol}) — fecha ${limites.join(" ou ")}`;
  });

  await ctx.reply(
    [
      `Gatilhos armados (${armados.length}):`,
      ...linhas,
      "",
      "Checo a cada 15 minutos. Pra desarmar: /fechar off <tokenId>.",
    ].join("\n")
  );
}

import type { Address } from "viem";
import { chainKeyFromDefillamaName, type ChainKey } from "../../config/chains.js";
import { closeAvailableOn, closePosition } from "../../data/onchain/close-position.js";
import { fetchPositionsForWallet } from "../../data/onchain/client.js";
import { fetchV4PositionsForWallet } from "../../data/onchain/client-v4.js";
import { decideClose } from "../../domain/lp-rebalance/close-trigger.js";
import { sqrtPriceX96ToPrice } from "../../domain/lp-rebalance/price-math.js";
import { telegramChannel } from "../../notifications/channels/telegram.channel.js";
import { listArmedTriggers, markTriggerFired, type ArmedTrigger } from "../../persistence/repositories/close-triggers.repository.js";

// Fecha posições quando o preço cruza o limite que o usuário configurou.
//
// A ÚNICA parte do bot que escreve na blockchain. Ela só sabe FECHAR: o
// contrato não tem código de mint (ver contracts/src/CloseOnlyController.sol),
// e o destino dos fundos é sempre o dono da posição, lido do NFT na hora.
//
// LIMITAÇÃO QUE O USUÁRIO PRECISA CONHECER, e que está dita no /fechar: este
// job roda no ciclo de 15min. O preço pode atravessar o limite e voltar, ou
// despencar muito além dele, entre duas checagens. Isso serve pra "feche
// quando bater tal preço, sem pressa" — NÃO é proteção contra queda rápida.
//
// Desligado por padrão: sem CLOSE_AUTOMATION_PRIVATE_KEY e o endereço do
// controller, sai na primeira linha e o bot segue somente-leitura.

/** Preço atual da posição, lido do pool dela. Devolve null em vez de chutar:
 *  preço errado aqui fecha posição errada. */
async function precoDaPosicao(chainKey: ChainKey, wallet: Address, protocol: string, tokenId: string): Promise<number | null> {
  const posicoes = protocol === "v4" ? await fetchV4PositionsForWallet(chainKey, wallet) : await fetchPositionsForWallet(chainKey, wallet);
  const pos = posicoes.find((p) => p.tokenId.toString() === tokenId);
  if (!pos) return null;
  return sqrtPriceX96ToPrice(pos.sqrtPriceX96, pos.token0.decimals, pos.token1.decimals);
}

async function processar(t: ArmedTrigger): Promise<"disparou" | "manteve" | "erro"> {
  const chainKey = chainKeyFromDefillamaName(t.chain) ?? (t.chain as ChainKey);
  if (!closeAvailableOn(chainKey)) return "manteve";

  const preco = await precoDaPosicao(chainKey, t.walletAddress as Address, t.protocol, t.tokenId);
  if (preco === null) return "manteve"; // posição já não existe, ou leitura falhou

  const decisao = decideClose({ belowPrice: t.belowPrice, abovePrice: t.abovePrice }, preco);
  if (!decisao.fire) return "manteve";

  const lado = decisao.side === "below" ? "caiu abaixo de" : "subiu acima de";
  // Avisa ANTES de enviar: se a transação demorar ou falhar, o usuário já sabe
  // que o gatilho disparou e não descobre pelo saldo.
  await telegramChannel.send(
    t.telegramChatId,
    [
      `🔔 Gatilho disparado na posição #${t.tokenId} (${t.chain} ${t.protocol}).`,
      `O preço ${lado} ${decisao.limit.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} — está em ${preco.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}.`,
      "",
      "Enviando o fechamento. Os fundos vão direto pra sua wallet.",
    ].join("\n")
  );

  const r = await closePosition(chainKey, t.tokenId);
  if (!r.ok) {
    await telegramChannel.send(
      t.telegramChatId,
      [
        `❌ Não consegui fechar a posição #${t.tokenId}: ${r.error}`,
        "",
        "O gatilho continua ARMADO e vou tentar de novo no próximo ciclo. Se quiser desarmar: /fechar off " + t.tokenId,
      ].join("\n")
    );
    return "erro";
  }

  // Só desarma DEPOIS de a transação confirmar com sucesso — falha tem que
  // deixar o gatilho de pé, senão uma queda de RPC vira posição desprotegida.
  await markTriggerFired(t.id, r.txHash);
  await telegramChannel.send(
    t.telegramChatId,
    [
      `✅ Posição #${t.tokenId} fechada. Os fundos e as taxas foram pra sua wallet.`,
      `tx: ${r.txHash}`,
      "",
      "O gatilho foi desarmado. Pra armar de novo numa posição nova, use /fechar.",
    ].join("\n")
  );
  return "disparou";
}

export async function checkCloseTriggersJob(): Promise<string> {
  const armados = await listArmedTriggers();
  if (armados.length === 0) return "nenhum gatilho armado.";

  let disparou = 0;
  let erros = 0;

  // Em série, não em paralelo: cada disparo envia uma transação assinada pela
  // MESMA chave, e transações concorrentes da mesma conta brigam por nonce.
  for (const t of armados) {
    try {
      const r = await processar(t);
      if (r === "disparou") disparou += 1;
      if (r === "erro") erros += 1;
    } catch (err) {
      erros += 1;
      console.error(`[check-close-triggers] falha no gatilho ${t.id}:`, err);
    }
  }

  const resumo = `${armados.length} gatilho(s) armado(s), ${disparou} disparado(s)${erros > 0 ? `, ${erros} com erro` : ""}.`;
  console.log(`[check-close-triggers] ${resumo}`);
  return resumo;
}

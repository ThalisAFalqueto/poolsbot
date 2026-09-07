import type { CommandContext, Context } from "grammy";
import { NEAR_EDGE_FRACTION } from "../../domain/lp-rebalance/near-edge.js";
import { getNearEdgeAlerts, setNearEdgeAlerts } from "../../persistence/repositories/users.repository.js";
import { findOrCreateUserByTelegramChatId } from "../../persistence/repositories/users.repository.js";

// Liga/desliga o aviso de que a posição está CHEGANDO na borda.
//
// Existe como comando, e não como comportamento fixo, porque o usuário disse
// uma coisa ("não acho que precisa de alerta de aproximação da borda") e depois
// pediu o contrário. Em vez de eu adivinhar qual das duas vale hoje, ele decide
// — e o padrão é DESLIGADO, que é o estado menos intrusivo.

const PCT = (NEAR_EDGE_FRACTION * 100).toFixed(0);

export async function bordaAlertaCommand(ctx: CommandContext<Context>) {
  const arg = ctx.match?.toString().trim().toLowerCase();
  const user = await findOrCreateUserByTelegramChatId(String(ctx.chat.id));

  if (arg !== "on" && arg !== "off") {
    const atual = await getNearEdgeAlerts(user.id);
    await ctx.reply(
      [
        `Aviso de aproximação da borda: ${atual ? "LIGADO" : "desligado"}.`,
        "",
        "Uso: /bordaalerta on   |   /bordaalerta off",
        "",
        `Ligado, eu aviso quando o preço entra nos ${PCT}% finais da sua faixa — antes de sair, não depois. No máximo uma vez a cada 6h por posição, e o relógio zera quando o preço volta pro meio.`,
        "",
        "É aviso, não recomendação: quando a folga é pequena, esperar costuma ser razoável.",
      ].join("\n")
    );
    return;
  }

  const ligado = await setNearEdgeAlerts(user.id, arg === "on");
  await ctx.reply(
    ligado
      ? `Ligado. Aviso quando o preço entrar nos ${PCT}% finais da faixa de alguma posição sua.`
      : "Desligado. Continuo avisando quando a posição SAI da faixa — isso não muda."
  );
}

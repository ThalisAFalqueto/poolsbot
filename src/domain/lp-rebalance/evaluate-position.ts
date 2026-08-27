import { isInRange } from "./price-math.js";
import { formatReason } from "./format-reason.js";
import type { EvaluatePositionInput, EvaluatePositionOutput, PositionState } from "./types.js";

// Fração da largura do range usada como margem de segurança antes de
// considerar "recuperado" (voltou pra dentro do range) — evita notificar
// out->in->out repetidamente se o preço fica oscilando bem em cima da borda.
// Só se aplica à transição de RECUPERAÇÃO: sair de range é sempre detectado
// imediatamente e sem margem (é sempre um evento real, o tick on-chain não
// tem ruído de leitura como uma métrica agregada tipo APY).
const RECOVERY_MARGIN_FRACTION = 0.1;

// Mesmo ritmo de lembrete usado como default no v1 (DEFAULT_ALERT_RULES).
const REMINDER_INTERVAL_HOURS = 6;

// Exportado porque o JOB precisa usar exatamente este critério pra decidir se
// calcula a faixa sugerida. Enquanto ele usava `isInRange` (borda crua) e isto
// aqui usava margem, existia uma faixa de ticks em que o job mandava null e a
// máquina de estado emitia lembrete — crash em produção (27/08/2026).
export function isSafelyInRange(currentTick: number, tickLower: number, tickUpper: number): boolean {
  const width = tickUpper - tickLower;
  const margin = width * RECOVERY_MARGIN_FRACTION;
  return currentTick >= tickLower + margin && currentTick < tickUpper - margin;
}

const CONFIDENCE = 0.95; // dado on-chain direto, sem proxy/heurística envolvida

export function evaluatePosition(input: EvaluatePositionInput): EvaluatePositionOutput {
  const { position, state, now, gasCost, suggestedRange } = input;
  const { currentTick, tickLower, tickUpper } = position;
  const inRange = isInRange(currentTick, tickLower, tickUpper);

  if (state.status === "in_range") {
    if (inRange) return { nextState: state, notification: null };

    const nextState: PositionState = { status: "out_of_range", outOfRangeSince: now, lastNotifiedAt: now };
    return {
      nextState,
      notification: {
        kind: "out_of_range",
        reason: formatReason(position, "out_of_range", now, gasCost, suggestedRange),
        confidence: CONFIDENCE,
      },
    };
  }

  // state.status === "out_of_range"
  if (isSafelyInRange(currentTick, tickLower, tickUpper)) {
    const nextState: PositionState = { status: "in_range", outOfRangeSince: null, lastNotifiedAt: null };
    return {
      nextState,
      notification: {
        kind: "back_in_range",
        reason: formatReason(position, "back_in_range", null, gasCost, suggestedRange),
        confidence: CONFIDENCE,
      },
    };
  }

  const reminderMs = REMINDER_INTERVAL_HOURS * 3600 * 1000;
  const dueForReminder =
    state.lastNotifiedAt === null || now.getTime() - state.lastNotifiedAt.getTime() >= reminderMs;

  if (dueForReminder) {
    return {
      nextState: { ...state, lastNotifiedAt: now },
      notification: {
        kind: "reminder",
        reason: formatReason(position, "reminder", state.outOfRangeSince, gasCost, suggestedRange),
        confidence: CONFIDENCE,
      },
    };
  }

  return { nextState: state, notification: null };
}

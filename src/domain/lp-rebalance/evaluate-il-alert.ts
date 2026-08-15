import { formatIlAlertReason } from "./format-reason.js";
import type { OnchainPosition } from "./types.js";
import type { ImpermanentLossResult } from "./calculate-il.js";

// -5% de IL é um limiar comumente usado como "vale prestar atenção" — abaixo
// de ~25% de divergência de preço, IL de par 50/50 tende a ficar sob 3%;
// -5% já indica uma divergência mais séria. Histerese de 1.5pp (menor que os
// 5pp do v1, proporcional à escala tipicamente mais fina de IL) evita
// flapping sem exigir uma recuperação exageradamente completa.
const TRIGGER_THRESHOLD = -0.05;
const RECOVERY_THRESHOLD = -0.035;
const REMINDER_INTERVAL_HOURS = 6;
const CONFIDENCE = 0.9; // cálculo direto (não proxy), mas baseline é aproximado (ver format-reason)

export type IlAlertState = {
  status: "ok" | "triggered";
  triggeredAt: Date | null;
  lastNotifiedAt: Date | null;
};

export type IlAlertNotification = {
  kind: "triggered" | "reminder" | "recovered";
  reason: string;
  confidence: number;
};

export type EvaluateIlAlertInput = {
  position: OnchainPosition;
  il: ImpermanentLossResult;
  state: IlAlertState;
  now: Date;
};

export type EvaluateIlAlertOutput = {
  nextState: IlAlertState;
  notification: IlAlertNotification | null;
};

export function evaluateIlAlert(input: EvaluateIlAlertInput): EvaluateIlAlertOutput {
  const { position, il, state, now } = input;
  const triggered = il.ilPct <= TRIGGER_THRESHOLD;
  const recovered = il.ilPct >= RECOVERY_THRESHOLD;

  if (state.status === "ok") {
    if (!triggered) return { nextState: state, notification: null };
    const nextState: IlAlertState = { status: "triggered", triggeredAt: now, lastNotifiedAt: now };
    return {
      nextState,
      notification: { kind: "triggered", reason: formatIlAlertReason(position, il, "triggered"), confidence: CONFIDENCE },
    };
  }

  // state.status === "triggered"
  if (recovered) {
    const nextState: IlAlertState = { status: "ok", triggeredAt: null, lastNotifiedAt: null };
    return {
      nextState,
      notification: { kind: "recovered", reason: formatIlAlertReason(position, il, "recovered"), confidence: CONFIDENCE },
    };
  }

  const reminderMs = REMINDER_INTERVAL_HOURS * 3600 * 1000;
  const dueForReminder =
    state.lastNotifiedAt === null || now.getTime() - state.lastNotifiedAt.getTime() >= reminderMs;

  if (dueForReminder) {
    return {
      nextState: { ...state, lastNotifiedAt: now },
      notification: { kind: "reminder", reason: formatIlAlertReason(position, il, "reminder"), confidence: CONFIDENCE },
    };
  }

  return { nextState: state, notification: null };
}

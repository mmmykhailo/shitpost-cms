import type { AdminResponseRepository } from "../db/admin-response-repository";
import type { TelegramIncidentRecord, TelegramIncidentRepository } from "../db/telegram-incident-repository";
import type { Logger } from "../logger";
import type { TelegramCooldown } from "../telegram-cooldown";

const QUIET_PERIOD_MS = 5 * 60_000;
const WARNING_AFTER_MS = 5 * 60_000;

export type IncidentNotificationDescriptor = {
  version: 1;
  text: string;
  incident: { id: string; kind: "warning" | "recovery" };
  replyMarkup?: { kind: "inline_keyboard"; rows: Array<Array<{ text: string; action: string; payload: unknown }>> };
};

export const createTelegramIncidentService = (input: {
  incidents: TelegramIncidentRepository;
  responses: AdminResponseRepository;
  adminChatId: number;
  adminUserId: number;
  cooldown: Pick<TelegramCooldown, "isActive" | "notBefore">;
  now: () => number;
  logger: Logger;
}) => {
  const stableRecovery = (incident: TelegramIncidentRecord, now: number): boolean =>
    now >= incident.quietUntil && !input.cooldown.isActive()
    && incident.lastRelevantSuccessAt !== undefined
    && incident.lastRelevantSuccessAt >= incident.cooldownUntil;

  const warningEligible = (incident: TelegramIncidentRecord, now: number): boolean =>
    incident.actionRequired || (now >= incident.firstFailureAt + WARNING_AFTER_MS
      && (input.cooldown.isActive() || incident.lastRelevantSuccessAt === undefined || incident.lastRelevantSuccessAt < incident.cooldownUntil));

  const notification = (incident: TelegramIncidentRecord, kind: "warning" | "recovery"): IncidentNotificationDescriptor => kind === "warning"
    ? {
      version: 1,
      incident: { id: incident.id, kind },
      text: `Telegram is still rejecting queue mutations. The shared pause currently ends at ${new Date(incident.cooldownUntil).toISOString()}. Admin replies remain queued until Telegram permits delivery.`,
      replyMarkup: { kind: "inline_keyboard", rows: [[{ text: "Open queue", action: "queue", payload: {} }]] },
    }
    : { version: 1, incident: { id: incident.id, kind }, text: "Telegram queue mutations recovered and remained healthy for five minutes." };

  const enqueueOrRearm = (incident: TelegramIncidentRecord, kind: "warning" | "recovery", now: number): string | undefined => {
    const dedupeKey = `incident:${incident.id}:${kind}`;
    const existing = input.responses.findByDedupeKey(dedupeKey);
    if (existing?.state === "sent" || existing?.state === "sending" || existing?.state === "uncertain" || existing?.state === "failed") return existing.id;
    if (existing?.state === "pending") return existing.id;
    if (existing?.state === "cancelled") return input.responses.rearmCancelled(dedupeKey, notification(incident, kind), now)?.id;
    return input.responses.enqueue({ dedupeKey, adminChatId: input.adminChatId, kind: kind === "warning" ? "warning" : "recovery", descriptor: notification(incident, kind), now }).record.id;
  };

  const observeRealFloodWait = (event: { at: number; notBefore: number; method: string; family: string }): void => {
    const previous = input.incidents.open("flood_wait");
    const incident = input.incidents.observeRealFloodWait(event.at, event.notBefore);
    if (previous?.recoveryOutboxId !== undefined) input.responses.cancel(previous.recoveryOutboxId, event.at);
    input.logger.warn("telegram_incident_flood_wait_observed", { incidentId: incident.id, method: event.method, family: event.family, cooldownUntil: incident.cooldownUntil });
  };

  const observeRelevantSuccess = (_event: { at: number; method: string; family: string; chatId: number }): void => {
    input.incidents.observeRelevantSuccess(_event.at);
  };

  const evaluate = (now = input.now()): { state: "idle" | "active" | "recovering" | "resolved"; incidentId?: string } => {
    const incident = input.incidents.snapshot();
    if (incident === undefined) return { state: "idle" };

    if (incident.state === "active" && stableRecovery(incident, now)) {
      if (incident.warningDeliveredAt === undefined && incident.warningOutboxId !== undefined) {
        const warning = input.responses.find(incident.warningOutboxId);
        if (warning?.state === "sent" && warning.sentAt !== undefined) {
          acknowledgeDelivered(incident.id, "warning", warning.id, warning.sentAt);
          return { state: "active", incidentId: incident.id };
        }
        if (warning?.state === "uncertain" || (warning?.state === "sending" && warning.requestStartedAt !== undefined)) return { state: "active", incidentId: incident.id };
        input.responses.cancel(incident.warningOutboxId, now);
        input.incidents.resolveSilently(incident.id, now);
        return { state: "resolved", incidentId: incident.id };
      }
      if (incident.warningDeliveredAt === undefined) {
        input.incidents.resolveSilently(incident.id, now);
        return { state: "resolved", incidentId: incident.id };
      }
      const id = enqueueOrRearm(incident, "recovery", now);
      if (id !== undefined && input.incidents.setRecoveryOutbox(incident.id, id)) {
        return { state: "recovering", incidentId: incident.id };
      }
    }

    const current = input.incidents.find(incident.id);
    if (current?.state === "recovering") {
      if (!stableRecovery(current, now)) {
        if (current.recoveryOutboxId !== undefined) input.responses.cancel(current.recoveryOutboxId, now);
        input.incidents.returnToActive(current.id);
        return { state: "active", incidentId: current.id };
      }
      const id = enqueueOrRearm(current, "recovery", now);
      if (id !== undefined && id !== current.recoveryOutboxId) input.incidents.setRecoveryOutbox(current.id, id);
      return { state: "recovering", incidentId: current.id };
    }

    if (current?.state === "active" && warningEligible(current, now) && current.warningDeliveredAt === undefined) {
      const id = enqueueOrRearm(current, "warning", now);
      if (id !== undefined && id !== current.warningOutboxId) input.incidents.setWarningOutbox(current.id, id);
    }
    const result = input.incidents.find(incident.id);
    return { state: result?.state ?? "resolved", incidentId: incident.id };
  };

  const canDeliver = (incidentId: string, kind: "warning" | "recovery", now: number): boolean => {
    evaluate(now);
    const incident = input.incidents.find(incidentId);
    if (incident === undefined) return false;
    return kind === "warning"
      ? incident.state === "active" && warningEligible(incident, now) && incident.warningDeliveredAt === undefined
      : incident.state === "recovering" && stableRecovery(incident, now) && incident.warningDeliveredAt !== undefined;
  };

  const acknowledgeDelivered = (incidentId: string, kind: "warning" | "recovery", outboxId: string, now: number): boolean => input.incidents.transaction(() => {
    const success = kind === "warning"
      ? input.incidents.markWarningDelivered(incidentId, outboxId, now)
      : input.incidents.markRecoveryDelivered(incidentId, outboxId, now);
    if (!success) input.logger.warn("telegram_incident_delivery_ack_stale", { incidentId, outboxId, kind });
    return success;
  });

  const setActionRequired = (id: string, required: boolean): boolean => input.incidents.acknowledgeActionRequired(id, required);
  return { observeRealFloodWait, observeRelevantSuccess, evaluate, canDeliver, acknowledgeDelivered, setActionRequired, snapshot: input.incidents.snapshot, counts: input.incidents.counts };
};

export type TelegramIncidentService = ReturnType<typeof createTelegramIncidentService>;

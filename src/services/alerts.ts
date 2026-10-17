import type { AlertRepository, AlertSeverity } from "../db/alert-repository";
import type { AdminResponseRepository } from "../db/admin-response-repository";
import type { AdminResponseDescriptor } from "./admin-response-worker";
import { safeErrorDescription, type Logger } from "../logger";
import type { TelegramGateway } from "../telegram";
import type { ChatId } from "../types";

export type AlertService = ReturnType<typeof createAlertService>;

export const resolutionTextForDedupeKey = (dedupeKey: string): string => {
  const [condition, itemId, generation] = dedupeKey.split(":");
  switch (condition) {
    case "uncertain_publish": return itemId === undefined ? `Publication uncertainty (${dedupeKey}) cleared.` : `Publication uncertainty for queue item #${itemId} cleared.`;
    case "uncertain_renewal": return itemId === undefined ? `Renewal uncertainty (${dedupeKey}) cleared.` : `Renewal uncertainty for queue item #${itemId} cleared.`;
    case "blocked_head": return itemId === undefined ? `Blocked-head condition (${dedupeKey}) cleared.` : `Blocked-head condition for queue item #${itemId} cleared.`;
    case "needs_edit": return itemId === undefined ? `Edit-required condition (${dedupeKey}) cleared.` : `Edit-required condition for queue item #${itemId} (needs_edit) cleared.`;
    case "needs_review": return itemId === undefined ? `Review-required condition (${dedupeKey}) cleared.` : `Review-required condition for queue item #${itemId} (needs_review) cleared.`;
    case "renewal_warning": return itemId === undefined ? `Renewal warning (${dedupeKey}) cleared.` : `Renewal warning for queue item #${itemId} cleared.`;
    case "renewal_critical": return itemId === undefined ? `Critical renewal condition (${dedupeKey}) cleared.` : `Critical renewal condition for queue item #${itemId} cleared.`;
    case "deleted_external": return itemId === undefined ? `External queue deletion condition (${dedupeKey}) cleared.` : `External deletion condition for queue item #${itemId} cleared.`;
    case "orphan_manual": return itemId === undefined ? `Manual orphan-cleanup condition (${dedupeKey}) cleared.` : `Manual orphan cleanup for queue item #${itemId}${generation === undefined ? "" : ` generation ${generation}`} cleared.`;
    case "permissions": return itemId === undefined ? `Telegram permission condition (${dedupeKey}) cleared.` : `Telegram permission condition for queue channel ${itemId} cleared.`;
    case "renewal_capacity": return "Renewal capacity condition (renewal_capacity) cleared.";
    default: return `Condition ${dedupeKey} cleared.`;
  }
};

type StoredAlertAction = { text: string; action: string; payload: unknown; itemVersion?: number };
type StoredOnChangePayload = { text: string; actions?: StoredAlertAction[]; [key: string]: unknown };
type AlertOutboxDescriptor = AdminResponseDescriptor & { version: 1; alert: { dedupeKey: string; fingerprint?: string; mode: "periodic" | "on_change" | "resolution" } };

export const createAlertService = (input: {
  alert: AlertRepository;
  gateway: TelegramGateway;
  adminChatId: ChatId;
  logger: Logger;
  responses?: AdminResponseRepository;
  createCallbackToken?: (action: string, payload: unknown, now: number, itemVersion?: number) => string;
}) => {
  const findAlert = (dedupeKey: string) => (input.alert as Partial<AlertRepository>).find?.(dedupeKey);
  const enqueueDurable = (dedupeKey: string, severity: AlertSeverity, text: string, now: number, alert: AlertOutboxDescriptor["alert"], actions?: StoredAlertAction[]): void => {
    if (!input.responses) return;
    const key = alert.mode === "periodic" ? `alert:${dedupeKey}:periodic`
      : `alert:${dedupeKey}:${alert.mode}${alert.fingerprint === undefined ? `:${now}` : `:${alert.fingerprint}`}`;
    const descriptor: AlertOutboxDescriptor = {
      version: 1,
      text: `[${severity}] ${text}`,
      alert,
      ...(actions?.length ? { replyMarkup: { kind: "inline_keyboard", rows: actions.map((action) => [{ text: action.text, action: action.action, payload: action.payload, ...(action.itemVersion === undefined ? {} : { itemVersion: action.itemVersion }) }]) } } : {}),
    };
    const existing = input.responses.findByDedupeKey(key);
    if (existing?.state === "pending" || existing?.state === "sending" || existing?.state === "uncertain" || existing?.state === "failed") return;
    if (existing?.state === "cancelled" && input.responses.rearmCancelled(key, descriptor, now)) return;
    if (existing?.state === "sent" && input.responses.rearmSent(key, descriptor, now)) return;
    if (existing === undefined) input.responses.enqueue({ dedupeKey: key, adminChatId: Number(input.adminChatId), kind: alert.mode === "resolution" ? "recovery" : "warning", descriptor, now });
  };

  const enqueueOnChange = (dedupeKey: string, severity: AlertSeverity, fingerprint: string, rawPayload: unknown, now: number): void => {
    const payload = rawPayload && typeof rawPayload === "object" && "text" in rawPayload && typeof (rawPayload as { text?: unknown }).text === "string"
      ? rawPayload as StoredOnChangePayload
      : { text: String(rawPayload) };
    enqueueDurable(dedupeKey, severity, payload.text, now, { dedupeKey, fingerprint, mode: "on_change" }, payload.actions);
  };

  const raise = async (dedupeKey: string, severity: AlertSeverity, text: string, now: number): Promise<void> => {
    const raised = input.alert.raise(dedupeKey, severity, now);
    if (!raised.shouldSend) return;
    if (input.responses) {
      enqueueDurable(dedupeKey, severity, text, now, { dedupeKey, mode: "periodic" });
      return;
    }
    try {
      await input.gateway.sendAdminMessage({ chatId: input.adminChatId, text: `[${severity}] ${text}` });
    } catch (error) {
      input.logger.error("admin_alert_send_failed", { dedupeKey, error: safeErrorDescription(error) });
      return;
    }
    try { input.alert.markSent(dedupeKey, now); }
    catch (error) { input.logger.error("admin_alert_mark_sent_failed", { dedupeKey, error: safeErrorDescription(error) }); }
  };

  const raiseOnChange = async (dedupeKey: string, severity: AlertSeverity, fingerprint: string, rawPayload: unknown, now: number): Promise<void> => {
    const previous = findAlert(dedupeKey);
    const raised = input.alert.raiseOnChange(dedupeKey, severity, fingerprint, rawPayload, now);
    if (!raised.shouldSend) return;
    if (input.responses) {
      if (previous?.conditionFingerprint !== undefined && previous.conditionFingerprint !== fingerprint) input.responses.cancelByDedupeKey(`alert:${dedupeKey}:on_change:${previous.conditionFingerprint}`, now);
      if (previous?.sentFingerprint !== undefined) input.responses.cancelByDedupeKey(`alert:${dedupeKey}:resolution:${previous.sentFingerprint}`, now);
      enqueueOnChange(dedupeKey, severity, fingerprint, rawPayload, now);
      return;
    }
    const payload = rawPayload && typeof rawPayload === "object" && "text" in rawPayload && typeof (rawPayload as { text?: unknown }).text === "string" ? rawPayload as StoredOnChangePayload : { text: String(rawPayload) };
    try {
      const replyMarkup = input.createCallbackToken && payload.actions?.length ? { inline_keyboard: payload.actions.map((action) => [{ text: action.text, callback_data: `v1:${input.createCallbackToken!(action.action, action.payload, now, action.itemVersion)}` }]) } : undefined;
      await input.gateway.sendAdminMessage({ chatId: input.adminChatId, text: `[${severity}] ${payload.text}`, ...(replyMarkup === undefined ? {} : { replyMarkup }) });
      input.alert.markOnChangeSent(dedupeKey, fingerprint, now);
    } catch (error) {
      input.alert.markOnChangeDeliveryFailed(dedupeKey, fingerprint, now);
      input.logger.error("admin_alert_on_change_send_failed", { dedupeKey, error: safeErrorDescription(error) });
    }
  };

  const retryPendingOnChange = async (now: number): Promise<number> => {
    const pending = input.alert.pendingOnChange(now);
    for (const entry of pending) {
      if (input.responses) enqueueOnChange(entry.dedupeKey, entry.severity, entry.fingerprint, entry.payload, now);
      else await raiseOnChange(entry.dedupeKey, entry.severity, entry.fingerprint, entry.payload, now);
    }
    return pending.length;
  };

  const resolve = async (dedupeKey: string, text: string, now: number): Promise<void> => {
    const previous = findAlert(dedupeKey);
    if (!input.alert.resolve(dedupeKey, now)) return;
    if (input.responses) {
      if (previous?.notificationMode === "on_change") {
        if (previous.sentFingerprint !== undefined) enqueueDurable(dedupeKey, previous.severity, `Resolved: ${text}`, now, { dedupeKey, fingerprint: previous.sentFingerprint, mode: "resolution" });
        else if (previous.conditionFingerprint !== undefined) input.responses.cancelByDedupeKey(`alert:${dedupeKey}:on_change:${previous.conditionFingerprint}`, now);
      } else enqueueDurable(dedupeKey, previous?.severity ?? "normal", `Resolved: ${text}`, now, { dedupeKey, mode: "resolution" });
      return;
    }
    try { await input.gateway.sendAdminMessage({ chatId: input.adminChatId, text: `Resolved: ${text}` }); }
    catch (error) { input.logger.error("admin_alert_resolution_send_failed", { dedupeKey, error: safeErrorDescription(error) }); }
  };

  const canDeliver = (dedupeKey: string, fingerprint: string | undefined, mode: "periodic" | "on_change" | "resolution"): boolean => {
    const current = findAlert(dedupeKey);
    if (current === undefined) return false;
    if (mode === "on_change") return current.resolvedAt === undefined && current.conditionFingerprint === fingerprint && current.sentFingerprint !== fingerprint;
    if (mode === "resolution") return current.resolvedAt !== undefined && (fingerprint === undefined || current.sentFingerprint === fingerprint);
    return current.resolvedAt === undefined;
  };
  const acknowledgeDelivered = (dedupeKey: string, fingerprint: string | undefined, mode: "periodic" | "on_change" | "resolution", now: number): void => {
    if (mode === "on_change" && fingerprint !== undefined) input.alert.markOnChangeSent(dedupeKey, fingerprint, now);
    else input.alert.markSent(dedupeKey, now);
  };

  return { raise, raiseOnChange, retryPendingOnChange, resolve, active: input.alert.active, counts: input.alert.counts, canDeliver, acknowledgeDelivered };
};

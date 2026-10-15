import type { AlertRepository, AlertSeverity } from "../db/alert-repository";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import type { Logger } from "../logger";
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

export const createAlertService = (input: {
  alert: AlertRepository;
  gateway: TelegramGateway;
  adminChatId: ChatId;
  logger: Logger;
  createCallbackToken?: (action: string, payload: unknown, now: number, itemVersion?: number) => string;
}) => {
  const raise = async (dedupeKey: string, severity: AlertSeverity, text: string, now: number): Promise<void> => {
    const raised = input.alert.raise(dedupeKey, severity, now);
    if (!raised.shouldSend) return;
    try {
      await input.gateway.sendAdminMessage({ chatId: input.adminChatId, text: `[${severity}] ${text}` });
    } catch (error) {
      // Alert delivery must never change the queue state or fail a worker.
      input.logger.error("admin_alert_send_failed", { dedupeKey, error: error instanceof Error ? error.message : "unknown" });
      return;
    }
    try {
      input.alert.markSent(dedupeKey, now);
    } catch (error) {
      input.logger.error("admin_alert_mark_sent_failed", { dedupeKey, error: error instanceof Error ? error.message : "unknown" });
    }
  };

  const renderActions = (payload: StoredOnChangePayload, now: number): InlineKeyboardMarkup | undefined => {
    if (!input.createCallbackToken || !payload.actions?.length) return undefined;
    return { inline_keyboard: payload.actions.map((action) => [{
      text: action.text,
      callback_data: `v1:${input.createCallbackToken!(action.action, action.payload, now, action.itemVersion)}`,
    }]) };
  };

  const sendOnChange = async (dedupeKey: string, severity: AlertSeverity, fingerprint: string, rawPayload: unknown, now: number): Promise<void> => {
    const payload = rawPayload && typeof rawPayload === "object" && "text" in rawPayload && typeof (rawPayload as { text?: unknown }).text === "string"
      ? rawPayload as StoredOnChangePayload
      : { text: String(rawPayload) };
    try {
      const replyMarkup = renderActions(payload, now);
      await input.gateway.sendAdminMessage({ chatId: input.adminChatId, text: `[${severity}] ${payload.text}`, ...(replyMarkup === undefined ? {} : { replyMarkup }) });
    } catch (error) {
      try { input.alert.markOnChangeDeliveryFailed(dedupeKey, fingerprint, now); }
      catch (markError) { input.logger.error("admin_alert_retry_state_failed", { dedupeKey, error: markError instanceof Error ? markError.message : "unknown" }); }
      input.logger.error("admin_alert_on_change_send_failed", { dedupeKey, error: error instanceof Error ? error.message : "unknown" });
      return;
    }
    try {
      if (!input.alert.markOnChangeSent(dedupeKey, fingerprint, now)) input.logger.warn("admin_alert_condition_changed_during_delivery", { dedupeKey });
    } catch (error) {
      input.logger.error("admin_alert_mark_sent_failed", { dedupeKey, error: error instanceof Error ? error.message : "unknown" });
    }
  };

  const raiseOnChange = async (dedupeKey: string, severity: AlertSeverity, fingerprint: string, payload: unknown, now: number): Promise<void> => {
    const raised = input.alert.raiseOnChange(dedupeKey, severity, fingerprint, payload, now);
    if (raised.shouldSend) await sendOnChange(dedupeKey, severity, fingerprint, payload, now);
  };

  const retryPendingOnChange = async (now: number): Promise<number> => {
    const pending = input.alert.pendingOnChange(now);
    for (const entry of pending) await sendOnChange(entry.dedupeKey, entry.severity, entry.fingerprint, entry.payload, now);
    return pending.length;
  };

  const resolve = async (dedupeKey: string, text: string, now: number): Promise<void> => {
    if (!input.alert.resolve(dedupeKey, now)) return;
    try { await input.gateway.sendAdminMessage({ chatId: input.adminChatId, text: `Resolved: ${text}` }); }
    catch (error) { input.logger.error("admin_alert_resolution_send_failed", { dedupeKey, error: error instanceof Error ? error.message : "unknown" }); }
  };

  return { raise, raiseOnChange, retryPendingOnChange, resolve, active: input.alert.active, counts: input.alert.counts };
};

import type { AlertRepository, AlertSeverity } from "../db/alert-repository";
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

export const createAlertService = (input: { alert: AlertRepository; gateway: TelegramGateway; adminChatId: ChatId; logger: Logger }) => {
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

  const resolve = async (dedupeKey: string, text: string, now: number): Promise<void> => {
    if (!input.alert.resolve(dedupeKey, now)) return;
    try { await input.gateway.sendAdminMessage({ chatId: input.adminChatId, text: `Resolved: ${text}` }); }
    catch (error) { input.logger.error("admin_alert_resolution_send_failed", { dedupeKey, error: error instanceof Error ? error.message : "unknown" }); }
  };

  return { raise, resolve, active: input.alert.active, counts: input.alert.counts };
};

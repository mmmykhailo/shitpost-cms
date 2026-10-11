import type { AlertRepository, AlertSeverity } from "../db/alert-repository";
import type { Logger } from "../logger";
import type { TelegramGateway } from "../telegram";
import type { ChatId } from "../types";

export type AlertService = ReturnType<typeof createAlertService>;

export const createAlertService = (input: { alert: AlertRepository; gateway: TelegramGateway; adminChatId: ChatId; logger: Logger }) => {
  const raise = async (dedupeKey: string, severity: AlertSeverity, text: string, now: number): Promise<void> => {
    const raised = input.alert.raise(dedupeKey, severity, now);
    if (!raised.shouldSend) return;
    try {
      await input.gateway.sendAdminMessage({ chatId: input.adminChatId, text: `[${severity}] ${text}` });
      input.alert.markSent(dedupeKey, now);
    } catch (error) {
      // Alert delivery must never change the queue state or fail a worker.
      input.logger.error("admin_alert_send_failed", { dedupeKey, error: error instanceof Error ? error.message : "unknown" });
    }
  };

  const resolve = async (dedupeKey: string, text: string, now: number): Promise<void> => {
    if (!input.alert.resolve(dedupeKey, now)) return;
    try { await input.gateway.sendAdminMessage({ chatId: input.adminChatId, text: `Resolved: ${text}` }); }
    catch (error) { input.logger.error("admin_alert_resolution_send_failed", { dedupeKey, error: error instanceof Error ? error.message : "unknown" }); }
  };

  return { raise, resolve, active: input.alert.active, counts: input.alert.counts };
};

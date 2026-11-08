import type { Api } from "grammy";
import { snapshotDesk, widgetCaption, widgetHtml, widgetTemplate } from "../admin-ui/widget/model";
import { rawWidgets } from "../admin-ui/widget/transport";
import type { AdminPanelRepository } from "../db/admin-panel-repository";
import type { AdminResponseRecord, AdminResponseRepository } from "../db/admin-response-repository";
import { classifyTelegramError, TelegramLocalDeferralError } from "../errors";
import { withTelegramMutationScope } from "../telegram-request-context";
import type { Clock } from "../types";

export type WidgetDelivery = { revision: number; messageId?: number };
export const widgetCoalesceKey = (chatId: number) => `admin:${chatId}:widget`;

export const createAdminWidgetDelivery = (input: {
  api: Api;
  panels: AdminPanelRepository;
  responses: AdminResponseRepository;
  clock: Clock;
  enabled: boolean;
  adminChatId: number;
}) => {
  const api = rawWidgets(input.api);
  return async (row: AdminResponseRecord, delivery: WidgetDelivery): Promise<void> => {
    const now = input.clock.now;
    const claim = row.claimToken!;
    const chatId = row.adminChatId;
    const current = () => input.panels.find(chatId);
    const eligible = () => {
      const panel = current();
      return input.enabled && chatId === input.adminChatId && panel?.template === widgetTemplate &&
        panel.revision === delivery.revision && panel.messageId === (delivery.messageId ?? null);
    };
    const method = delivery.messageId === undefined ? "sendWidget" : "editMessageWidgetData";
    const cancel = () => { input.responses.cancel(row.id, now()); };
    if (!eligible()) return cancel();
    const data = snapshotDesk(current()!.screen, delivery.revision).data;
    const acknowledge = (messageId: number) => {
      input.responses.markSentWithAcknowledgement(row.id, claim, messageId, now(), () =>
        input.panels.acknowledge(chatId, delivery.revision, messageId, delivery.messageId));
    };
    const beforeDispatch = () => {
      if (!eligible() || !input.responses.markRequestStarted(row.id, claim, now())) {
        cancel();
        throw new TelegramLocalDeferralError("cancelled", now(), "Desk widget delivery was superseded");
      }
    };

    try {
      const result = await withTelegramMutationScope({ family: "admin_response", priority: "admin", operationId: row.id, beforeDispatch },
        () => delivery.messageId === undefined
          ? api.sendWidget({ chat_id: chatId, html: widgetHtml, caption: widgetCaption, allow_queries: true, chat_data: data })
          : api.editMessageWidgetData({ chat_id: chatId, message_id: delivery.messageId, chat_data: data }));
      const id = result === true ? delivery.messageId : result?.message_id;
      if (!Number.isSafeInteger(id) || id! <= 0 || (delivery.messageId !== undefined && id !== delivery.messageId)) {
        input.responses.finishFailed(row.id, claim, "uncertain", "missing_delivery_receipt", "Telegram returned no matching widget message ID");
      } else acknowledge(id!);
    } catch (error) {
      const failure = classifyTelegramError(error, method);
      if (delivery.messageId !== undefined && /message is not modified/i.test(failure.description)) return acknowledge(delivery.messageId);
      if (!eligible()) {
        if (input.responses.find(row.id)?.requestStartedAt === undefined) return cancel();
        input.responses.finishFailed(row.id, claim, "uncertain", "superseded_during_dispatch", "Widget was superseded while Telegram was processing it");
        return;
      }
      if (failure.kind === "rate_limited" || failure.kind === "local_deferral") {
        const next = failure.retryAt ?? now() + (failure.retryAfterSeconds ?? 1) * 1_000;
        input.responses.retry(row.id, claim, Math.max(now() + 1_000, next), failure.kind, "Widget delivery deferred");
        return;
      }
      const unknown = ["transient_network", "transient_server", "ambiguous_send_result"].includes(failure.kind);
      if (unknown && delivery.messageId !== undefined && row.attemptCount < 3) {
        input.responses.retry(row.id, claim, now() + 2_000, failure.kind, "Reconciling widget state");
        return;
      }
      if (delivery.messageId !== undefined && (failure.kind === "source_missing" || /message can.t be edited/i.test(failure.description))) {
        input.panels.retire(chatId, delivery.messageId);
      }
      input.responses.finishFailed(row.id, claim, unknown ? "uncertain" : "failed", failure.kind, "Widget delivery failed");
      if (!unknown) input.responses.enqueue({
        dedupeKey: `widget:${row.id}:fallback`, adminChatId: chatId, kind: "warning", now: now(),
        descriptor: { version: 1, text: "Telegram could not update the Desk widget. Use /manage to reopen it or /manage classic for the text menu." },
      });
    }
  };
};

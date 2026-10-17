import type { AdminRepository } from "../db/admin-repository";
import type { AlertRepository } from "../db/alert-repository";
import type { GeneratedMessageRepository, QueueRepository } from "../db/repositories";
import type { PendingUpdateRepository } from "../db/pending-update-repository";
import type { createGeneratedEventRepository } from "../db/generated-event-repository";
import type { Clock } from "../types";
import type { Logger } from "../logger";
import type { AdminResponseRepository } from "../db/admin-response-repository";
import type { AdminUpdateRepository } from "../db/admin-update-repository";
import type { TelegramIncidentRepository } from "../db/telegram-incident-repository";

export type RetentionService = ReturnType<typeof createRetentionService>;

export const createRetentionService = (input: {
  queue: QueueRepository;
  generated: GeneratedMessageRepository;
  generatedEvents?: ReturnType<typeof createGeneratedEventRepository>;
  pending: PendingUpdateRepository;
  admin: AdminRepository;
  alerts: AlertRepository;
  clock: Clock;
  logger: Logger;
  responses?: AdminResponseRepository;
  adminUpdates?: AdminUpdateRepository;
  incidents?: TelegramIncidentRepository;
}) => {
  const runOnce = (): { redactedItems: number; redactedMessages: number; purgedResponses: number; purgedAdminUpdates: number; purgedIncidents: number } => {
    const now = input.clock.now();
    const result = input.queue.redactCompletedBefore(now - 30 * 86_400_000, now);
    input.generated.purge(now - 7 * 86_400_000);
    input.generatedEvents?.purge(now - 7 * 86_400_000);
    input.pending.purge(now - 7 * 86_400_000);
    input.admin.purgeExpiredTokensAndPrompts(now);
    input.alerts.purgeResolved(now - 90 * 86_400_000);
    const purgedResponses = input.responses?.purgeTerminal(now - 90 * 86_400_000) ?? 0;
    const purgedAdminUpdates = input.adminUpdates?.purgeTerminal(now - 90 * 86_400_000) ?? 0;
    const purgedIncidents = input.incidents?.purgeResolved(now - 90 * 86_400_000) ?? 0;
    input.admin.purgeAuditEvents(now - 90 * 86_400_000);
    input.logger.info("retention_completed", { redactedItems: result.items, redactedMessages: result.messages, purgedResponses, purgedAdminUpdates, purgedIncidents });
    return { redactedItems: result.items, redactedMessages: result.messages, purgedResponses, purgedAdminUpdates, purgedIncidents };
  };
  return { runOnce };
};

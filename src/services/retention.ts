import type { AdminRepository } from "../db/admin-repository";
import type { AlertRepository } from "../db/alert-repository";
import type { GeneratedMessageRepository, QueueRepository } from "../db/repositories";
import type { Clock } from "../types";
import type { Logger } from "../logger";

export type RetentionService = ReturnType<typeof createRetentionService>;

export const createRetentionService = (input: {
  queue: QueueRepository;
  generated: GeneratedMessageRepository;
  admin: AdminRepository;
  alerts: AlertRepository;
  clock: Clock;
  logger: Logger;
}) => {
  const runOnce = (): { redactedItems: number; redactedMessages: number } => {
    const now = input.clock.now();
    const result = input.queue.redactCompletedBefore(now - 30 * 86_400_000, now);
    input.generated.purge(now - 7 * 86_400_000);
    input.admin.purgeExpiredTokensAndPrompts(now);
    input.alerts.purgeResolved(now - 90 * 86_400_000);
    input.logger.info("retention_completed", { redactedItems: result.items, redactedMessages: result.messages });
    return { redactedItems: result.items, redactedMessages: result.messages };
  };
  return { runOnce };
};

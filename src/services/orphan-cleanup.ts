import { classifyTelegramError } from "../errors";
import type { OrphanRepository, OrphanSource } from "../db/orphan-repository";
import type { Clock } from "../types";
import type { TelegramGateway } from "../telegram";
import type { Logger } from "../logger";

export type OrphanCleanupService = ReturnType<typeof createOrphanCleanupService>;

export const createOrphanCleanupService = (input: {
  orphan: OrphanRepository;
  gateway: TelegramGateway;
  clock: Clock;
  logger: Logger;
  onPermissionAlert?: (orphan: OrphanSource) => Promise<void>;
}) => {
  const nextAttempt = (now: number, attemptCount: number): number => now + Math.min(6 * 60 * 60_000, Math.max(60_000, 60_000 * (2 ** Math.min(attemptCount, 8))));

  const runOnce = async (): Promise<{ attempted: number; resolved: number; terminal: number }> => {
    const now = input.clock.now();
    const due = input.orphan.due(now);
    const groups = new Map<string, OrphanSource[]>();
    for (const orphan of due) {
      const key = `${orphan.chatId}:${orphan.itemId}:${orphan.sourceGeneration}`;
      const group = groups.get(key) ?? [];
      if (group.length < 100) group.push(orphan);
      groups.set(key, group);
    }
    let resolved = 0;
    let terminal = 0;
    for (const group of groups.values()) {
      const first = group[0]!;
      try {
        await input.gateway.deleteMessages(first.chatId as never, group.map((orphan) => orphan.messageId) as never);
        for (const orphan of group) {
          input.orphan.resolve(orphan, input.clock.now());
          resolved += 1;
        }
      } catch (error) {
        const normalized = classifyTelegramError(error);
        for (const orphan of group) {
          if (normalized.kind === "source_missing") {
            input.orphan.resolve(orphan, input.clock.now());
            resolved += 1;
          } else if (normalized.kind === "telegram_age_limit") {
            input.orphan.markTerminal(orphan, input.clock.now(), "telegram_age_limit");
            terminal += 1;
          } else {
            const attemptNow = input.clock.now();
            const retryAt = normalized.kind === "permission_denied" ? attemptNow + 6 * 60 * 60_000 : nextAttempt(attemptNow, orphan.attemptCount);
            input.orphan.markAttempt(orphan, attemptNow, retryAt);
            if (normalized.kind === "permission_denied") {
              try { await input.onPermissionAlert?.(orphan); }
              catch (alertError) { input.logger.error("orphan_permission_alert_failed", { error: alertError instanceof Error ? alertError.message : "unknown" }); }
            }
          }
        }
        input.logger.warn("orphan_cleanup_failed", { itemId: first.itemId, generation: first.sourceGeneration, count: group.length, error: normalized.kind });
      }
    }
    return { attempted: due.length, resolved, terminal };
  };

  return { runOnce };
};

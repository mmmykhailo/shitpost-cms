import { randomUUID } from "node:crypto";
import { validateOrderedMessageIds } from "../domain/validation";
import { RENEWAL_ITEM_RETRY_MS } from "../domain/renewal-policy";
import { classifyTelegramError } from "../errors";
import type { QueueRepository, PolicyRepository, GeneratedMessageRepository } from "../db/repositories";
import type { Logger } from "../logger";
import type { ChatId, Clock, MessageId, NormalizedTelegramError, OperationGuard, StoredMessageSnapshot } from "../types";
import type { TelegramGateway } from "../telegram";
import type { TelegramCooldown } from "../telegram-cooldown";
import type { OperationTracker } from "./task-supervisor";

export type RenewalOutcome =
  | { kind: "nothing_due" }
  | { kind: "renewed"; itemId: number; generation: number }
  | { kind: "cleanup_pending"; itemId: number; operationId: string }
  | { kind: "deleted_external"; itemId: number }
  | { kind: "uncertain"; itemId: number; operationId: string }
  | { kind: "retry_scheduled"; itemId: number; retryAt: number }
  | { kind: "blocked"; itemId: number; reason: string };

export type RenewalService = ReturnType<typeof createRenewalService>;

export const createRenewalService = (input: {
  queue: QueueRepository;
  policy: PolicyRepository;
  generated: GeneratedMessageRepository;
  gateway: TelegramGateway;
  queueChannelId: ChatId;
  clock: Clock;
  logger: Logger;
  cooldown?: TelegramCooldown;
  operationId?: () => string;
  operationTracker?: OperationTracker;
}) => {
  const newOperationId = input.operationId ?? randomUUID;

  const tracked = async <T>(operationId: string, work: () => Promise<T>): Promise<T> => {
    const finish = input.operationTracker?.begin(operationId);
    try { return await work(); }
    finally { finish?.(); }
  };

  const replacementSnapshots = (snapshots: readonly StoredMessageSnapshot[], messageIds: readonly MessageId[], now: number): StoredMessageSnapshot[] => {
    if (snapshots.length !== messageIds.length) throw new Error("Renewal output count does not match source count");
    return snapshots.map((snapshot, ordinal) => {
      const { editDate: _editDate, ...withoutEditDate } = snapshot;
      return { ...withoutEditDate, messageId: messageIds[ordinal]!, ordinal, telegramDate: now };
    });
  };

  const guardFor = (claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>): OperationGuard => ({
    operationId: claimed.operationId,
    itemId: claimed.item.id,
    capturedContentVersion: claimed.capturedContentVersion,
    capturedSourceGeneration: claimed.capturedSourceGeneration,
  });

  const handleError = (claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>, error: NormalizedTelegramError): RenewalOutcome => {
    const now = input.clock.now();
    if (error.kind === "source_missing") {
      input.queue.markMissing(claimed.item.id, claimed.operationId, now);
      return { kind: "deleted_external", itemId: claimed.item.id };
    }
    if (error.kind === "rate_limited") {
      const retryAt = input.cooldown?.extendForRetryAfter(error.retryAfterSeconds, now)
        ?? now + Math.ceil(Math.max(1, error.retryAfterSeconds ?? 60) * 1000);
      input.queue.setRetry(claimed.item.id, claimed.operationId, now, retryAt, error.kind, error.description);
      return { kind: "retry_scheduled", itemId: claimed.item.id, retryAt };
    }
    if (error.kind === "ambiguous_send_result" || error.kind === "transient_network" || error.kind === "transient_server") {
      input.queue.setRenewalUncertain(claimed.item.id, claimed.operationId, now, error.kind, error.description);
      return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
    }
    // Renewal is physical maintenance. A definite rejection must not alter the
    // logical publication status captured at claim time.
    input.queue.setRetry(claimed.item.id, claimed.operationId, now, now + RENEWAL_ITEM_RETRY_MS, error.kind, error.description);
    return { kind: "blocked", itemId: claimed.item.id, reason: error.kind };
  };

  const cleanupOldGeneration = async (
    claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>,
    oldSourceIds: readonly MessageId[],
    generation: number,
  ): Promise<RenewalOutcome> => {
    const guard = guardFor(claimed);
    input.queue.setOperationPhase(claimed.operationId, "old_source_cleanup_pending", input.clock.now());
    try {
      await input.gateway.deleteMessages(input.queueChannelId, oldSourceIds);
      input.queue.completeRenewalWithOrphans(guard, [], input.clock.now());
      return { kind: "renewed", itemId: claimed.item.id, generation };
    } catch (error) {
      const normalized = classifyTelegramError(error);
      if (normalized.kind === "source_missing") {
        input.queue.completeRenewalWithOrphans(guard, [], input.clock.now());
        return { kind: "renewed", itemId: claimed.item.id, generation };
      }
      if (normalized.kind === "rate_limited") input.cooldown?.extendForRetryAfter(normalized.retryAfterSeconds, input.clock.now());
      // The replacement generation is already durable. Keep it current and
      // make each old ID independently retryable instead of wedging the item.
      input.queue.completeRenewalWithOrphans(guard, oldSourceIds, input.clock.now(), normalized.kind === "permission_denied" ? "permission_denied" : normalized.kind);
      input.logger.warn("old_renewal_generation_orphaned", { itemId: claimed.item.id, generation: claimed.capturedSourceGeneration, count: oldSourceIds.length, error: normalized.kind });
      return { kind: "renewed", itemId: claimed.item.id, generation };
    }
  };

  const renewClaimed = async (claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>): Promise<RenewalOutcome> => {
    const guard = guardFor(claimed);
    const now = input.clock.now();
    const oldSourceIds = input.queue.getMessages(claimed.item.id, claimed.capturedSourceGeneration).map((message) => message.telegramMessageId);
    if (oldSourceIds.length === 0) {
      input.queue.markMissing(claimed.item.id, claimed.operationId, now);
      return { kind: "deleted_external", itemId: claimed.item.id };
    }
    const snapshots = input.queue.getMessages(claimed.item.id, claimed.capturedSourceGeneration).map((message) => message.snapshot);
    input.queue.setOperationPhase(claimed.operationId, "replacement_pending", now);
    try {
      const transferInput = { targetChatId: input.queueChannelId, sourceChatId: input.queueChannelId, messageIds: oldSourceIds, disableNotification: true };
      const replacementIds = claimed.item.origin.kind === "absent"
        ? await input.gateway.copyMessages(transferInput)
        : await input.gateway.forwardMessages(transferInput);

      let validatedReplacementIds: MessageId[] | undefined;
      let validationError: unknown;
      try { validatedReplacementIds = validateOrderedMessageIds(replacementIds, "renewal replacement IDs"); }
      catch (error) { validationError = error; }

      // Persist every known result before doing any state transition. The
      // ingestion layer also treats these IDs as candidates if Telegram emits
      // the channel update before this process sees the response.
      const recordedIds = new Set<number>();
      for (const [ordinal, messageId] of replacementIds.entries()) {
        if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0 || recordedIds.has(messageId)) continue;
        try {
          input.queue.recordReplacementOutput(claimed.operationId, input.queueChannelId, messageId, ordinal, input.clock.now());
          recordedIds.add(messageId);
        } catch (error) {
          const description = `Replacement output ${messageId} could not be safely recorded: ${error instanceof Error ? error.message : "unknown storage error"}`;
          input.queue.setRenewalUncertain(claimed.item.id, claimed.operationId, input.clock.now(), "ambiguous_send_result", description);
          return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
        }
      }

      if (replacementIds.length !== oldSourceIds.length) {
        const description = `Incomplete replacement: expected ${oldSourceIds.length} messages but received ${replacementIds.length}; known replacement IDs: ${[...recordedIds].join(", ") || "none"}. Originals remain current pending review.`;
        input.queue.setRenewalUncertain(claimed.item.id, claimed.operationId, input.clock.now(), "partial_replacement", description);
        return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
      }
      if (validatedReplacementIds === undefined) {
        const description = validationError instanceof Error ? validationError.message : "Replacement message IDs were invalid or out of order";
        input.queue.setRenewalUncertain(claimed.item.id, claimed.operationId, input.clock.now(), "ambiguous_send_result", description);
        return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
      }

      input.queue.markReplacementOutputsRecorded(guard, input.clock.now());
      const nextSnapshots = replacementSnapshots(snapshots, validatedReplacementIds, input.clock.now());
      const generation = input.queue.installRenewedGeneration(guard, nextSnapshots, input.clock.now());
      return cleanupOldGeneration(claimed, oldSourceIds, generation);
    } catch (error) {
      return handleError(claimed, classifyTelegramError(error));
    }
  };

  const renewClaimedTracked = async (claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>): Promise<RenewalOutcome> => tracked(claimed.operationId, () => renewClaimed(claimed));

  const renewNextAttempt = async (minimumAgeMs: number): Promise<{ outcome: RenewalOutcome; sourceCount: number }> => {
    const now = input.clock.now();
    const claimed = input.queue.claimRenewal(newOperationId(), now, now - minimumAgeMs);
    if (!claimed) return { outcome: { kind: "nothing_due" }, sourceCount: 0 };
    const sourceCount = input.queue.getMessages(claimed.item.id, claimed.capturedSourceGeneration).length;
    return { outcome: await renewClaimedTracked(claimed), sourceCount };
  };

  const renewNext = async (minimumAgeMs: number): Promise<RenewalOutcome> => (await renewNextAttempt(minimumAgeMs)).outcome;

  const cleanupPending = async (itemId: number): Promise<RenewalOutcome> => {
    const item = input.queue.findItemById(itemId);
    const operation = input.queue.operationForItem(itemId);
    if (!item || !operation || item.maintenanceStatus !== "renewal_cleanup_pending" || item.sourceGeneration < 1) return { kind: "blocked", itemId, reason: "renewal_cleanup_not_pending" };
    return tracked(operation.id, async () => {
      const oldSourceIds = input.queue.getMessages(itemId, operation.capturedSourceGeneration).map((message) => message.telegramMessageId);
      return cleanupOldGeneration({
        item: { ...item, maintenanceStatus: "renewing" },
        operationId: operation.id,
        capturedContentVersion: operation.capturedContentVersion,
        capturedSourceGeneration: operation.capturedSourceGeneration,
      }, oldSourceIds, item.sourceGeneration);
    });
  };

  return { renewNext, renewNextAttempt, renewClaimed, cleanupPending };
};

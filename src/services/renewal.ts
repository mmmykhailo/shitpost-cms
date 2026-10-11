import { randomUUID } from "node:crypto";
import { classifyTelegramError } from "../errors";
import type { QueueRepository, PolicyRepository, GeneratedMessageRepository } from "../db/repositories";
import type { Logger } from "../logger";
import type { ChatId, Clock, MessageId, NormalizedTelegramError, StoredMessageSnapshot } from "../types";
import type { TelegramGateway } from "../telegram";

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
  operationId?: () => string;
}) => {
  const newOperationId = input.operationId ?? randomUUID;

  const replacementSnapshots = (snapshots: readonly StoredMessageSnapshot[], messageIds: readonly MessageId[], now: number): StoredMessageSnapshot[] => {
    if (snapshots.length !== messageIds.length) throw new Error("Renewal output count does not match source count");
    return snapshots.map((snapshot, ordinal) => {
      const { editDate: _editDate, ...withoutEditDate } = snapshot;
      return { ...withoutEditDate, messageId: messageIds[ordinal]!, ordinal, telegramDate: now };
    });
  };

  const handleError = (claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>, error: NormalizedTelegramError): RenewalOutcome => {
    const now = input.clock.now();
    if (error.kind === "source_missing") {
      input.queue.markMissing(claimed.item.id, claimed.operationId, now);
      return { kind: "deleted_external", itemId: claimed.item.id };
    }
    if (error.kind === "rate_limited") {
      const retryAt = now + Math.min((error.retryAfterSeconds ?? 60) * 1000 + Math.floor(Math.random() * 500), 300_000);
      input.queue.setRetry(claimed.item.id, claimed.operationId, now, retryAt, error.kind, error.description);
      return { kind: "retry_scheduled", itemId: claimed.item.id, retryAt };
    }
    if (error.kind === "ambiguous_send_result" || error.kind === "transient_network" || error.kind === "transient_server") {
      input.queue.transition(claimed.item.id, "renewing", "uncertain_renewal", now, error.kind, error.description);
      input.queue.setOperationState(claimed.operationId, "uncertain", now, error.kind, JSON.stringify({ description: error.description }));
      return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
    }
    input.queue.transition(claimed.item.id, "renewing", "blocked", now, error.kind, error.description);
    input.queue.setOperationState(claimed.operationId, "failed", now, error.kind, error.description);
    return { kind: "blocked", itemId: claimed.item.id, reason: error.kind };
  };

  const cleanupOldGeneration = async (itemId: number, operationId: string, oldSourceIds: readonly MessageId[]): Promise<RenewalOutcome> => {
    try {
      await input.gateway.deleteMessages(input.queueChannelId, oldSourceIds);
      input.queue.markRenewedCleanupComplete(itemId, operationId, input.clock.now());
      return { kind: "renewed", itemId, generation: input.queue.findItemById(itemId)?.sourceGeneration ?? 0 };
    } catch (error) {
      const normalized = classifyTelegramError(error);
      if (normalized.kind === "source_missing") {
        input.queue.markRenewedCleanupComplete(itemId, operationId, input.clock.now());
        return { kind: "renewed", itemId, generation: input.queue.findItemById(itemId)?.sourceGeneration ?? 0 };
      }
      input.queue.setOperationState(operationId, "cleanup_pending", input.clock.now(), normalized.kind, normalized.description);
      return { kind: "cleanup_pending", itemId, operationId };
    }
  };

  const renewClaimed = async (claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>): Promise<RenewalOutcome> => {
    const now = input.clock.now();
    const oldSourceIds = input.queue.currentSourceIds(claimed.item.id);
    if (oldSourceIds.length === 0) {
      input.queue.markMissing(claimed.item.id, claimed.operationId, now);
      return { kind: "deleted_external", itemId: claimed.item.id };
    }
    const snapshots = input.queue.getCurrentSnapshotSet(claimed.item.id);
    try {
      const inputTransfer = { targetChatId: input.queueChannelId, sourceChatId: input.queueChannelId, messageIds: oldSourceIds, disableNotification: true };
      const replacementIds = claimed.item.origin.kind === "absent"
        ? await input.gateway.copyMessages(inputTransfer)
        : await input.gateway.forwardMessages(inputTransfer);
      if (replacementIds.length !== oldSourceIds.length) {
        try { await input.gateway.deleteMessages(input.queueChannelId, replacementIds); }
        catch (cleanupError) { input.logger.error("partial_renewal_cleanup_failed", { itemId: claimed.item.id, error: classifyTelegramError(cleanupError).kind }); }
        input.queue.transition(claimed.item.id, "renewing", "needs_review", input.clock.now(), "partial_result", "Telegram returned fewer renewal messages than source messages");
        input.queue.setOperationState(claimed.operationId, "failed", input.clock.now(), "partial_result");
        return { kind: "blocked", itemId: claimed.item.id, reason: "partial_result" };
      }
      input.generated.register(input.queueChannelId, replacementIds, claimed.operationId, "renewal", now);
      const nextSnapshots = replacementSnapshots(snapshots, replacementIds, now);
      const generation = input.queue.installRenewedGeneration(claimed.item.id, claimed.operationId, nextSnapshots, now);
      const cleanupResult = await cleanupOldGeneration(claimed.item.id, claimed.operationId, oldSourceIds);
      if (cleanupResult.kind === "renewed") return { kind: "renewed", itemId: claimed.item.id, generation };
      return cleanupResult;
    } catch (error) {
      return handleError(claimed, classifyTelegramError(error));
    }
  };

  const renewNext = async (minimumAgeMs: number): Promise<RenewalOutcome> => {
    const now = input.clock.now();
    const claimed = input.queue.claimRenewal(newOperationId(), now, now - minimumAgeMs);
    if (!claimed) return { kind: "nothing_due" };
    return renewClaimed(claimed);
  };

  const cleanupPending = async (itemId: number): Promise<RenewalOutcome> => {
    const item = input.queue.findItemById(itemId);
    const operation = input.queue.operationForItem(itemId);
    if (!item || !operation || item.status !== "renewed_cleanup_pending" || item.sourceGeneration < 1) return { kind: "blocked", itemId, reason: "renewal_cleanup_not_pending" };
    const oldSourceIds = input.queue.getMessages(itemId, item.sourceGeneration - 1).map((message) => message.telegramMessageId);
    return cleanupOldGeneration(itemId, operation.id, oldSourceIds);
  };

  return { renewNext, renewClaimed, cleanupPending };
};

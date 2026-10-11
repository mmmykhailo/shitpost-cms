import { randomUUID } from "node:crypto";
import { appendInlineByline, CAPTION_LIMIT, TEXT_LIMIT } from "../domain/byline";
import { classifyPublicationPlan } from "../domain/origin-policy";
import type { QueueRepository, PolicyRepository } from "../db/repositories";
import type { Logger } from "../logger";
import { classifyTelegramError, isRetryable } from "../errors";
import type { Clock, MessageId, NormalizedTelegramError, StoredMessageSnapshot } from "../types";
import type { ChatId } from "../types";
import type { TelegramGateway } from "../telegram";

export type PublicationOutcome =
  | { kind: "empty" }
  | { kind: "blocked"; itemId: number; status: string; reason: string }
  | { kind: "published"; itemId: number; destinationMessageIds: MessageId[] }
  | { kind: "cleanup_pending"; itemId: number; operationId: string }
  | { kind: "retry_scheduled"; itemId: number; retryAt: number }
  | { kind: "uncertain"; itemId: number; operationId: string }
  | { kind: "deleted_external"; itemId: number }
  | { kind: "failed"; itemId: number; status: string; error: string };

const outputIdsFromTransfer = (ids: readonly MessageId[]): MessageId[] => ids.map((id) => id);

const retryAtFor = (error: NormalizedTelegramError, now: number): number => {
  if (error.kind === "rate_limited" && error.retryAfterSeconds !== undefined) return now + Math.min(error.retryAfterSeconds * 1000 + Math.floor(Math.random() * 500), 300_000);
  return now + 60_000;
};

const classifyPlanError = (error: NormalizedTelegramError): "blocked" | "needs_edit" =>
  error.kind === "invalid_content_or_entities" ? "needs_edit" : "blocked";

export type PublicationService = ReturnType<typeof createPublicationService>;

export const createPublicationService = (input: {
  queue: QueueRepository;
  policy: PolicyRepository;
  gateway: TelegramGateway;
  queueChannelId: ChatId;
  targetChannelId: ChatId;
  clock: Clock;
  logger: Logger;
  operationId?: () => string;
}) => {
  const newOperationId = input.operationId ?? randomUUID;

  const cleanupDestination = async (ids: readonly MessageId[]): Promise<boolean> => {
    if (ids.length === 0) return true;
    try {
      await input.gateway.deleteMessages(input.targetChannelId, ids);
      return true;
    } catch (error) {
      input.logger.error("destination_partial_cleanup_failed", { error: classifyTelegramError(error).kind, count: ids.length });
      return false;
    }
  };

  const failClaim = async (claimed: Parameters<QueueRepository["claimPublication"]>[0] extends never ? never : NonNullable<ReturnType<QueueRepository["claimPublication"]>>, error: NormalizedTelegramError): Promise<PublicationOutcome> => {
    const now = input.clock.now();
    if (error.kind === "source_missing") {
      input.queue.markMissing(claimed.item.id, claimed.operationId, now);
      return { kind: "deleted_external", itemId: claimed.item.id };
    }
    if (error.kind === "rate_limited") {
      const retryAt = retryAtFor(error, now);
      input.queue.setRetry(claimed.item.id, claimed.operationId, now, retryAt, error.kind, error.description);
      return { kind: "retry_scheduled", itemId: claimed.item.id, retryAt };
    }
    if (error.kind === "ambiguous_send_result" || error.kind === "transient_network" || error.kind === "transient_server") {
      input.queue.transition(claimed.item.id, "publishing", "uncertain_publish", now, error.kind, error.description);
      input.queue.setOperationState(claimed.operationId, "uncertain", now, error.kind, JSON.stringify({ description: error.description }));
      return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
    }
    const status = classifyPlanError(error);
    input.queue.transition(claimed.item.id, "publishing", status, now, error.kind, error.description);
    input.queue.setOperationState(claimed.operationId, "failed", now, error.kind, JSON.stringify({ description: error.description }));
    return { kind: "failed", itemId: claimed.item.id, status, error: error.description };
  };

  const editInlineByline = async (snapshots: readonly StoredMessageSnapshot[], destinationIds: readonly MessageId[], name: string): Promise<void> => {
    if (snapshots.length !== destinationIds.length) throw new Error("Destination count does not match snapshots");
    const captionMembers = snapshots.filter((snapshot) => snapshot.caption !== undefined && snapshot.caption.length > 0);
    if (snapshots.length > 1 && captionMembers.length > 1) throw new Error("Album has multiple caption-bearing members");
    if (snapshots.length === 1 && snapshots[0]?.contentType === "text") {
      const snapshot = snapshots[0]!;
      const result = appendInlineByline(snapshot.text, name, TEXT_LIMIT, snapshot.entities);
      const editInput = { chatId: input.targetChannelId, messageId: destinationIds[0]!, text: result.text } as Parameters<TelegramGateway["editText"]>[0];
      if (result.entities !== undefined) editInput.entities = result.entities;
      await input.gateway.editText(editInput);
      return;
    }
    const targetIndex = captionMembers.length > 0 ? snapshots.indexOf(captionMembers[0]!) : 0;
    const snapshot = snapshots[targetIndex]!;
    const result = appendInlineByline(snapshot.caption, name, CAPTION_LIMIT, snapshot.captionEntities);
    const editInput = { chatId: input.targetChannelId, messageId: destinationIds[targetIndex]!, caption: result.text } as Parameters<TelegramGateway["editCaption"]>[0];
    if (result.entities !== undefined) editInput.captionEntities = result.entities;
    if (snapshot.showCaptionAboveMedia !== undefined) editInput.showCaptionAboveMedia = snapshot.showCaptionAboveMedia;
    await input.gateway.editCaption(editInput);
  };

  const publishClaimed = async (claimed: NonNullable<ReturnType<QueueRepository["claimPublication"]>>): Promise<PublicationOutcome> => {
    const now = input.clock.now();
    const snapshots = input.queue.getCurrentSnapshotSet(claimed.item.id);
    const policyInput = {
      origin: claimed.item.origin,
      contentType: claimed.item.contentType,
      channelIsWhitelisted: claimed.item.origin.kind === "channel" && input.policy.isChannelWhitelisted(claimed.item.origin.chatId),
    } as Parameters<typeof classifyPublicationPlan>[0];
    const alias = input.policy.aliasForOrigin(claimed.item.origin);
    if (alias !== undefined) policyInput.alias = alias;
    const plan = classifyPublicationPlan(policyInput);
    if (plan.kind === "blocked") {
      input.queue.transition(claimed.item.id, "publishing", plan.reason === "unsupported_content" ? "blocked" : "needs_review", now, plan.reason, plan.reason);
      input.queue.setOperationState(claimed.operationId, "failed", now, plan.reason);
      return { kind: "blocked", itemId: claimed.item.id, status: plan.reason === "unsupported_content" ? "blocked" : "needs_review", reason: plan.reason };
    }
    if ((plan.kind === "copy_with_inline_byline" || plan.kind === "copy_with_separate_byline") && snapshots.some((snapshot) => snapshot.contentType === "unknown" || snapshot.contentType === "service")) {
      input.queue.transition(claimed.item.id, "publishing", "blocked", now, "unsupported_content", "Unsupported content type");
      input.queue.setOperationState(claimed.operationId, "failed", now, "unsupported_content");
      return { kind: "blocked", itemId: claimed.item.id, status: "blocked", reason: "unsupported_content" };
    }
    const sourceIds = input.queue.currentSourceIds(claimed.item.id);
    let destinationIds: MessageId[] = [];
    try {
      const transferInput = { targetChatId: input.targetChannelId, sourceChatId: input.queueChannelId, messageIds: sourceIds };
      const transferResult = plan.kind === "forward" ? await input.gateway.forwardMessages(transferInput) : await input.gateway.copyMessages(transferInput);
      destinationIds = outputIdsFromTransfer(transferResult);
      for (const [ordinal, id] of destinationIds.entries()) input.queue.recordOutput(claimed.operationId, "destination", input.targetChannelId, id, ordinal, now);
      if (destinationIds.length !== sourceIds.length) {
        const cleaned = await cleanupDestination(destinationIds);
        if (!cleaned) {
          input.queue.transition(claimed.item.id, "publishing", "uncertain_publish", input.clock.now(), "partial_output_cleanup", "Telegram returned a partial album result and cleanup failed");
          input.queue.setOperationState(claimed.operationId, "uncertain", input.clock.now(), "partial_output_cleanup");
          return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
        }
        input.queue.transition(claimed.item.id, "publishing", "needs_review", input.clock.now(), "partial_result", "Telegram returned fewer destination messages than source messages");
        input.queue.setOperationState(claimed.operationId, "failed", input.clock.now(), "partial_result");
        return { kind: "blocked", itemId: claimed.item.id, status: "needs_review", reason: "partial_result" };
      }
      if (plan.kind === "copy_with_inline_byline") {
        await editInlineByline(snapshots, destinationIds, plan.name);
      } else if (plan.kind === "copy_with_separate_byline") {
        const bylineId = await input.gateway.sendText({ chatId: input.targetChannelId, text: `by ${plan.name}` });
        input.queue.recordOutput(claimed.operationId, "destination", input.targetChannelId, bylineId, destinationIds.length, input.clock.now());
        destinationIds = [...destinationIds, bylineId];
      }
      input.queue.setDestinationMessageIds(claimed.item.id, claimed.operationId, destinationIds, input.clock.now());
    } catch (error) {
      const normalized = classifyTelegramError(error);
      if (destinationIds.length > 0 && normalized.kind !== "ambiguous_send_result") {
        const cleaned = await cleanupDestination(destinationIds);
        if (!cleaned) {
          input.queue.transition(claimed.item.id, "publishing", "uncertain_publish", input.clock.now(), "partial_output_cleanup", normalized.description);
          input.queue.setOperationState(claimed.operationId, "uncertain", input.clock.now(), "partial_output_cleanup");
          return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
        }
      }
      return failClaim(claimed, normalized);
    }
    try {
      await input.gateway.deleteMessages(input.queueChannelId, sourceIds);
      input.queue.markCompleted(claimed.item.id, claimed.operationId, input.clock.now());
      return { kind: "published", itemId: claimed.item.id, destinationMessageIds: destinationIds };
    } catch (error) {
      const normalized = classifyTelegramError(error);
      if (normalized.kind === "source_missing") {
        input.queue.markMissing(claimed.item.id, claimed.operationId, input.clock.now());
        return { kind: "deleted_external", itemId: claimed.item.id };
      }
      input.queue.setOperationState(claimed.operationId, "cleanup_pending", input.clock.now(), normalized.kind, normalized.description);
      return { kind: "cleanup_pending", itemId: claimed.item.id, operationId: claimed.operationId };
    }
  };

  const cleanupPending = async (itemId: number): Promise<PublicationOutcome> => {
    const operation = input.queue.operationForItem(itemId);
    if (!operation) return { kind: "failed", itemId, status: "published_cleanup_pending", error: "Missing publication operation" };
    const sourceIds = input.queue.currentSourceIds(itemId);
    try {
      await input.gateway.deleteMessages(input.queueChannelId, sourceIds);
      input.queue.markCompleted(itemId, operation.id, input.clock.now());
      return { kind: "published", itemId, destinationMessageIds: input.queue.operationOutputIds(operation.id, "destination") };
    } catch (error) {
      const normalized = classifyTelegramError(error);
      if (normalized.kind === "source_missing") {
        input.queue.markMissing(itemId, operation.id, input.clock.now());
        return { kind: "deleted_external", itemId };
      }
      input.queue.setOperationState(operation.id, "cleanup_pending", input.clock.now(), normalized.kind, normalized.description);
      return { kind: "cleanup_pending", itemId, operationId: operation.id };
    }
  };

  const publishNext = async (type: "publish" | "manual_publish" = "publish"): Promise<PublicationOutcome> => {
    const head = input.queue.getHead();
    if (!head) return { kind: "empty" };
    if (head.status === "published_cleanup_pending") return cleanupPending(head.id);
    if (head.status !== "queued" || (head.retryNotBefore !== undefined && head.retryNotBefore > input.clock.now())) {
      return { kind: "blocked", itemId: head.id, status: head.status, reason: "head_not_ready" };
    }
    const operationId = newOperationId();
    const claimed = input.queue.claimPublication(operationId, type, input.clock.now());
    if (!claimed) return { kind: "blocked", itemId: head.id, status: "claimed_elsewhere", reason: "concurrent_claim" };
    return publishClaimed(claimed);
  };

  return { publishNext, cleanupPending, publishClaimed };
};

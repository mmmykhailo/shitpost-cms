import { randomUUID } from "node:crypto";
import { appendInlineByline, CAPTION_LIMIT, TEXT_LIMIT } from "../domain/byline";
import { classifyPublicationPlan } from "../domain/origin-policy";
import type { QueueRepository, PolicyRepository } from "../db/repositories";
import type { Logger } from "../logger";
import { classifyTelegramError } from "../errors";
import type { Clock, MessageId, NormalizedTelegramError, OperationGuard, PublicationContract, PublicationPlan, QueueItemStatus, StoredMessageSnapshot } from "../types";
import type { TelegramGateway } from "../telegram";
import type { ChatId } from "../types";
import type { OperationTracker } from "./task-supervisor";

export type PublicationOutcome =
  | { kind: "empty" }
  | { kind: "blocked"; itemId: number; status: string; reason: string; operationId?: string }
  | { kind: "published"; itemId: number; destinationMessageIds: MessageId[]; operationId?: string }
  | { kind: "cleanup_pending"; itemId: number; operationId: string }
  | { kind: "retry_scheduled"; itemId: number; retryAt: number; operationId?: string }
  | { kind: "uncertain"; itemId: number; operationId: string }
  | { kind: "deleted_external"; itemId: number; operationId?: string }
  | { kind: "failed"; itemId: number; status: string; error: string; operationId?: string };

type Claimed = NonNullable<ReturnType<QueueRepository["claimPublication"]>>;
type PreparedPublication = {
  snapshots: StoredMessageSnapshot[];
  sourceIds: MessageId[];
  plan: PublicationPlan;
  contract: PublicationContract;
};

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
  operationTracker?: OperationTracker;
}) => {
  const newOperationId = input.operationId ?? randomUUID;

  const tracked = async <T>(operationId: string, work: () => Promise<T>): Promise<T> => {
    const finish = input.operationTracker?.begin(operationId);
    try { return await work(); }
    finally { finish?.(); }
  };

  const logUncertainty = (claimed: Claimed, error: NormalizedTelegramError, context: { phase?: string; expectedOutputCount?: number; knownOutputCount?: number } = {}): void => {
    let evidence: ReturnType<QueueRepository["operationEvidence"]>;
    try { evidence = input.queue.operationEvidence(claimed.item.id); }
    catch { evidence = undefined; }
    input.logger.error("publication_uncertain", {
      itemId: claimed.item.id,
      operationId: claimed.operationId,
      operationPhase: context.phase ?? evidence?.phase,
      expectedOutputCount: context.expectedOutputCount ?? evidence?.expectedOutputCount,
      knownOutputCount: context.knownOutputCount ?? evidence?.knownDestinationIds.length ?? 0,
      errorKind: error.kind,
      telegramMethod: error.method,
    });
  };

  const cleanupDestination = async (ids: readonly MessageId[]): Promise<{ ok: true } | { ok: false; error: NormalizedTelegramError }> => {
    if (ids.length === 0) return { ok: true };
    try {
      await input.gateway.deleteMessages(input.targetChannelId, ids);
      return { ok: true };
    } catch (error) {
      const normalized = classifyTelegramError(error);
      // A destination message that is already absent is a confirmed cleanup.
      if (normalized.kind === "source_missing") return { ok: true };
      input.logger.error("destination_partial_cleanup_failed", { error: normalized.kind, count: ids.length });
      return { ok: false, error: normalized };
    }
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

  const preflightInlineByline = (snapshots: readonly StoredMessageSnapshot[], name: string): void => {
    if (snapshots.length === 0) throw new Error("No source snapshots are available for byline editing");
    const captionMembers = snapshots.filter((snapshot) => snapshot.caption !== undefined && snapshot.caption.length > 0);
    if (snapshots.length > 1 && captionMembers.length > 1) throw new Error("Album has multiple caption-bearing members");
    if (snapshots.length === 1 && snapshots[0]?.contentType === "text") {
      const snapshot = snapshots[0]!;
      appendInlineByline(snapshot.text, name, TEXT_LIMIT, snapshot.entities);
      return;
    }
    const snapshot = captionMembers[0] ?? snapshots[0]!;
    appendInlineByline(snapshot.caption, name, CAPTION_LIMIT, snapshot.captionEntities);
  };

  const prepare = (item: Claimed["item"]): PreparedPublication | { blockedStatus: "blocked" | "needs_edit" | "needs_review"; reason: string } => {
    const snapshots = input.queue.getCurrentSnapshotSet(item.id);
    const sourceIds = input.queue.currentSourceIds(item.id);
    const policyInput = {
      origin: item.origin,
      contentType: item.contentType,
      channelIsWhitelisted: item.origin.kind === "channel" && input.policy.isChannelWhitelisted(item.origin.chatId),
    } as Parameters<typeof classifyPublicationPlan>[0];
    const alias = input.policy.aliasForOrigin(item.origin);
    if (alias !== undefined) policyInput.alias = alias;
    const plan = classifyPublicationPlan(policyInput);
    if (plan.kind === "blocked") return { blockedStatus: plan.reason === "unsupported_content" ? "blocked" : "needs_review", reason: plan.reason };
    if ((plan.kind === "copy_with_inline_byline" || plan.kind === "copy_with_separate_byline") && snapshots.some((snapshot) => snapshot.contentType === "unknown" || snapshot.contentType === "service")) {
      return { blockedStatus: "blocked", reason: "unsupported_content" };
    }
    if (plan.kind === "copy_with_inline_byline") {
      try {
        preflightInlineByline(snapshots, plan.name);
      } catch (error) {
        const description = error instanceof Error ? error.message : "Album caption requires review";
        return { blockedStatus: description.includes("multiple caption") ? "needs_review" : "needs_edit", reason: description };
      }
    }
    const requiresSeparateByline = plan.kind === "copy_with_separate_byline";
    const contract: PublicationContract = {
      capturedLogicalStatus: item.status,
      capturedContentVersion: item.contentVersion,
      capturedSourceGeneration: item.sourceGeneration,
      sourceIds,
      policy: plan,
      expectedTransferredMessageCount: sourceIds.length,
      expectedOutputMessageCount: sourceIds.length + (requiresSeparateByline ? 1 : 0),
      requiresInlineEdit: plan.kind === "copy_with_inline_byline",
      requiresSeparateByline,
    };
    if (plan.kind === "copy_with_inline_byline" || plan.kind === "copy_with_separate_byline") contract.bylineText = `by ${plan.name}`;
    return { snapshots, sourceIds, plan, contract };
  };

  const guardFor = (claimed: Claimed): OperationGuard => ({
    operationId: claimed.operationId,
    itemId: claimed.item.id,
    capturedContentVersion: claimed.capturedContentVersion,
    capturedSourceGeneration: claimed.capturedSourceGeneration,
  });

  const failClaim = async (claimed: Claimed, error: NormalizedTelegramError, context: { expectedOutputCount?: number; knownOutputCount?: number } = {}): Promise<PublicationOutcome> => {
    const now = input.clock.now();
    if (error.kind === "source_missing") {
      input.queue.markMissing(claimed.item.id, claimed.operationId, now);
      return { kind: "deleted_external", itemId: claimed.item.id, operationId: claimed.operationId };
    }
    if (error.kind === "rate_limited") {
      const retryAt = retryAtFor(error, now);
      input.queue.setRetry(claimed.item.id, claimed.operationId, now, retryAt, error.kind, error.description);
      return { kind: "retry_scheduled", itemId: claimed.item.id, retryAt, operationId: claimed.operationId };
    }
    if (error.kind === "ambiguous_send_result" || error.kind === "transient_network" || error.kind === "transient_server") {
      input.queue.transition(claimed.item.id, "publishing", "uncertain_publish", now, error.kind, error.description);
      input.queue.setOperationState(claimed.operationId, "uncertain", now, error.kind, JSON.stringify({ description: error.description }));
      input.queue.setOperationPhase(claimed.operationId, "uncertain", now, error.kind, JSON.stringify({ description: error.description }));
      logUncertainty(claimed, error, { ...context, phase: "uncertain" });
      return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
    }
    const status = classifyPlanError(error);
    input.queue.transition(claimed.item.id, "publishing", status, now, error.kind, error.description);
    input.queue.setOperationState(claimed.operationId, "failed", now, error.kind, JSON.stringify({ description: error.description }));
    input.queue.setOperationPhase(claimed.operationId, "failed", now, error.kind, JSON.stringify({ description: error.description }));
    return { kind: "failed", itemId: claimed.item.id, status, error: error.description, operationId: claimed.operationId };
  };

  const publishClaimed = async (claimed: Claimed, prepared?: PreparedPublication): Promise<PublicationOutcome> => {
    const preparation = prepared ?? prepare(claimed.item);
    if ("blockedStatus" in preparation) {
      const now = input.clock.now();
      input.queue.transition(claimed.item.id, "publishing", preparation.blockedStatus, now, preparation.reason, preparation.reason);
      input.queue.setOperationState(claimed.operationId, "failed", now, preparation.reason);
      input.queue.setOperationPhase(claimed.operationId, "failed", now, preparation.reason);
      return { kind: "blocked", itemId: claimed.item.id, status: preparation.blockedStatus, reason: preparation.reason, operationId: claimed.operationId };
    }
    const { snapshots, sourceIds, plan, contract } = preparation;
    const guard = guardFor(claimed);
    try {
      input.queue.persistPublicationContract(claimed.operationId, contract, input.clock.now());
      input.queue.beginPublicationTransfer(guard, input.clock.now());
    } catch (error) {
      return failClaim(claimed, classifyTelegramError(error));
    }

    let destinationIds: MessageId[] = [];
    try {
      const transferInput = { targetChatId: input.targetChannelId, sourceChatId: input.queueChannelId, messageIds: sourceIds };
      const result = plan.kind === "forward" ? await input.gateway.forwardMessages(transferInput) : await input.gateway.copyMessages(transferInput);
      destinationIds = [...result];
      for (const [ordinal, id] of destinationIds.entries()) input.queue.recordOutput(claimed.operationId, "transferred", input.targetChannelId, id, ordinal, input.clock.now());
      if (destinationIds.length !== sourceIds.length) {
        input.queue.markPartialCleanupPending(guard, input.clock.now(), "partial_result", "Telegram returned fewer destination messages than the immutable output contract requires");
        const cleaned = await cleanupDestination(destinationIds);
        if (!cleaned.ok) {
          input.queue.transition(claimed.item.id, "publishing", "uncertain_publish", input.clock.now(), "partial_output_cleanup", "Known partial destination output could not be confirmed deleted");
          input.queue.setOperationState(claimed.operationId, "uncertain", input.clock.now(), "partial_output_cleanup");
          input.queue.setOperationPhase(claimed.operationId, "uncertain", input.clock.now(), "partial_output_cleanup");
          logUncertainty(claimed, cleaned.error, { phase: "uncertain", expectedOutputCount: contract.expectedOutputMessageCount, knownOutputCount: destinationIds.length });
          return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
        }
        input.queue.transition(claimed.item.id, "publishing", "needs_review", input.clock.now(), "partial_result", "Telegram returned fewer destination messages than the source contract requires");
        input.queue.setOperationState(claimed.operationId, "failed", input.clock.now(), "partial_result");
        input.queue.setOperationPhase(claimed.operationId, "failed", input.clock.now(), "partial_result");
        return { kind: "blocked", itemId: claimed.item.id, status: "needs_review", reason: "partial_result", operationId: claimed.operationId };
      }
      input.queue.recordCompleteBaseOutputs(guard, destinationIds.map((messageId, ordinal) => ({ chatId: input.targetChannelId, messageId, ordinal })), input.clock.now());

      if (plan.kind === "copy_with_inline_byline") {
        input.queue.markAttributionPending(guard, input.clock.now());
        await editInlineByline(snapshots, destinationIds, plan.name);
      } else if (plan.kind === "copy_with_separate_byline") {
        input.queue.markAttributionPending(guard, input.clock.now());
        const bylineId = await input.gateway.sendText({ chatId: input.targetChannelId, text: `by ${plan.name}` });
        input.queue.recordOutput(claimed.operationId, "separate_byline", input.targetChannelId, bylineId, destinationIds.length, input.clock.now());
        destinationIds = [...destinationIds, bylineId];
      }
      input.queue.markPublicationOutputComplete(guard, destinationIds, input.clock.now());
      input.queue.markSourceCleanupPending(guard, input.clock.now());
    } catch (error) {
      const normalized = classifyTelegramError(error);
      const attributionWasSeparate = plan.kind === "copy_with_separate_byline";
      if (destinationIds.length > 0) {
        const cleaned = await cleanupDestination(destinationIds);
        if (!cleaned.ok || attributionWasSeparate && normalized.kind === "ambiguous_send_result") {
          input.queue.transition(claimed.item.id, "publishing", "uncertain_publish", input.clock.now(), "partial_output_cleanup", normalized.description);
          input.queue.setOperationState(claimed.operationId, "uncertain", input.clock.now(), "partial_output_cleanup");
          input.queue.setOperationPhase(claimed.operationId, "uncertain", input.clock.now(), "partial_output_cleanup");
          logUncertainty(claimed, cleaned.ok ? normalized : cleaned.error, { phase: "uncertain", expectedOutputCount: contract.expectedOutputMessageCount, knownOutputCount: destinationIds.length });
          return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
        }
        // An edit failure after the known base messages were removed is safe to
        // retry. A separate-byline ambiguity is intentionally never retried.
        if (!attributionWasSeparate && normalized.kind === "ambiguous_send_result") {
          const retryAt = input.clock.now();
          input.queue.setRetry(claimed.item.id, claimed.operationId, retryAt, retryAt, "attribution_retry", normalized.description);
          return { kind: "retry_scheduled", itemId: claimed.item.id, retryAt, operationId: claimed.operationId };
        }
      }
      return failClaim(claimed, normalized, { expectedOutputCount: contract.expectedOutputMessageCount, knownOutputCount: destinationIds.length });
    }

    try {
      await input.gateway.deleteMessages(input.queueChannelId, sourceIds);
      input.queue.markCompleted(claimed.item.id, claimed.operationId, input.clock.now());
      return { kind: "published", itemId: claimed.item.id, destinationMessageIds: destinationIds, operationId: claimed.operationId };
    } catch (error) {
      const normalized = classifyTelegramError(error);
      if (normalized.kind === "source_missing") {
        input.queue.markMissing(claimed.item.id, claimed.operationId, input.clock.now());
        return { kind: "published", itemId: claimed.item.id, destinationMessageIds: destinationIds, operationId: claimed.operationId };
      }
      input.queue.setOperationState(claimed.operationId, "cleanup_pending", input.clock.now(), normalized.kind, normalized.description);
      input.queue.setOperationPhase(claimed.operationId, "source_cleanup_pending", input.clock.now(), normalized.kind, normalized.description);
      return { kind: "cleanup_pending", itemId: claimed.item.id, operationId: claimed.operationId };
    }
  };

  const cleanupPending = async (itemId: number): Promise<PublicationOutcome> => {
    const operation = input.queue.operationForItem(itemId);
    if (!operation) return { kind: "failed", itemId, status: "published_cleanup_pending", error: "Missing publication operation" };
    return tracked(operation.id, async () => {
      const sourceIds = input.queue.operationSourceIds(operation.id);
      if (sourceIds.length === 0) return { kind: "uncertain", itemId, operationId: operation.id };
      try {
        await input.gateway.deleteMessages(input.queueChannelId, sourceIds);
        input.queue.markCompleted(itemId, operation.id, input.clock.now());
        return { kind: "published", itemId, destinationMessageIds: input.queue.operationOutputIds(operation.id, "destination"), operationId: operation.id };
      } catch (error) {
        const normalized = classifyTelegramError(error);
        if (normalized.kind === "source_missing") {
          input.queue.markMissing(itemId, operation.id, input.clock.now());
          return { kind: "published", itemId, destinationMessageIds: input.queue.operationOutputIds(operation.id, "destination"), operationId: operation.id };
        }
        input.queue.setOperationState(operation.id, "cleanup_pending", input.clock.now(), normalized.kind, normalized.description);
        input.queue.setOperationPhase(operation.id, "source_cleanup_pending", input.clock.now(), normalized.kind, normalized.description);
        return { kind: "cleanup_pending", itemId, operationId: operation.id };
      }
    });
  };

  const publishNext = async (type: "publish" | "manual_publish" = "publish"): Promise<PublicationOutcome> => {
    const head = input.queue.getHead();
    if (!head) return { kind: "empty" };
    if (head.status === "published_cleanup_pending") return cleanupPending(head.id);
    if (head.status !== "queued" || head.maintenanceStatus !== "idle" || (head.retryNotBefore !== undefined && head.retryNotBefore > input.clock.now())) {
      return { kind: "blocked", itemId: head.id, status: head.status, reason: head.maintenanceStatus !== "idle" ? "maintenance_pending" : "head_not_ready" };
    }
    const preparation = prepare(head);
    if ("blockedStatus" in preparation) {
      input.queue.transition(head.id, "queued", preparation.blockedStatus, input.clock.now(), preparation.reason, preparation.reason);
      return { kind: "failed", itemId: head.id, status: preparation.blockedStatus, error: preparation.reason };
    }
    const operationId = newOperationId();
    const claimed = input.queue.claimPublication(operationId, type, input.clock.now());
    if (!claimed) return { kind: "blocked", itemId: head.id, status: "claimed_elsewhere", reason: "concurrent_claim" };
    return tracked(operationId, () => publishClaimed(claimed, preparation));
  };

  return { publishNext, cleanupPending, publishClaimed };
};

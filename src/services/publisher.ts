import { randomUUID } from "node:crypto";
import type { QueueRepository } from "../db/repositories";
import type { Logger } from "../logger";
import { classifyTelegramError } from "../errors";
import type { Clock, MessageId, NormalizedTelegramError, OperationGuard, PreparedMember, PreparedPublicationContractV2, TransferStep } from "../types";
import type { TelegramGateway } from "../telegram";
import type { TelegramCooldown } from "../telegram-cooldown";
import type { ChatId } from "../types";
import type { OperationTracker } from "./task-supervisor";
import { transferPreparedStep } from "./prepared-transfer";
import type { PublicationCoordinator } from "./publication-coordinator";

export type PublicationOutcome =
  | { kind: "empty" }
  | { kind: "blocked"; itemId: number; status: string; reason: string; operationId?: string }
  | { kind: "published"; itemId: number; destinationMessageIds: MessageId[]; operationId?: string }
  | { kind: "cleanup_pending"; itemId: number; operationId: string }
  | { kind: "retry_scheduled"; itemId: number; retryAt: number; operationId?: string }
  | { kind: "uncertain"; itemId: number; operationId: string }
  | { kind: "deleted_external"; itemId: number; operationId?: string }
  | { kind: "failed"; itemId: number; status: string; error: string; operationId?: string };

type Claimed = NonNullable<ReturnType<QueueRepository["claimReadyPublication"]>>;
export type ScheduledPublicationContext = { occurrenceAt: number; deadlineAt: number; claimToken: string };
const deliverySteps = (members: readonly PreparedMember[]): TransferStep[] => {
  const steps: TransferStep[] = [];
  for (let index = 0; index < members.length;) {
    const member = members[index]!;
    if (member.albumKey !== undefined) {
      let end = index + 1;
      while (end < members.length && members[end]!.albumKey === member.albumKey && members[end]!.deliveryMode === member.deliveryMode) end += 1;
      if (end - index > 1) {
        steps.push({ stepKey: `album:${steps.length}`, mode: member.deliveryMode, grouped: true, members: members.slice(index, end) });
        index = end;
        continue;
      }
    }
    const { albumKey: _albumKey, ...standalone } = member;
    steps.push({ stepKey: `member:${steps.length}`, mode: member.deliveryMode, grouped: false, members: [standalone] });
    index += 1;
  }
  return steps;
};

const retryAtFor = (error: NormalizedTelegramError, now: number, cooldown?: TelegramCooldown): number => {
  if (error.kind === "rate_limited") {
    if (cooldown !== undefined) return cooldown.extendForRetryAfter(error.retryAfterSeconds, now);
    return now + Math.ceil(Math.max(1, error.retryAfterSeconds ?? 60) * 1_000);
  }
  return now + 60_000;
};

const numericOutputCount = (ids: readonly unknown[]): number => ids.filter((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0).length;

export type PublicationService = ReturnType<typeof createPublicationService>;

export const createPublicationService = (input: {
  queue: QueueRepository;
  gateway: TelegramGateway;
  queueChannelId: ChatId;
  targetChannelId: ChatId;
  clock: Clock;
  logger: Logger;
  cooldown?: TelegramCooldown;
  operationId?: () => string;
  operationTracker?: OperationTracker;
  coordinator?: PublicationCoordinator;
  schedule?: { cancelUnsentRuns(reason: string, now: number): number };
  onSharedFailure?: (error: NormalizedTelegramError, context?: { itemId: number; operationId: string; retryAt?: number }) => Promise<void> | void;
  onSharedRecovery?: () => Promise<void> | void;
}) => {
  const newOperationId = input.operationId ?? randomUUID;

  const reportSharedFailure = async (error: NormalizedTelegramError, context?: { itemId: number; operationId: string; retryAt?: number }): Promise<void> => {
    try { await input.onSharedFailure?.(error, context); }
    catch (alertError) { input.logger.error("publication_shared_alert_failed", { error: alertError instanceof Error ? alertError.message : "unknown" }); }
  };

  const reportSharedRecovery = async (): Promise<void> => {
    try { await input.onSharedRecovery?.(); }
    catch (alertError) { input.logger.error("publication_shared_recovery_alert_failed", { error: alertError instanceof Error ? alertError.message : "unknown" }); }
  };

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
      const retryAt = retryAtFor(error, now, input.cooldown);
      input.queue.setRetry(claimed.item.id, claimed.operationId, now, retryAt, error.kind, error.description);
      await reportSharedFailure(error, { itemId: claimed.item.id, operationId: claimed.operationId, retryAt });
      return { kind: "retry_scheduled", itemId: claimed.item.id, retryAt, operationId: claimed.operationId };
    }
    if (error.kind === "ambiguous_send_result" || error.kind === "transient_network" || error.kind === "transient_server") {
      input.queue.transition(claimed.item.id, "publishing", "uncertain_publish", now, error.kind, error.description);
      input.queue.setOperationState(claimed.operationId, "uncertain", now, error.kind, JSON.stringify({ description: error.description }));
      input.queue.setOperationPhase(claimed.operationId, "uncertain", now, error.kind, JSON.stringify({ description: error.description }));
      logUncertainty(claimed, error, { ...context, phase: "uncertain" });
      return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
    }
    const status = error.kind === "invalid_content_or_entities" ? "needs_edit" : "blocked";
    input.queue.transition(claimed.item.id, "publishing", status, now, error.kind, error.description);
    input.queue.setOperationState(claimed.operationId, "failed", now, error.kind, JSON.stringify({ description: error.description }));
    input.queue.setOperationPhase(claimed.operationId, "failed", now, error.kind, JSON.stringify({ description: error.description }));
    return { kind: "failed", itemId: claimed.item.id, status, error: error.description, operationId: claimed.operationId };
  };

  const publishPreparedClaimed = async (claimed: Claimed): Promise<PublicationOutcome> => {
    const item = claimed.item;
    const guard = guardFor(claimed);
    const members = input.queue.getCurrentMembers(item.id);
    const sourceIds = members.map((member) => member.messageId);
    if (members.length === 0 || sourceIds.length === 0) {
      input.queue.transition(item.id, "publishing", "needs_review", input.clock.now(), "empty_prepared_representation", "Prepared queue item has no current messages");
      input.queue.setOperationState(claimed.operationId, "failed", input.clock.now(), "empty_prepared_representation");
      input.queue.setOperationPhase(claimed.operationId, "failed", input.clock.now(), "empty_prepared_representation");
      return { kind: "failed", itemId: item.id, status: "needs_review", error: "Prepared queue item has no current messages", operationId: claimed.operationId };
    }
    const steps = deliverySteps(members);
    const contract: PreparedPublicationContractV2 = {
      version: 2,
      kind: "prepared_delivery",
      capturedContentVersion: claimed.capturedContentVersion,
      capturedSourceGeneration: claimed.capturedSourceGeneration,
      sourceIds,
      steps,
      expectedOutputMessageCount: members.length,
    };
    const destinationIds: MessageId[] = [];
    try {
      input.queue.persistPreparedPublicationContract(claimed.operationId, contract, input.clock.now());
      input.queue.beginPublicationTransfer(guard, input.clock.now());
      let offset = 0;
      for (const step of steps) {
        const baseOrdinal = offset;
        await transferPreparedStep({
          gateway: input.gateway,
          targetChatId: input.targetChannelId,
          sourceChatId: input.queueChannelId,
          step,
          beforeRequest: () => input.queue.setOperationPhase(claimed.operationId, "transfer_pending", input.clock.now()),
          recordOutput: (output) => {
            input.queue.recordOutput(claimed.operationId, "transferred", input.targetChannelId, output.messageId, baseOrdinal + output.ordinal, input.clock.now());
            destinationIds.push(output.messageId);
          },
        });
        offset += step.members.length;
      }
      if (destinationIds.length !== members.length) throw { kind: "ambiguous_send_result", method: "preparedDelivery", description: `Expected ${members.length} destination messages, received ${destinationIds.length}`, knownOutputs: destinationIds, requestMayHaveSucceeded: true };
      input.queue.recordCompleteBaseOutputs(guard, destinationIds.map((messageId, ordinal) => ({ chatId: input.targetChannelId, messageId, ordinal })), input.clock.now());
      input.queue.markPublicationOutputComplete(guard, destinationIds, input.clock.now());
      input.queue.markSourceCleanupPending(guard, input.clock.now());
      await reportSharedRecovery();
    } catch (error) {
      const normalized = classifyTelegramError(error);
      if (normalized.kind === "source_missing" && members.length === 1 && destinationIds.length === 0) {
        input.queue.markMissing(item.id, claimed.operationId, input.clock.now());
        return { kind: "deleted_external", itemId: item.id, operationId: claimed.operationId };
      }
      if (destinationIds.length > 0 || normalized.kind === "ambiguous_send_result" || normalized.kind === "transient_network" || normalized.kind === "transient_server") {
        input.queue.transition(item.id, "publishing", "uncertain_publish", input.clock.now(), normalized.kind, normalized.description);
        input.queue.setOperationState(claimed.operationId, "uncertain", input.clock.now(), normalized.kind, JSON.stringify({ description: normalized.description }));
        input.queue.setOperationPhase(claimed.operationId, "uncertain", input.clock.now(), normalized.kind, JSON.stringify({ description: normalized.description, knownDestinationIds: destinationIds }));
        logUncertainty(claimed, normalized, { phase: "uncertain", expectedOutputCount: members.length, knownOutputCount: destinationIds.length });
        return { kind: "uncertain", itemId: item.id, operationId: claimed.operationId };
      }
      if (normalized.kind === "permission_denied" || normalized.kind === "destination_unavailable") {
        const retryAt = input.clock.now() + 6 * 60 * 60_000;
        input.queue.setRetry(item.id, claimed.operationId, input.clock.now(), retryAt, normalized.kind, normalized.description);
        await reportSharedFailure(normalized, { itemId: item.id, operationId: claimed.operationId, retryAt });
        return { kind: "failed", itemId: item.id, status: "shared_failure", error: normalized.description, operationId: claimed.operationId };
      }
      if (normalized.kind === "source_missing") {
        input.queue.transition(item.id, "publishing", "needs_review", input.clock.now(), "source_missing_unmapped", normalized.description);
        input.queue.setOperationState(claimed.operationId, "failed", input.clock.now(), "source_missing_unmapped", JSON.stringify({ description: normalized.description }));
        input.queue.setOperationPhase(claimed.operationId, "failed", input.clock.now(), "source_missing_unmapped");
        return { kind: "failed", itemId: item.id, status: "needs_review", error: normalized.description, operationId: claimed.operationId };
      }
      return failClaim(claimed, normalized, { expectedOutputCount: members.length, knownOutputCount: destinationIds.length });
    }

    try {
      await input.gateway.deleteMessages(input.queueChannelId, sourceIds);
      input.queue.markCompleted(item.id, claimed.operationId, input.clock.now());
      return { kind: "published", itemId: item.id, destinationMessageIds: destinationIds, operationId: claimed.operationId };
    } catch (error) {
      const normalized = classifyTelegramError(error, "deleteMessages");
      if (normalized.kind === "source_missing") {
        input.queue.markMissing(item.id, claimed.operationId, input.clock.now());
        return { kind: "published", itemId: item.id, destinationMessageIds: destinationIds, operationId: claimed.operationId };
      }
      input.queue.setOperationState(claimed.operationId, "cleanup_pending", input.clock.now(), normalized.kind, normalized.description);
      input.queue.setOperationPhase(claimed.operationId, "source_cleanup_pending", input.clock.now(), normalized.kind, JSON.stringify({ description: normalized.description }));
      return { kind: "cleanup_pending", itemId: item.id, operationId: claimed.operationId };
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

  const publishNextUnlocked = async (type: "publish" | "manual_publish" = "publish", expected?: { itemId: number; contentVersion: number; sourceGeneration: number }, scheduled?: ScheduledPublicationContext): Promise<PublicationOutcome> => {
    const now = input.clock.now();
    const first = input.queue.peekNextReady(now);
    if (!first) return expected ? { kind: "blocked", itemId: expected.itemId, status: "stale_candidate", reason: "No prepared item is currently ready; reopen the queue." } : { kind: "empty" };
    if (expected && (first.id !== expected.itemId || first.contentVersion !== expected.contentVersion || first.sourceGeneration !== expected.sourceGeneration)) {
      return { kind: "blocked", itemId: expected.itemId, status: "stale_candidate", reason: "The ready queue changed; reopen the queue before publishing." };
    }
    const candidates: Array<{ itemId: number; contentVersion: number; sourceGeneration: number }> = [];
    const excluded: number[] = [];
    for (let count = 0; count < 500; count += 1) {
      const candidate = input.queue.peekNextReady(now, excluded);
      if (!candidate) break;
      candidates.push({ itemId: candidate.id, contentVersion: candidate.contentVersion, sourceGeneration: candidate.sourceGeneration });
      excluded.push(candidate.id);
    }
    let lastDefinite: PublicationOutcome | undefined;
    const attempted: number[] = [];
    for (const candidate of candidates) {
      const operationId = newOperationId();
      const claimed = input.queue.claimReadyPublication(operationId, type, input.clock.now(), candidate, undefined, attempted, scheduled);
      attempted.push(candidate.itemId);
      if (!claimed) continue;
      const outcome = await tracked(operationId, () => publishPreparedClaimed(claimed));
      if (outcome.kind === "published" || outcome.kind === "cleanup_pending" || outcome.kind === "uncertain" || outcome.kind === "retry_scheduled") return outcome;
      if (outcome.kind === "failed" && outcome.status === "shared_failure") return outcome;
      lastDefinite = outcome;
    }
    return lastDefinite ?? { kind: "empty" };
  };

  const publishNext = async (type: "publish" | "manual_publish" = "publish", expected?: { itemId: number; contentVersion: number; sourceGeneration: number }, scheduled?: ScheduledPublicationContext): Promise<PublicationOutcome> => {
    const execute = async (): Promise<PublicationOutcome> => {
      const outcome = await publishNextUnlocked(type, expected, scheduled);
      if (type === "manual_publish" && (outcome.kind === "published" || outcome.kind === "cleanup_pending")) {
        input.schedule?.cancelUnsentRuns("manual_publication", input.clock.now());
      }
      return outcome;
    };
    return input.coordinator ? input.coordinator.runExclusive(execute) : execute();
  };

  return { publishNext, cleanupPending };
};

import { randomUUID } from "node:crypto";
import { fingerprintSnapshotContent } from "../domain/message";
import { validatePreparedRenewalContractV2 } from "../domain/validation";
import { RENEWAL_ITEM_RETRY_MS } from "../domain/renewal-policy";
import { classifyTelegramError, TelegramLocalDeferralError } from "../errors";
import type { QueueRepository, PolicyRepository, GeneratedMessageRepository } from "../db/repositories";
import type { Logger } from "../logger";
import type { ChatId, Clock, MessageId, NormalizedTelegramError, OperationGuard, PreparedMember, PreparedRenewalContractV2, RenewalExecutionGuard, StoredMessageSnapshot, TransferStep } from "../types";
import type { TelegramGateway } from "../telegram";
import type { TelegramCooldown } from "../telegram-cooldown";
import type { OperationTracker } from "./task-supervisor";
import type { createGeneratedEventRepository } from "../db/generated-event-repository";
import { transferPreparedStep } from "./prepared-transfer";
import type { OperationRequestRepository } from "../db/operation-request-repository";
import { withTelegramMutationScope, type TelegramRequestResult } from "../telegram-request-context";

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
  events?: ReturnType<typeof createGeneratedEventRepository>;
  requestEvidence?: OperationRequestRepository;
}) => {
  const newOperationId = input.operationId ?? randomUUID;

  const resultIds = (value: unknown): number[] => {
    if (Array.isArray(value)) return value.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0);
    if (typeof value === "object" && value !== null) {
      const id = (value as Record<string, unknown>).message_id ?? (value as Record<string, unknown>).messageId;
      return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? [id] : [];
    }
    return [];
  };

  const runRequest = async <T>(request: {
    operationId: string;
    itemId: number;
    method: string;
    targetChatId: number;
    stepKey?: string;
    family?: "renewal" | "cleanup";
    beforeDispatch?: () => void;
    work: () => Promise<T>;
  }): Promise<T> => {
    let requestId: string | undefined;
    const beforeDispatch = (): void => {
      request.beforeDispatch?.();
      requestId = input.requestEvidence?.begin({ operationId: request.operationId, method: request.method, targetChatId: request.targetChatId, ...(request.stepKey === undefined ? {} : { stepKey: request.stepKey }), now: input.clock.now() });
    };
    const onResult = (result: TelegramRequestResult): void => {
      if (requestId === undefined || input.requestEvidence === undefined) return;
      input.requestEvidence.finish(requestId, result, input.clock.now());
    };
    const scope = {
      family: request.family ?? "renewal" as const,
      priority: request.family === "cleanup" ? "urgent_maintenance" as const : "background" as const,
      operationId: request.operationId,
      itemId: request.itemId,
      ...(request.stepKey === undefined ? {} : { stepKey: request.stepKey }),
      beforeDispatch,
      onResult,
    };
    if (input.gateway.dispatchManaged === true) return withTelegramMutationScope(scope, request.work);
    beforeDispatch();
    try {
      const value = await request.work();
      const ids = resultIds(value);
      onResult({ state: "accepted", ...(ids.length === 0 ? {} : { knownOutputIds: ids }) });
      return value;
    } catch (error) {
      const normalized = classifyTelegramError(error, request.method);
      const definitive = new Set(["rate_limited", "source_missing", "permission_denied", "destination_unavailable", "unsupported_content", "invalid_content_or_entities", "content_protected", "telegram_age_limit", "unknown_permanent"]);
      onResult({ state: definitive.has(normalized.kind) ? "rejected" : "unknown", errorKind: normalized.kind, ...(normalized.knownOutputs === undefined ? {} : { knownOutputIds: normalized.knownOutputs.map(Number) }) });
      if (normalized.kind === "rate_limited") input.cooldown?.extendForRetryAfter(normalized.retryAfterSeconds, input.clock.now());
      throw error;
    }
  };

  const assertReplacementDispatchable = (claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>, guard: RenewalExecutionGuard): void => {
    const current = input.queue.findItemById(claimed.item.id);
    if (!current || current.maintenanceOperationId !== claimed.operationId || current.maintenanceStatus !== "renewing" || current.contentVersion !== guard.expectedContentVersion || current.sourceGeneration !== claimed.capturedSourceGeneration) {
      throw new TelegramLocalDeferralError("protection_changed", input.clock.now(), "Queue item changed before renewal dispatch");
    }
  };

  const tracked = async <T>(operationId: string, work: () => Promise<T>): Promise<T> => {
    const finish = input.operationTracker?.begin(operationId);
    try { return await work(); }
    finally { finish?.(); }
  };

  const renewalSteps = (members: readonly PreparedMember[]): TransferStep[] => {
    const steps: TransferStep[] = [];
    for (let index = 0; index < members.length;) {
      const first = members[index]!;
      let end = index + 1;
      if (first.albumKey !== undefined) {
        while (end < members.length && members[end]!.albumKey === first.albumKey && members[end]!.deliveryMode === first.deliveryMode) end += 1;
      }
      const group = members.slice(index, end);
      if (first.albumKey !== undefined && group.length > 1) {
        steps.push({ stepKey: `renewal:${steps.length}`, mode: first.deliveryMode, grouped: true, members: group });
      } else {
        const { albumKey: _albumKey, ...standalone } = first;
        steps.push({ stepKey: `renewal:${steps.length}`, mode: first.deliveryMode, grouped: false, members: [standalone] });
      }
      index = end;
    }
    return steps;
  };

  const renewedMember = (source: PreparedMember, outputId: MessageId, ordinal: number, createdAt: number, grouped: boolean): PreparedMember => {
    const { editDate: _editDate, mediaGroupId: _oldMediaGroupId, ...base } = source.snapshot;
    const snapshot: StoredMessageSnapshot = {
      ...base,
      chatId: input.queueChannelId,
      messageId: outputId,
      ordinal,
      telegramDate: createdAt,
      nativeOrigin: source.deliveryMode === "copy" ? { kind: "absent" } : (source.snapshot.nativeOrigin ?? source.snapshot.origin),
    };
    snapshot.contentFingerprint = fingerprintSnapshotContent(snapshot);
    return {
      memberKey: source.memberKey,
      messageId: outputId,
      role: source.role,
      deliveryMode: source.deliveryMode,
      ...(grouped && source.albumKey !== undefined ? { albumKey: source.albumKey } : {}),
      snapshot,
    };
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
    if (error.kind === "local_deferral") {
      const retryAt = error.retryAt ?? now + 1_000;
      input.queue.setRetry(claimed.item.id, claimed.operationId, now, retryAt, error.kind, error.description);
      return { kind: "retry_scheduled", itemId: claimed.item.id, retryAt };
    }
    if (error.kind === "rate_limited") {
      const retryAt = input.gateway.dispatchManaged === true
        ? (input.cooldown?.notBefore() ?? now + Math.ceil(Math.max(1, error.retryAfterSeconds ?? 60) * 1000))
        : (input.cooldown?.extendForRetryAfter(error.retryAfterSeconds, now) ?? now + Math.ceil(Math.max(1, error.retryAfterSeconds ?? 60) * 1000));
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
    operationGuard: RenewalExecutionGuard | OperationGuard = guardFor(claimed),
  ): Promise<RenewalOutcome> => {
    const guard = operationGuard;
    try {
      await runRequest({ operationId: claimed.operationId, itemId: claimed.item.id, method: "deleteMessages", targetChatId: Number(input.queueChannelId), family: "cleanup", stepKey: "old-source-generation", beforeDispatch: () => input.queue.setOperationPhase(claimed.operationId, "old_source_cleanup_pending", input.clock.now()), work: () => input.gateway.deleteMessages(input.queueChannelId, oldSourceIds) });
      input.queue.completeRenewalWithOrphans(guard, [], input.clock.now());
      return { kind: "renewed", itemId: claimed.item.id, generation };
    } catch (error) {
      const normalized = classifyTelegramError(error);
      if (normalized.kind === "source_missing") {
        input.queue.completeRenewalWithOrphans(guard, [], input.clock.now());
        return { kind: "renewed", itemId: claimed.item.id, generation };
      }
      if (normalized.kind === "rate_limited" && input.gateway.dispatchManaged !== true) input.cooldown?.extendForRetryAfter(normalized.retryAfterSeconds, input.clock.now());
      // The replacement generation is already durable. Keep it current and
      // make each old ID independently retryable instead of wedging the item.
      input.queue.completeRenewalWithOrphans(guard, oldSourceIds, input.clock.now(), normalized.kind === "permission_denied" ? "permission_denied" : normalized.kind);
      input.logger.warn("old_renewal_generation_orphaned", { itemId: claimed.item.id, generation: claimed.capturedSourceGeneration, count: oldSourceIds.length, error: normalized.kind });
      return { kind: "renewed", itemId: claimed.item.id, generation };
    }
  };

  const renewClaimed = async (claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>): Promise<RenewalOutcome> => {
    let guard: RenewalExecutionGuard = { ...guardFor(claimed), expectedContentVersion: claimed.capturedContentVersion };
    const now = input.clock.now();
    const oldSourceIds = input.queue.currentSourceIds(claimed.item.id);
    let members = input.queue.getCapturedMembers(claimed.item.id, claimed.capturedSourceGeneration, oldSourceIds);
    if (members.length === 0) {
      input.queue.markMissing(claimed.item.id, claimed.operationId, now);
      return { kind: "deleted_external", itemId: claimed.item.id };
    }
    const steps = renewalSteps(members);
    const contract: PreparedRenewalContractV2 = {
      version: 2,
      kind: "prepared_renewal",
      capturedLogicalStatus: claimed.item.status,
      capturedContentVersion: guard.capturedContentVersion,
      capturedSourceGeneration: guard.capturedSourceGeneration,
      sourceIds: oldSourceIds,
      steps,
      expectedReplacementMessageCount: members.length,
    };
    input.queue.persistPreparedRenewalContract(guard, contract, now);
    let knownOutputCount = 0;
    let globalOrdinal = 0;
    let removedAll = false;
    const missingSourceIds = new Set<number>();
    const outputMemberKeys = new Map<string, MessageId>();
    const sourceCreatedAt = input.clock.now();
    try {
      for (const step of steps) {
        if (step.members.every((member) => !members.some((current) => current.memberKey === member.memberKey))) continue;
        try {
          const stepOutputs = await transferPreparedStep({
            gateway: input.gateway,
            targetChatId: input.queueChannelId,
            sourceChatId: input.queueChannelId,
            step,
            beforeRequest: () => undefined,
            runRequest: (request) => runRequest({ operationId: claimed.operationId, itemId: claimed.item.id, method: request.method, targetChatId: Number(request.targetChatId), stepKey: request.stepKey, beforeDispatch: () => {
              assertReplacementDispatchable(claimed, guard);
              input.queue.setOperationPhase(claimed.operationId, "replacement_pending", input.clock.now());
            }, work: request.work }),
            recordOutput: (output) => {
              const ordinal = globalOrdinal++;
              input.queue.recordReplacementOutput(claimed.operationId, output.chatId, output.messageId, ordinal, input.clock.now(), { stepKey: output.stepKey, ...(output.sourceMemberKey === undefined ? {} : { sourceMemberKey: output.sourceMemberKey }) });
              input.events?.expect({ family: "renewal", operationId: claimed.operationId, chatId: Number(output.chatId), messageId: Number(output.messageId), kind: "post", now: input.clock.now() });
              knownOutputCount += 1;
            },
          });
          for (const output of stepOutputs) {
            if (!output.sourceMemberKey) throw new Error("A completed renewal output has no validated source-member association");
            outputMemberKeys.set(output.sourceMemberKey, output.messageId);
            input.queue.markRenewalMemberSent(guard, output.sourceMemberKey, output.messageId, input.clock.now());
          }
        } catch (error) {
          const normalized = classifyTelegramError(error, step.mode === "copy" ? (step.grouped ? "copyMessages" : "copyMessage") : (step.grouped ? "forwardMessages" : "forwardMessage"));
          if (normalized.kind === "source_missing" && !step.grouped && step.members.length === 1) {
            const missing = input.queue.markRenewalMemberMissing(guard, step.members[0]!.memberKey, { method: normalized.method ?? (step.mode === "copy" ? "copyMessage" : "forwardMessage"), ...(normalized.code === undefined ? {} : { code: normalized.code }), description: normalized.description }, input.clock.now());
            guard = missing.nextGuard;
            missingSourceIds.add(Number(step.members[0]!.messageId));
            members = members.filter((member) => member.memberKey !== step.members[0]!.memberKey);
            if (missing.itemRemoved) {
              removedAll = true;
              return { kind: "deleted_external", itemId: claimed.item.id };
            }
            continue;
          }
          const message = step.grouped && normalized.kind === "source_missing"
            ? `Telegram reported a missing source for album step ${step.stepKey}; the omitted member cannot be identified safely. ${normalized.description}`
            : normalized.description;
          if (knownOutputCount > 0 || normalized.requestMayHaveSucceeded || normalized.kind === "ambiguous_send_result" || normalized.kind === "transient_network" || normalized.kind === "transient_server") {
            const code = step.grouped && normalized.kind === "ambiguous_send_result" && normalized.description.startsWith("Expected ") ? "partial_replacement" : normalized.kind === "source_missing" ? "ambiguous_send_result" : normalized.kind;
            input.queue.setRenewalUncertain(claimed.item.id, claimed.operationId, input.clock.now(), code, message);
            return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
          }
          return handleError(claimed, normalized);
        }
      }

      if (members.length === 0 || removedAll) return { kind: "deleted_external", itemId: claimed.item.id };
      input.queue.markReplacementOutputsRecorded(guard, input.clock.now());
      const sentMembers = members.filter((member) => outputMemberKeys.has(member.memberKey));
      if (sentMembers.length !== members.length) throw new Error("Renewal completed without one output for every surviving member");
      const nextMembers = sentMembers.map((member, ordinal) => renewedMember(member, outputMemberKeys.get(member.memberKey)!, ordinal, sourceCreatedAt, member.albumKey !== undefined && steps.some((step) => step.grouped && step.members.some((entry) => entry.memberKey === member.memberKey))));
      const generation = input.queue.installRenewedGeneration(guard, nextMembers, input.clock.now(), sourceCreatedAt);
      return cleanupOldGeneration(claimed, oldSourceIds.filter((id) => !missingSourceIds.has(Number(id))), generation, guard);
    } catch (error) {
      const normalized = classifyTelegramError(error);
      const description = error instanceof Error ? error.message : normalized.description;
      if (knownOutputCount > 0) {
        input.queue.setRenewalUncertain(claimed.item.id, claimed.operationId, input.clock.now(), "ambiguous_send_result", description);
        return { kind: "uncertain", itemId: claimed.item.id, operationId: claimed.operationId };
      }
      return handleError(claimed, normalized);
    }
  };

  const renewClaimedTracked = async (claimed: NonNullable<ReturnType<QueueRepository["claimRenewal"]>>): Promise<RenewalOutcome> => tracked(claimed.operationId, () => renewClaimed(claimed));

  const renewNextAttempt = async (minimumAgeMs: number): Promise<{ outcome: RenewalOutcome; sourceCount: number }> => {
    const now = input.clock.now();
    const claimed = input.queue.claimRenewal(newOperationId(), now, now - minimumAgeMs, undefined, input.requestEvidence === undefined ? 0 : 1);
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
      const oldSourceIds = input.queue.getMessages(itemId, operation.capturedSourceGeneration).filter((message) => message.removedAt === undefined).map((message) => message.telegramMessageId);
      const progress = input.queue.renewalProgress(operation.id);
      return cleanupOldGeneration({
        item: { ...item, maintenanceStatus: "renewing" },
        operationId: operation.id,
        capturedContentVersion: operation.capturedContentVersion,
        capturedSourceGeneration: operation.capturedSourceGeneration,
      }, oldSourceIds, item.sourceGeneration, {
        operationId: operation.id,
        itemId,
        capturedContentVersion: operation.capturedContentVersion,
        capturedSourceGeneration: operation.capturedSourceGeneration,
        expectedContentVersion: progress?.effectiveContentVersion ?? item.contentVersion,
      });
    });
  };

  return { renewNext, renewNextAttempt, renewClaimed, cleanupPending };
};

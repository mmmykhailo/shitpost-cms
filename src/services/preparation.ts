import { createHash } from "node:crypto";
import { appendInlineByline, CAPTION_LIMIT, TEXT_LIMIT, separateByline } from "../domain/byline";
import { botInlineAttribution, inspectInlineCreditEdit } from "../domain/attribution";
import { classifyPublicationPlan, isInlineCaptionContent, isSeparateBylineContent } from "../domain/origin-policy";
import { fingerprintSnapshotContent } from "../domain/message";
import type { PolicyRepository, QueueRepository } from "../db/repositories";
import type { PreparationRepository } from "../db/preparation-repository";
import type { Logger } from "../logger";
import { classifyTelegramError } from "../errors";
import type { AttributionDescriptor, Clock, DeliveryMode, MessageId, PreparationContractV1, PreparedMember, StoredMessageSnapshot, TransferStep } from "../types";
import type { TelegramGateway } from "../telegram";
import type { TelegramCooldown } from "../telegram-cooldown";
import type { OperationTracker } from "./task-supervisor";
import { transferPreparedStep, type PreparedTransferOutput } from "./prepared-transfer";

export type PreparationOutcome =
  | { kind: "empty" }
  | { kind: "prepared"; itemId: number; preparationState: string; operationId: string }
  | { kind: "retry_scheduled"; itemId: number; retryAt: number; operationId: string }
  | { kind: "blocked"; itemId: number; status: string; reason: string; operationId: string }
  | { kind: "uncertain"; itemId: number; operationId: string }
  | { kind: "deleted_external"; itemId: number; operationId: string };

const buildPreparedMetadataSteps = (members: readonly PreparedMember[]): TransferStep[] => {
  const result: TransferStep[] = [];
  for (let index = 0; index < members.length;) {
    const member = members[index]!;
    if (member.albumKey !== undefined) {
      let end = index + 1;
      while (end < members.length && members[end]!.albumKey === member.albumKey && members[end]!.deliveryMode === member.deliveryMode) end += 1;
      const group = members.slice(index, end);
      if (group.length > 1) {
        result.push({ stepKey: `album:${result.length}`, mode: member.deliveryMode, grouped: true, members: group });
        index = end;
        continue;
      }
    }
    const { albumKey: _albumKey, ...standalone } = member;
    result.push({ stepKey: `member:${result.length}`, mode: member.deliveryMode, grouped: false, members: [standalone] });
    index += 1;
  }
  return result;
};

const canonicalEditPayload = (snapshot: StoredMessageSnapshot, edit: "text" | "caption"): string => {
  const payload: Record<string, unknown> = edit === "text"
    ? { text: snapshot.text ?? "", entities: snapshot.entities ?? [], linkPreviewOptions: snapshot.linkPreviewOptions ?? {} }
    : { caption: snapshot.caption ?? "", captionEntities: snapshot.captionEntities ?? [], showCaptionAboveMedia: snapshot.showCaptionAboveMedia ?? false };
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (typeof value === "object" && value !== null) return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  return stable(payload);
};

export type PreparationService = ReturnType<typeof createPreparationService>;

export const createPreparationService = (input: {
  queue: QueueRepository;
  preparation: PreparationRepository;
  policy: PolicyRepository;
  gateway: TelegramGateway;
  queueChannelId: Parameters<TelegramGateway["deleteMessages"]>[0];
  bootId: string;
  clock: Clock;
  logger: Logger;
  cooldown?: TelegramCooldown;
  operationTracker?: OperationTracker;
}) => {
  const retryAt = (error: ReturnType<typeof classifyTelegramError>, now: number): number => error.kind === "rate_limited"
    ? (input.cooldown?.extendForRetryAfter(error.retryAfterSeconds, now) ?? now + Math.ceil(Math.max(1, error.retryAfterSeconds ?? 60) * 1_000))
    : now + 60_000;

  const buildSteps = (members: readonly PreparedMember[], mode: DeliveryMode): TransferStep[] => {
    const steps: TransferStep[] = [];
    for (let index = 0; index < members.length;) {
      const source = members[index]!;
      const memberMode = source.role === "credit" ? "copy" : mode;
      let end = index + 1;
      if (source.albumKey !== undefined) {
        while (end < members.length && members[end]!.albumKey === source.albumKey && (members[end]!.role === "credit" ? "copy" : mode) === memberMode) end += 1;
      }
      const group = members.slice(index, end).map((member) => ({ ...member, deliveryMode: member.role === "credit" ? "copy" as const : mode }));
      if (source.albumKey !== undefined && group.length > 1) {
        steps.push({ stepKey: `album:${steps.length}`, mode: memberMode, grouped: true, members: group });
      } else {
        const { albumKey: _albumKey, ...standalone } = group[0]!;
        steps.push({ stepKey: `member:${steps.length}`, mode: memberMode, grouped: false, members: [standalone] });
      }
      index = end;
    }
    return steps;
  };

  const inPlacePreparedMembers = (members: readonly PreparedMember[], mode: DeliveryMode): PreparedMember[] => members.map((member) => {
    const { albumKey, ...base } = member;
    return { ...base, deliveryMode: member.role === "credit" ? "copy" : mode, ...(members.length > 1 && albumKey !== undefined ? { albumKey } : {}) };
  });

  const snapshotForOutput = (source: PreparedMember, output: PreparedTransferOutput, ordinal: number, mode: DeliveryMode, now: number): PreparedMember => {
    const { editDate: _editDate, mediaGroupId: _oldMediaGroupId, ...rest } = source.snapshot;
    const snapshot = {
      ...rest,
      schemaVersion: 2 as const,
      chatId: input.queueChannelId,
      messageId: output.messageId,
      ordinal,
      telegramDate: now,
      origin: source.snapshot.origin,
      nativeOrigin: mode === "copy" ? { kind: "absent" as const } : (source.snapshot.nativeOrigin ?? source.snapshot.origin),
      hasReplyMarkup: source.snapshot.hasReplyMarkup,
    };
    snapshot.contentFingerprint = fingerprintSnapshotContent(snapshot);
    return { memberKey: source.memberKey, messageId: output.messageId, role: source.role, deliveryMode: mode, ...(source.albumKey === undefined || output.stepKey.startsWith("member:") ? {} : { albumKey: source.albumKey }), snapshot };
  };

  const refreshClaim = async (
    claim: NonNullable<ReturnType<PreparationRepository["claimNextPreparation"]>>,
    item: NonNullable<ReturnType<QueueRepository["findItemById"]>>,
    members: PreparedMember[],
  ): Promise<PreparationOutcome> => {
    let guard = claim.guard;
    let updatedMembers = members;
    let mutationMayHaveStarted = false;
    const attribution = item.attribution ?? { ownership: "none" as const };
    let nextAttribution: AttributionDescriptor = attribution;
    const creditPolicy = input.policy.resolveCreditPolicy(item.origin);
    input.queue.reconcileNicknamePolicy(item.id, creditPolicy);
    const revision = creditPolicy.revision;
    try {
      const contract: PreparationContractV1 = {
        version: 1, kind: "refresh", itemId: item.id,
        capturedContentVersion: claim.guard.capturedContentVersion,
        capturedSourceGeneration: claim.guard.capturedSourceGeneration,
        originalOrigin: item.origin, deliveryMode: item.deliveryMode ?? "copy",
        capturedMembers: members, steps: buildPreparedMetadataSteps(members),
        targetNicknameRevision: revision, targetNicknameKey: creditPolicy.revisionKey, attribution,
      };
      input.preparation.persistContract(claim.operationId, contract, input.clock.now());
      if (attribution.ownership !== "bot") {
        const completed = input.preparation.completeInPlaceRefresh(guard, members, attribution, revision, input.clock.now(), creditPolicy.revisionKey);
        return { kind: "prepared", itemId: item.id, preparationState: completed.preparationState, operationId: claim.operationId };
      }

      const target = members.find((member) => member.memberKey === attribution.memberKey);
      let nextSnapshot: StoredMessageSnapshot | undefined;
      let edit: "text" | "caption" | undefined;
      if (!target) {
        nextAttribution = { ownership: "admin", previousMemberKey: attribution.memberKey };
      } else if (attribution.placement === "separate") {
        if (target.role !== "credit" || target.snapshot.text !== attribution.generatedText) {
          nextAttribution = { ownership: "admin", previousMemberKey: attribution.memberKey };
        } else {
          const plan = classifyPublicationPlan({ origin: item.origin, contentType: item.contentType, channelIsWhitelisted: item.deliveryMode === "forward", ...(creditPolicy.alias === undefined ? {} : { alias: creditPolicy.alias }) });
          if (plan.kind !== "copy_with_separate_byline") throw new Error("Current origin no longer has a separate-credit policy");
          const text = separateByline(plan.name);
          nextSnapshot = { ...target.snapshot, text };
          nextSnapshot.contentFingerprint = fingerprintSnapshotContent(nextSnapshot);
          edit = "text";
          nextAttribution = { ownership: "bot", placement: "separate", memberKey: target.memberKey, generatedText: text, generatedStartUtf16: 0, generatedLengthUtf16: text.length, appliedNicknameRevision: revision };
        }
      } else {
        const oldText = attribution.placement === "inline_text" ? target.snapshot.text : target.snapshot.caption;
        const ownership = inspectInlineCreditEdit(attribution, oldText);
        const generatedStart = (oldText?.length ?? 0) - attribution.generatedText.length;
        const entities = attribution.placement === "inline_text" ? target.snapshot.entities : target.snapshot.captionEntities;
        const generatedFormattingChanged = ownership.decision === "preserve_bot_ownership" && entities?.some((entity) => entity.offset + entity.length > generatedStart);
        if (ownership.decision !== "preserve_bot_ownership" || generatedFormattingChanged) {
          nextAttribution = generatedFormattingChanged ? { ownership: "admin", previousMemberKey: attribution.memberKey } : ownership.attribution;
        } else {
          const plan = classifyPublicationPlan({ origin: item.origin, contentType: target.snapshot.contentType, channelIsWhitelisted: item.deliveryMode === "forward", ...(creditPolicy.alias === undefined ? {} : { alias: creditPolicy.alias }) });
          if (plan.kind !== "copy_with_inline_byline") throw new Error("Current origin no longer has an inline-credit policy");
          const fullText = oldText ?? "";
          const base = fullText.slice(0, fullText.length - attribution.generatedText.length);
          const isText = attribution.placement === "inline_text";
          const rendered = appendInlineByline(base, plan.name, isText ? TEXT_LIMIT : CAPTION_LIMIT, isText ? target.snapshot.entities : target.snapshot.captionEntities);
          const { entities: _entities, captionEntities: _captionEntities, ...baseSnapshot } = target.snapshot;
          nextSnapshot = { ...baseSnapshot };
          if (isText) {
            nextSnapshot.text = rendered.text;
            if (rendered.entities !== undefined) nextSnapshot.entities = rendered.entities;
            edit = "text";
          } else {
            nextSnapshot.caption = rendered.text;
            if (rendered.entities !== undefined) nextSnapshot.captionEntities = rendered.entities;
            edit = "caption";
          }
          nextSnapshot.contentFingerprint = fingerprintSnapshotContent(nextSnapshot);
          nextAttribution = botInlineAttribution(base, rendered.addedText, target.memberKey, attribution.placement, revision);
        }
      }

      if (!target || !nextSnapshot || !edit) {
        const completed = input.preparation.completeInPlaceRefresh(guard, members, nextAttribution, revision, input.clock.now(), creditPolicy.revisionKey);
        return { kind: "prepared", itemId: item.id, preparationState: completed.preparationState, operationId: claim.operationId };
      }

      if (canonicalEditPayload(target.snapshot, edit) === canonicalEditPayload(nextSnapshot, edit)) {
        const completed = input.preparation.completeInPlaceRefresh(guard, members, nextAttribution, revision, input.clock.now(), creditPolicy.revisionKey, false);
        return { kind: "prepared", itemId: item.id, preparationState: completed.preparationState, operationId: claim.operationId };
      }

      input.preparation.expectEdit(claim.operationId, input.queueChannelId, target.messageId, nextSnapshot, input.clock.now());
      input.preparation.setPhase(claim.operationId, "attribution_pending", input.clock.now());
      mutationMayHaveStarted = true;
      try {
        if (edit === "text") {
          const request = { chatId: input.queueChannelId, messageId: target.messageId, text: nextSnapshot.text ?? "" } as Parameters<TelegramGateway["editText"]>[0];
          if (nextSnapshot.entities !== undefined) request.entities = nextSnapshot.entities;
          if (nextSnapshot.linkPreviewOptions?.isDisabled !== undefined) request.linkPreviewIsDisabled = nextSnapshot.linkPreviewOptions.isDisabled;
          await input.gateway.editText(request);
        } else {
          const request = { chatId: input.queueChannelId, messageId: target.messageId, caption: nextSnapshot.caption ?? "" } as Parameters<TelegramGateway["editCaption"]>[0];
          if (nextSnapshot.captionEntities !== undefined) request.captionEntities = nextSnapshot.captionEntities;
          if (nextSnapshot.showCaptionAboveMedia !== undefined) request.showCaptionAboveMedia = nextSnapshot.showCaptionAboveMedia;
          await input.gateway.editCaption(request);
        }
      } catch (error) {
        const normalized = classifyTelegramError(error, edit === "text" ? "editMessageText" : "editMessageCaption");
        if (normalized.kind === "source_missing") {
          const missing = input.preparation.markMemberMissing(guard, target.memberKey, { method: normalized.method ?? "editMessageText", ...(normalized.code === undefined ? {} : { code: normalized.code }), description: normalized.description }, input.clock.now());
          guard = missing.nextGuard;
          if (missing.itemRemoved) return { kind: "deleted_external", itemId: item.id, operationId: claim.operationId };
          updatedMembers = input.queue.getCurrentMembers(item.id);
          nextAttribution = { ownership: "admin", previousMemberKey: target.memberKey };
        } else if (normalized.kind === "rate_limited") {
          const retry = retryAt(normalized, input.clock.now());
          input.preparation.scheduleRetry(claim.operationId, retry, normalized.kind, normalized.description, input.clock.now());
          return { kind: "retry_scheduled", itemId: item.id, retryAt: retry, operationId: claim.operationId };
        } else if (!normalized.description.toLowerCase().includes("message is not modified")) {
          input.preparation.markUncertain(claim.operationId, normalized.kind, normalized.description, input.clock.now());
          return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
        }
      }
      if (updatedMembers === members) updatedMembers = members.map((member) => member.memberKey === target.memberKey ? { ...member, snapshot: nextSnapshot! } : member);
      const completed = input.preparation.completeInPlaceRefresh(guard, updatedMembers, nextAttribution, revision, input.clock.now(), creditPolicy.revisionKey);
      return { kind: "prepared", itemId: item.id, preparationState: completed.preparationState, operationId: claim.operationId };
    } catch (error) {
      const normalized = classifyTelegramError(error);
      const description = error instanceof Error ? error.message : normalized.description;
      if (normalized.kind === "invalid_content_or_entities" || description.includes("Byline exceeds Telegram limit") || description.includes("Stored entity")) {
        input.preparation.markFailed(claim.operationId, "needs_edit", "refresh_preflight_failed", description, input.clock.now());
        return { kind: "blocked", itemId: item.id, status: "needs_edit", reason: "refresh_preflight_failed", operationId: claim.operationId };
      }
      if (mutationMayHaveStarted) {
        try { input.preparation.markUncertain(claim.operationId, normalized.kind, description, input.clock.now()); }
        catch { /* Preserve the operation evidence for startup reconciliation. */ }
        return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
      }
      throw error;
    }
  };

  const prepareClaim = async (claim: NonNullable<ReturnType<PreparationRepository["claimNextPreparation"]>>): Promise<PreparationOutcome> => {
    const done = input.operationTracker?.begin(claim.operationId);
    const knownOutputIds: MessageId[] = [];
    let mutationMayHaveStarted = false;
    let guard = claim.guard;
    try {
      let item = input.queue.findItemById(claim.itemId);
      if (!item) throw new Error("Claimed preparation item disappeared");
      const members = input.queue.getCapturedMembers(item.id, claim.guard.capturedSourceGeneration, claim.sourceIds);
      if (members.length === 0) throw new Error("Claimed preparation source set is empty");
      if (item.editorialFrozenAt !== undefined) {
        const adopted = input.preparation.completeInPlacePreparation(guard, members, item.attribution ?? { ownership: "none" }, item.nicknameRevisionApplied ?? item.nicknameRevisionWanted ?? 0, input.clock.now(), item.nicknameRevisionAppliedKey ?? item.nicknameRevisionWantedKey ?? "none");
        return { kind: "prepared", itemId: item.id, preparationState: adopted.preparationState, operationId: claim.operationId };
      }
      const creditPolicy = input.policy.resolveCreditPolicy(item.origin);
      input.queue.reconcileNicknamePolicy(item.id, creditPolicy);
      item = input.queue.findItemById(item.id) ?? item;
      if (claim.kind === "refresh") return await refreshClaim(claim, item, members);
      const deliveryMode = item.deliveryMode;
      if (!deliveryMode) {
        input.preparation.markFailed(claim.operationId, "needs_review", "missing_captured_policy", "Queue policy was not captured for this item", input.clock.now());
        return { kind: "blocked", itemId: item.id, status: "needs_review", reason: "missing_captured_policy", operationId: claim.operationId };
      }
      const alias = creditPolicy.alias;
      const classifiedPlan = classifyPublicationPlan({ origin: item.origin, contentType: item.contentType, channelIsWhitelisted: deliveryMode === "forward", ...(alias === undefined ? {} : { alias }) });
      const hasAdminCredit = members.some((member) => member.role === "credit") && item.attribution?.ownership === "admin";
      const plan = hasAdminCredit ? (deliveryMode === "forward" ? { kind: "forward" as const } : { kind: "copy" as const }) : classifiedPlan;
      const revision = creditPolicy.revision;
      if (plan.kind === "blocked") {
        const status = plan.reason === "unsupported_content" ? "blocked" : "needs_review";
        input.preparation.markFailed(claim.operationId, status, plan.reason, plan.reason, input.clock.now());
        return { kind: "blocked", itemId: item.id, status, reason: plan.reason, operationId: claim.operationId };
      }
      const capturedPolicyMode = deliveryMode;
      const transformsSource = plan.kind === "forward" ? false : item.origin.kind !== "absent";
      const transferMode: DeliveryMode = plan.kind === "forward" ? "forward" : "copy";
      const requiresInline = plan.kind === "copy_with_inline_byline";
      const requiresSeparate = plan.kind === "copy_with_separate_byline";
      let inline: { memberKey: string; text?: string; entities?: PreparedMember["snapshot"]["entities"]; caption?: string; captionEntities?: PreparedMember["snapshot"]["captionEntities"]; generatedText: string; placement: "inline_text" | "inline_caption" } | undefined;
      let separateText: string | undefined;
      let attribution: AttributionDescriptor = { ownership: "none" };
      if (requiresInline) {
        const captions = members.filter((member) => member.snapshot.caption !== undefined && member.snapshot.caption.length > 0);
        if (captions.length > 1) {
          input.preparation.markFailed(claim.operationId, "needs_review", "multiple_album_captions", "Album has multiple caption-bearing members", input.clock.now());
          return { kind: "blocked", itemId: item.id, status: "needs_review", reason: "multiple_album_captions", operationId: claim.operationId };
        }
        const target = item.contentType === "text" && members.length === 1 ? members[0]! : captions[0] ?? members[0]!;
        const placement = target.snapshot.contentType === "text" ? "inline_text" : "inline_caption";
        if (placement === "inline_caption" && !isInlineCaptionContent(target.snapshot.contentType)) {
          input.preparation.markFailed(claim.operationId, "needs_edit", "content_cannot_carry_credit", "This content cannot carry an inline credit", input.clock.now());
          return { kind: "blocked", itemId: item.id, status: "needs_edit", reason: "content_cannot_carry_credit", operationId: claim.operationId };
        }
        const base = placement === "inline_text" ? target.snapshot.text : target.snapshot.caption;
        let rendered;
        try {
          rendered = appendInlineByline(base, plan.name, placement === "inline_text" ? TEXT_LIMIT : CAPTION_LIMIT, placement === "inline_text" ? target.snapshot.entities : target.snapshot.captionEntities);
        } catch (error) {
          const description = error instanceof Error ? error.message : "Generated credit cannot fit in Telegram content limits";
          input.preparation.markFailed(claim.operationId, "needs_edit", "byline_preflight_failed", description, input.clock.now());
          return { kind: "blocked", itemId: item.id, status: "needs_edit", reason: "byline_preflight_failed", operationId: claim.operationId };
        }
        inline = { memberKey: target.memberKey, generatedText: rendered.addedText, placement, ...(placement === "inline_text" ? { text: rendered.text, entities: rendered.entities } : { caption: rendered.text, captionEntities: rendered.entities }) };
        attribution = botInlineAttribution(base ?? "", rendered.addedText, target.memberKey, placement, revision);
      } else if (requiresSeparate) {
        separateText = separateByline(plan.name);
        attribution = { ownership: "bot", placement: "separate", memberKey: `credit:${claim.operationId}`, generatedText: separateText, generatedStartUtf16: 0, generatedLengthUtf16: separateText.length, appliedNicknameRevision: revision };
      }
      let contentSteps: TransferStep[];
      try { contentSteps = transformsSource ? buildSteps(members, transferMode) : []; }
      catch (error) {
        const description = error instanceof Error ? error.message : "Queue member grouping requires review";
        input.preparation.markFailed(claim.operationId, "needs_review", "invalid_member_grouping", description, input.clock.now());
        return { kind: "blocked", itemId: item.id, status: "needs_review", reason: "invalid_member_grouping", operationId: claim.operationId };
      }
      const contractSteps = contentSteps.length > 0 ? contentSteps : buildSteps(members, capturedPolicyMode);
      const contract: PreparationContractV1 = {
        version: 1,
        kind: claim.kind,
        itemId: item.id,
        capturedContentVersion: claim.guard.capturedContentVersion,
        capturedSourceGeneration: claim.guard.capturedSourceGeneration,
        originalOrigin: item.origin,
        deliveryMode: capturedPolicyMode,
        capturedMembers: members,
        steps: contractSteps,
        targetNicknameRevision: revision,
        targetNicknameKey: creditPolicy.revisionKey,
        attribution,
      };
      if (plan.kind === "copy_with_inline_byline" || plan.kind === "copy_with_separate_byline") contract.targetName = plan.name;
      input.preparation.persistContract(claim.operationId, contract, input.clock.now());

      if (!transformsSource) {
        const prepared = inPlacePreparedMembers(members, capturedPolicyMode);
        const completed = input.preparation.completeInPlacePreparation(guard, prepared, attribution, revision, input.clock.now(), creditPolicy.revisionKey);
        return { kind: "prepared", itemId: item.id, preparationState: completed.preparationState, operationId: claim.operationId };
      }

      const transferred: PreparedTransferOutput[] = [];
      for (const step of contentSteps) {
        try {
          const outputs = await transferPreparedStep({
            gateway: input.gateway,
            targetChatId: input.queueChannelId,
            sourceChatId: input.queueChannelId,
            step,
            beforeRequest: () => { mutationMayHaveStarted = true; input.preparation.setPhase(claim.operationId, "transfer_pending", input.clock.now()); },
            recordOutput: (output) => {
              knownOutputIds.push(output.messageId);
              input.preparation.recordOutput(claim.operationId, { ...output, outputKey: `${claim.operationId}:${output.messageId}`, ...(output.sourceMemberKey === undefined ? {} : { sourceMemberKey: output.sourceMemberKey }) }, input.clock.now());
            },
          });
          transferred.push(...outputs);
        } catch (error) {
          const normalized = classifyTelegramError(error);
          if (normalized.kind === "source_missing" && !step.grouped && step.members.length === 1) {
            const missing = input.preparation.markMemberMissing(guard, step.members[0]!.memberKey, { method: normalized.method ?? "copyMessage", ...(normalized.code === undefined ? {} : { code: normalized.code }), description: normalized.description }, input.clock.now());
            guard = missing.nextGuard;
            if (missing.itemRemoved) return { kind: "deleted_external", itemId: item.id, operationId: claim.operationId };
            continue;
          }
          if (normalized.kind === "rate_limited") {
            if (!await cleanupKnownOutputs(knownOutputIds)) {
              input.preparation.markUncertain(claim.operationId, "cleanup_after_rate_limit_failed", "Known preparation outputs could not be removed after a rate limit", input.clock.now());
              return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
            }
            const retry = retryAt(normalized, input.clock.now());
            input.preparation.scheduleRetry(claim.operationId, retry, normalized.kind, normalized.description, input.clock.now());
            return { kind: "retry_scheduled", itemId: item.id, retryAt: retry, operationId: claim.operationId };
          }
          if (["unsupported_content", "invalid_content_or_entities", "permission_denied", "content_protected"].includes(normalized.kind) && await cleanupKnownOutputs(knownOutputIds)) {
            const status = normalized.kind === "invalid_content_or_entities" ? "needs_edit" : normalized.kind === "unsupported_content" ? "blocked" : "needs_review";
            input.preparation.markFailed(claim.operationId, status, normalized.kind, normalized.description, input.clock.now());
            return { kind: "blocked", itemId: item.id, status, reason: normalized.kind, operationId: claim.operationId };
          }
          input.preparation.markUncertain(claim.operationId, normalized.kind, normalized.description, input.clock.now());
          input.logger.error("preparation_uncertain", { itemId: item.id, operationId: claim.operationId, method: normalized.method, knownOutputIds: knownOutputIds.length });
          return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
        }
      }

      if (transferred.length === 0) return { kind: "deleted_external", itemId: item.id, operationId: claim.operationId };
      const outputMembers: PreparedMember[] = [];
      const inputByKey = new Map(members.map((member) => [member.memberKey, member]));
      for (const [ordinal, output] of transferred.entries()) {
        if (output.sourceMemberKey === undefined) {
          input.preparation.markUncertain(claim.operationId, "unmapped_transfer_output", "Telegram output cannot be associated with an original album member", input.clock.now());
          return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
        }
        const source = inputByKey.get(output.sourceMemberKey);
        if (!source) throw new Error("Prepared transfer output references an unknown source member");
        const sourceStep = contentSteps.find((step) => step.stepKey === output.stepKey);
        if (!sourceStep) throw new Error("Prepared transfer output references an unknown step");
        outputMembers.push(snapshotForOutput(source, output, ordinal, sourceStep.mode, input.clock.now()));
      }

      if (inline) {
        const targetIndex = outputMembers.findIndex((member) => member.memberKey === inline!.memberKey);
        const target = outputMembers[targetIndex];
        if (!target) {
          if (await cleanupKnownOutputs(knownOutputIds)) {
            input.preparation.markFailed(claim.operationId, "needs_review", "byline_member_missing", "The source member for the generated credit disappeared", input.clock.now());
            return { kind: "blocked", itemId: item.id, status: "needs_review", reason: "byline_member_missing", operationId: claim.operationId };
          }
          input.preparation.markUncertain(claim.operationId, "byline_member_missing", "The source member for the generated credit disappeared", input.clock.now());
          return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
        }
        const { entities: oldEntities, captionEntities: oldCaptionEntities, ...snapshotBase } = target.snapshot;
        const snapshot: StoredMessageSnapshot = { ...snapshotBase };
        let edit: "text" | "caption";
        if (inline.placement === "inline_text") {
          if (inline.text !== undefined) snapshot.text = inline.text;
          if (inline.entities !== undefined) snapshot.entities = inline.entities;
          edit = "text";
        } else {
          if (inline.caption !== undefined) snapshot.caption = inline.caption;
          if (inline.captionEntities !== undefined) snapshot.captionEntities = inline.captionEntities;
          edit = "caption";
        }
        if (inline.placement === "inline_text" && inline.entities === undefined && oldEntities !== undefined) delete snapshot.entities;
        if (inline.placement === "inline_caption" && inline.captionEntities === undefined && oldCaptionEntities !== undefined) delete snapshot.captionEntities;
        snapshot.contentFingerprint = fingerprintSnapshotContent(snapshot);
        input.preparation.expectEdit(claim.operationId, input.queueChannelId, target.messageId, snapshot, input.clock.now());
        input.preparation.setPhase(claim.operationId, "attribution_pending", input.clock.now());
        mutationMayHaveStarted = true;
        try {
          if (edit === "text") {
            const editInput = { chatId: input.queueChannelId, messageId: target.messageId, text: snapshot.text ?? "" } as Parameters<TelegramGateway["editText"]>[0];
            if (snapshot.entities !== undefined) editInput.entities = snapshot.entities;
            if (snapshot.linkPreviewOptions?.isDisabled !== undefined) editInput.linkPreviewIsDisabled = snapshot.linkPreviewOptions.isDisabled;
            await input.gateway.editText(editInput);
          } else {
            const editInput = { chatId: input.queueChannelId, messageId: target.messageId, caption: snapshot.caption ?? "" } as Parameters<TelegramGateway["editCaption"]>[0];
            if (snapshot.captionEntities !== undefined) editInput.captionEntities = snapshot.captionEntities;
            if (snapshot.showCaptionAboveMedia !== undefined) editInput.showCaptionAboveMedia = snapshot.showCaptionAboveMedia;
            await input.gateway.editCaption(editInput);
          }
          outputMembers[targetIndex] = { ...target, snapshot };
        } catch (error) {
          const normalized = classifyTelegramError(error);
          if (["rate_limited", "transient_network", "transient_server", "ambiguous_send_result"].includes(normalized.kind)) {
            if (normalized.kind === "rate_limited") {
              if (!await cleanupKnownOutputs(knownOutputIds)) {
                input.preparation.markUncertain(claim.operationId, "cleanup_after_rate_limit_failed", "Known preparation outputs could not be removed after a rate limit", input.clock.now());
                return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
              }
              const retry = retryAt(normalized, input.clock.now());
              input.preparation.scheduleRetry(claim.operationId, retry, normalized.kind, normalized.description, input.clock.now());
              return { kind: "retry_scheduled", itemId: item.id, retryAt: retry, operationId: claim.operationId };
            }
            input.preparation.markUncertain(claim.operationId, normalized.kind, normalized.description, input.clock.now());
            return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
          }
          if (await cleanupKnownOutputs(knownOutputIds)) {
            const status = normalized.kind === "invalid_content_or_entities" ? "needs_edit" : "needs_review";
            input.preparation.markFailed(claim.operationId, status, normalized.kind, normalized.description, input.clock.now());
            return { kind: "blocked", itemId: item.id, status, reason: normalized.kind, operationId: claim.operationId };
          }
          input.preparation.markUncertain(claim.operationId, normalized.kind, normalized.description, input.clock.now());
          return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
        }
      }

      if (separateText !== undefined) {
        input.preparation.setPhase(claim.operationId, "attribution_pending", input.clock.now());
        mutationMayHaveStarted = true;
        try {
          const creditId = await input.gateway.sendText({ chatId: input.queueChannelId, text: separateText });
          knownOutputIds.push(creditId);
          const mediaFingerprint = createHash("sha256").update("{}").digest("hex");
          const creditSnapshot = { schemaVersion: 2 as const, chatId: input.queueChannelId, messageId: creditId, ordinal: outputMembers.length, contentType: "text" as const, text: separateText, origin: item.origin, nativeOrigin: { kind: "absent" as const }, telegramDate: input.clock.now(), hasReplyMarkup: false, mediaFingerprint, contentFingerprint: "" };
          creditSnapshot.contentFingerprint = fingerprintSnapshotContent(creditSnapshot);
          input.preparation.recordOutput(claim.operationId, { chatId: input.queueChannelId, messageId: creditId, ordinal: outputMembers.length, outputKey: `${claim.operationId}:${creditId}`, stepKey: "credit", role: "credit", snapshot: creditSnapshot }, input.clock.now());
          outputMembers.push({ memberKey: `credit:${claim.operationId}`, messageId: creditId, role: "credit", deliveryMode: "copy", snapshot: creditSnapshot });
        } catch (error) {
          const normalized = classifyTelegramError(error, "sendMessage");
          if (normalized.kind === "rate_limited") {
            if (!await cleanupKnownOutputs(knownOutputIds)) {
              input.preparation.markUncertain(claim.operationId, "cleanup_after_rate_limit_failed", "Known preparation outputs could not be removed after a rate limit", input.clock.now());
              return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
            }
            const retry = retryAt(normalized, input.clock.now());
            input.preparation.scheduleRetry(claim.operationId, retry, normalized.kind, normalized.description, input.clock.now());
            return { kind: "retry_scheduled", itemId: item.id, retryAt: retry, operationId: claim.operationId };
          }
          if (normalized.kind === "transient_network" || normalized.kind === "transient_server" || normalized.kind === "ambiguous_send_result") {
            input.preparation.markUncertain(claim.operationId, normalized.kind, normalized.description, input.clock.now());
            return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
          }
          if (await cleanupKnownOutputs(knownOutputIds)) {
            input.preparation.markFailed(claim.operationId, "blocked", normalized.kind, normalized.description, input.clock.now());
            return { kind: "blocked", itemId: item.id, status: "blocked", reason: normalized.kind, operationId: claim.operationId };
          }
          input.preparation.markUncertain(claim.operationId, normalized.kind, normalized.description, input.clock.now());
          return { kind: "uncertain", itemId: item.id, operationId: claim.operationId };
        }
      }

      const result = { members: outputMembers, attribution, nicknameRevisionApplied: revision, nicknameRevisionAppliedKey: creditPolicy.revisionKey };
      input.preparation.recordCompleteResult(claim.operationId, result, input.clock.now());
      const installed = input.preparation.installPreparedGeneration(claim.operationId, input.clock.now());
      let cleanupError: string | undefined;
      try { await input.gateway.deleteMessages(input.queueChannelId, installed.oldSourceIds); }
      catch (error) {
        const normalized = classifyTelegramError(error, "deleteMessages");
        if (normalized.kind !== "source_missing") cleanupError = normalized.description;
      }
      input.preparation.finishCleanup(claim.operationId, input.clock.now(), cleanupError);
      return { kind: "prepared", itemId: item.id, preparationState: installed.preparationState, operationId: claim.operationId };
    } catch (error) {
      const normalized = classifyTelegramError(error);
      input.logger.error("preparation_failed", { itemId: claim.itemId, operationId: claim.operationId, kind: normalized.kind, error: normalized.description });
      if (!mutationMayHaveStarted) {
        try { input.preparation.markFailed(claim.operationId, "needs_review", normalized.kind, normalized.description, input.clock.now()); }
        catch { /* Keep an already transitioned operation as the durable owner. */ }
        return { kind: "blocked", itemId: claim.itemId, status: "needs_review", reason: normalized.kind, operationId: claim.operationId };
      }
      try { input.preparation.markUncertain(claim.operationId, normalized.kind, normalized.description, input.clock.now()); }
      catch { /* Preserve the first durable owner/state if reconciliation already changed it. */ }
      return { kind: "uncertain", itemId: claim.itemId, operationId: claim.operationId };
    } finally {
      done?.();
    }
  };

  const cleanupKnownOutputs = async (ids: readonly MessageId[]): Promise<boolean> => {
    if (ids.length === 0) return true;
    try { await input.gateway.deleteMessages(input.queueChannelId, ids); return true; }
    catch (error) { return classifyTelegramError(error, "deleteMessages").kind === "source_missing"; }
  };

  const prepareNext = async (): Promise<PreparationOutcome> => {
    const claim = input.preparation.claimNextPreparation(input.clock.now(), input.bootId);
    if (!claim) return { kind: "empty" };
    return prepareClaim(claim);
  };

  const cleanupPending = async (limit = 25): Promise<number> => {
    let attempts = 0;
    for (const operation of input.preparation.listCleanupPending().slice(0, limit)) {
      attempts += 1;
      try {
        await input.gateway.deleteMessages(input.queueChannelId, operation.sourceIds);
        input.preparation.finishCleanup(operation.operationId, input.clock.now());
      } catch (error) {
        const normalized = classifyTelegramError(error, "deleteMessages");
        if (normalized.kind === "source_missing") input.preparation.finishCleanup(operation.operationId, input.clock.now());
        else input.preparation.finishCleanup(operation.operationId, input.clock.now(), normalized.description);
      }
    }
    return attempts;
  };

  const recover = () => input.preparation.recoverExpiredOperations(input.clock.now(), input.bootId);

  return { prepareNext, cleanupPending, recover };
};

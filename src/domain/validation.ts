import type { AttributionDescriptor, ContentType, DeliveryMode, ExecutionProgress, MemberRole, MessageEntity, PreparationContractV1, PreparedMember, PreparedPublicationContractV2, PreparedRenewalContractV2, PublicationContract, RenewalExecutionProgress, SemanticOrigin, StoredMessageSnapshot, TransferStep } from "../types";
import { asChatId, asMessageId, asUserId, type MessageId } from "../types";

export class StoredDataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredDataValidationError";
  }
}

const contentTypes = new Set<ContentType>([
  "text", "photo", "video", "animation", "audio", "document", "voice", "sticker", "video_note", "contact", "location", "venue", "dice", "poll", "game", "paid_media", "giveaway", "service", "unknown",
]);

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StoredDataValidationError("Expected a JSON object");
  return value as Record<string, unknown>;
};

const integer = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value)) throw new StoredDataValidationError(`${field} must be a safe integer`);
  return value as number;
};

const logicalStatuses = new Set<PublicationContract["capturedLogicalStatus"]>([
  "collecting", "queued", "publishing", "published_cleanup_pending", "blocked", "needs_edit", "needs_review", "uncertain_publish", "delete_blocked", "done", "deleted", "deleted_external",
]);

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new StoredDataValidationError(`${field} must be a string`);
  return value;
};

const validateEntity = (value: unknown): MessageEntity => {
  const candidate = record(value);
  const result: MessageEntity = {
    type: typeof candidate.type === "string" ? candidate.type : (() => { throw new StoredDataValidationError("entity.type must be a string"); })(),
    offset: integer(candidate.offset, "entity.offset"),
    length: integer(candidate.length, "entity.length"),
  };
  if (result.offset < 0 || result.length < 0) throw new StoredDataValidationError("entity offsets must be non-negative");
  const url = optionalString(candidate.url, "entity.url");
  const language = optionalString(candidate.language, "entity.language");
  const customEmojiId = optionalString(candidate.customEmojiId, "entity.customEmojiId");
  if (url !== undefined) result.url = url;
  if (language !== undefined) result.language = language;
  if (customEmojiId !== undefined) result.customEmojiId = customEmojiId;
  if (candidate.user !== undefined) {
    const user = record(candidate.user);
    const firstName = optionalString(user.firstName, "entity.user.firstName");
    if (firstName === undefined) throw new StoredDataValidationError("entity.user.firstName is required");
    const lastName = optionalString(user.lastName, "entity.user.lastName");
    result.user = { id: asUserId(integer(user.id, "entity.user.id")), firstName };
    if (lastName !== undefined) result.user.lastName = lastName;
  }
  return result;
};

export const validateSemanticOrigin = (value: unknown): SemanticOrigin => {
  const candidate = record(value);
  if (typeof candidate.kind !== "string") throw new StoredDataValidationError("origin.kind is required");
  switch (candidate.kind) {
    case "absent": return { kind: "absent" };
    case "unknown": {
      const type = optionalString(candidate.type, "origin.type");
      if (type === undefined) throw new StoredDataValidationError("origin.type is required");
      return { kind: "unknown", type };
    }
    case "hidden_user": {
      const senderUserName = optionalString(candidate.senderUserName, "origin.senderUserName");
      if (senderUserName === undefined) throw new StoredDataValidationError("origin.senderUserName is required");
      return { kind: "hidden_user", senderUserName };
    }
    case "channel":
    case "chat": {
      const chatId = asChatId(integer(candidate.chatId, "origin.chatId"));
      const username = optionalString(candidate.username, "origin.username");
      const title = optionalString(candidate.title, "origin.title");
      const result: SemanticOrigin = candidate.kind === "channel" ? { kind: "channel", chatId } : { kind: "chat", chatId };
      if (username !== undefined) result.username = username;
      if (title !== undefined) result.title = title;
      if (result.kind === "channel") {
        const authorSignature = optionalString(candidate.authorSignature, "origin.authorSignature");
        if (authorSignature !== undefined) result.authorSignature = authorSignature;
      }
      return result;
    }
    case "user": {
      const displayName = optionalString(candidate.displayName, "origin.displayName");
      if (displayName === undefined) throw new StoredDataValidationError("origin.displayName is required");
      const result: SemanticOrigin = { kind: "user", userId: asUserId(integer(candidate.userId, "origin.userId")), displayName };
      const username = optionalString(candidate.username, "origin.username");
      if (username !== undefined) result.username = username;
      return result;
    }
    default: throw new StoredDataValidationError(`Unsupported origin kind: ${candidate.kind}`);
  }
};

const validateEntities = (value: unknown, field: string): readonly MessageEntity[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new StoredDataValidationError(`${field} must be an array`);
  return value.map(validateEntity);
};

export const validateStoredMessageSnapshot = (value: unknown): StoredMessageSnapshot => {
  const candidate = record(value);
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) throw new StoredDataValidationError("Unsupported snapshot schema version");
  const contentType = candidate.contentType;
  if (typeof contentType !== "string" || !contentTypes.has(contentType as ContentType)) throw new StoredDataValidationError("Invalid snapshot content type");
  if (typeof candidate.hasReplyMarkup !== "boolean") throw new StoredDataValidationError("hasReplyMarkup must be boolean");
  const result: StoredMessageSnapshot = {
    schemaVersion: candidate.schemaVersion,
    chatId: asChatId(integer(candidate.chatId, "chatId")),
    messageId: asMessageId(integer(candidate.messageId, "messageId")),
    ordinal: integer(candidate.ordinal, "ordinal"),
    contentType: contentType as ContentType,
    origin: validateSemanticOrigin(candidate.origin),
    telegramDate: integer(candidate.telegramDate, "telegramDate"),
    hasReplyMarkup: candidate.hasReplyMarkup,
  };
  if (result.messageId <= 0) throw new StoredDataValidationError("messageId must be positive");
  if (result.ordinal < 0) throw new StoredDataValidationError("ordinal must be non-negative");
  const mediaGroupId = optionalString(candidate.mediaGroupId, "mediaGroupId");
  const text = optionalString(candidate.text, "text");
  const caption = optionalString(candidate.caption, "caption");
  const editDate = candidate.editDate === undefined ? undefined : integer(candidate.editDate, "editDate");
  if (mediaGroupId !== undefined) result.mediaGroupId = mediaGroupId;
  if (text !== undefined) result.text = text;
  if (caption !== undefined) result.caption = caption;
  if (editDate !== undefined) result.editDate = editDate;
  const entities = validateEntities(candidate.entities, "entities");
  const captionEntities = validateEntities(candidate.captionEntities, "captionEntities");
  if (entities !== undefined) result.entities = entities;
  if (captionEntities !== undefined) result.captionEntities = captionEntities;
  if (candidate.showCaptionAboveMedia !== undefined) {
    if (typeof candidate.showCaptionAboveMedia !== "boolean") throw new StoredDataValidationError("showCaptionAboveMedia must be boolean");
    result.showCaptionAboveMedia = candidate.showCaptionAboveMedia;
  }
  if (candidate.telegramUpdateId !== undefined) {
    const updateId = integer(candidate.telegramUpdateId, "telegramUpdateId");
    if (updateId < 0) throw new StoredDataValidationError("telegramUpdateId must be non-negative");
    result.telegramUpdateId = updateId;
  }
  if (candidate.nativeOrigin !== undefined) result.nativeOrigin = validateSemanticOrigin(candidate.nativeOrigin);
  const contentFingerprint = optionalString(candidate.contentFingerprint, "contentFingerprint");
  if (contentFingerprint !== undefined) {
    if (!/^[0-9a-f]{64}$/u.test(contentFingerprint)) throw new StoredDataValidationError("contentFingerprint must be a SHA-256 hex digest");
    result.contentFingerprint = contentFingerprint;
  }
  const mediaFingerprint = optionalString(candidate.mediaFingerprint, "mediaFingerprint");
  if (mediaFingerprint !== undefined) {
    if (!/^[0-9a-f]{64}$/u.test(mediaFingerprint)) throw new StoredDataValidationError("mediaFingerprint must be a SHA-256 hex digest");
    result.mediaFingerprint = mediaFingerprint;
  }
  if (candidate.linkPreviewOptions !== undefined) {
    const options = record(candidate.linkPreviewOptions);
    const linkOptions: NonNullable<StoredMessageSnapshot["linkPreviewOptions"]> = {};
    for (const key of ["isDisabled", "preferSmallMedia", "preferLargeMedia", "showAboveText"] as const) {
      if (options[key] !== undefined) {
        if (typeof options[key] !== "boolean") throw new StoredDataValidationError(`linkPreviewOptions.${key} must be boolean`);
        linkOptions[key] = options[key];
      }
    }
    const url = optionalString(options.url, "linkPreviewOptions.url");
    if (url !== undefined) linkOptions.url = url;
    result.linkPreviewOptions = linkOptions;
  }
  if (candidate.replyMarkup !== undefined) result.replyMarkup = record(candidate.replyMarkup);
  return result;
};

export const parseStoredMessageSnapshot = (value: string): StoredMessageSnapshot => {
  try {
    return validateStoredMessageSnapshot(JSON.parse(value));
  } catch (error) {
    if (error instanceof StoredDataValidationError) throw error;
    throw new StoredDataValidationError("Invalid stored snapshot JSON");
  }
};

export const validateOrderedMessageIds = (value: unknown, field = "messageIds"): MessageId[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new StoredDataValidationError(`${field} must contain 1–100 IDs`);
  const ids = value.map((candidate, index) => {
    const id = integer(candidate, `${field}[${index}]`);
    if (id <= 0) throw new StoredDataValidationError(`${field}[${index}] must be positive`);
    return asMessageId(id);
  });
  for (let index = 1; index < ids.length; index += 1) if (ids[index]! <= ids[index - 1]!) throw new StoredDataValidationError(`${field} must be strictly increasing`);
  return ids;
};

export const validateJsonPayload = (value: unknown, field: string): Record<string, unknown> => {
  const candidate = record(value);
  for (const key of Object.keys(candidate)) if (key.length > 64) throw new StoredDataValidationError(`${field} contains an oversized key`);
  return candidate;
};

export const validatePublicationContract = (value: unknown): PublicationContract => {
  const candidate = record(value);
  const sourceIds = validateOrderedMessageIds(candidate.sourceIds, "contract.sourceIds");
  const capturedLogicalStatus = candidate.capturedLogicalStatus;
  if (typeof capturedLogicalStatus !== "string" || !logicalStatuses.has(capturedLogicalStatus as PublicationContract["capturedLogicalStatus"])) throw new StoredDataValidationError("contract.capturedLogicalStatus is invalid");
  const policy = record(candidate.policy);
  if (typeof policy.kind !== "string") throw new StoredDataValidationError("contract.policy.kind is required");
  switch (policy.kind) {
    case "forward": if (policy.reason !== "whitelisted_channel") throw new StoredDataValidationError("contract.policy.reason is invalid"); break;
    case "copy": if (!["unlisted_channel", "direct_queue_post", "chat_origin", "unknown_origin"].includes(String(policy.reason))) throw new StoredDataValidationError("contract.policy.reason is invalid"); break;
    case "copy_with_inline_byline":
    case "copy_with_separate_byline": if (typeof policy.name !== "string" || policy.name.length === 0) throw new StoredDataValidationError("contract.policy.name is required"); break;
    case "blocked": if (!["unknown_origin", "unsupported_content", "mixed_album_origin"].includes(String(policy.reason))) throw new StoredDataValidationError("contract.policy.reason is invalid"); break;
    default: throw new StoredDataValidationError("contract.policy.kind is invalid");
  }
  if (typeof candidate.requiresInlineEdit !== "boolean") throw new StoredDataValidationError("contract.requiresInlineEdit must be boolean");
  if (typeof candidate.requiresSeparateByline !== "boolean") throw new StoredDataValidationError("contract.requiresSeparateByline must be boolean");
  const result: PublicationContract = {
    capturedLogicalStatus: capturedLogicalStatus as PublicationContract["capturedLogicalStatus"],
    capturedContentVersion: integer(candidate.capturedContentVersion, "contract.capturedContentVersion"),
    capturedSourceGeneration: integer(candidate.capturedSourceGeneration, "contract.capturedSourceGeneration"),
    sourceIds,
    policy: policy as unknown as PublicationContract["policy"],
    expectedTransferredMessageCount: integer(candidate.expectedTransferredMessageCount, "contract.expectedTransferredMessageCount"),
    expectedOutputMessageCount: integer(candidate.expectedOutputMessageCount, "contract.expectedOutputMessageCount"),
    requiresInlineEdit: candidate.requiresInlineEdit,
    requiresSeparateByline: candidate.requiresSeparateByline,
  };
  const bylineText = optionalString(candidate.bylineText, "contract.bylineText");
  if (bylineText !== undefined) result.bylineText = bylineText;
  if (result.capturedContentVersion < 1 || result.capturedSourceGeneration < 0 || result.expectedTransferredMessageCount !== sourceIds.length || result.expectedOutputMessageCount < sourceIds.length || result.expectedOutputMessageCount !== sourceIds.length + (result.requiresSeparateByline ? 1 : 0) || result.requiresInlineEdit && result.requiresSeparateByline) throw new StoredDataValidationError("contract output counts or attribution flags are inconsistent");
  if ((result.policy.kind === "copy_with_inline_byline" || result.policy.kind === "copy_with_separate_byline") && result.bylineText === undefined) throw new StoredDataValidationError("contract.bylineText is required for attributed copies");
  return result;
};

const validateDeliveryMode = (value: unknown, field: string): DeliveryMode => {
  if (value !== "copy" && value !== "forward") throw new StoredDataValidationError(`${field} must be copy or forward`);
  return value;
};

export const validatePreparedMember = (value: unknown, field = "preparedMember"): PreparedMember => {
  const candidate = record(value);
  const memberKey = optionalString(candidate.memberKey, `${field}.memberKey`);
  if (!memberKey) throw new StoredDataValidationError(`${field}.memberKey is required`);
  const messageId = integer(candidate.messageId, `${field}.messageId`);
  if (messageId <= 0) throw new StoredDataValidationError(`${field}.messageId must be positive`);
  if (candidate.role !== "content" && candidate.role !== "credit") throw new StoredDataValidationError(`${field}.role is invalid`);
  const snapshot = validateStoredMessageSnapshot(candidate.snapshot);
  if (snapshot.messageId !== messageId) throw new StoredDataValidationError(`${field}.snapshot.messageId does not match its member`);
  const member: PreparedMember = { memberKey, messageId: asMessageId(messageId), role: candidate.role as MemberRole, deliveryMode: validateDeliveryMode(candidate.deliveryMode, `${field}.deliveryMode`), snapshot };
  const albumKey = optionalString(candidate.albumKey, `${field}.albumKey`);
  if (albumKey !== undefined) member.albumKey = albumKey;
  return member;
};

const validateTransferStep = (value: unknown, field: string): TransferStep => {
  const candidate = record(value);
  const stepKey = optionalString(candidate.stepKey, `${field}.stepKey`);
  if (!stepKey) throw new StoredDataValidationError(`${field}.stepKey is required`);
  const mode = validateDeliveryMode(candidate.mode, `${field}.mode`);
  if (typeof candidate.grouped !== "boolean") throw new StoredDataValidationError(`${field}.grouped must be boolean`);
  if (!Array.isArray(candidate.members) || candidate.members.length === 0) throw new StoredDataValidationError(`${field}.members must not be empty`);
  const members = candidate.members.map((member, index) => validatePreparedMember(member, `${field}.members[${index}]`));
  if (members.some((member) => member.deliveryMode !== mode)) throw new StoredDataValidationError(`${field}.members use inconsistent delivery modes`);
  if (candidate.grouped && (members.length < 2 || !members[0]?.albumKey || members.some((member) => member.albumKey !== members[0]!.albumKey))) throw new StoredDataValidationError(`${field} is not one complete album group`);
  if (!candidate.grouped && members.some((member) => member.albumKey !== undefined)) throw new StoredDataValidationError(`${field} must preserve album grouping`);
  return { stepKey, mode, grouped: candidate.grouped, members };
};

export const validateAttributionDescriptor = (value: unknown): AttributionDescriptor => {
  const candidate = record(value);
  if (candidate.ownership === "none") return { ownership: "none" };
  if (candidate.ownership === "admin") {
    const result: AttributionDescriptor = { ownership: "admin" };
    const previousMemberKey = optionalString(candidate.previousMemberKey, "attribution.previousMemberKey");
    if (previousMemberKey !== undefined) return { ownership: "admin", previousMemberKey };
    return result;
  }
  if (candidate.ownership === "bot") {
    if (candidate.placement !== "inline_text" && candidate.placement !== "inline_caption" && candidate.placement !== "separate") throw new StoredDataValidationError("attribution.placement is invalid");
    const memberKey = optionalString(candidate.memberKey, "attribution.memberKey");
    const generatedText = optionalString(candidate.generatedText, "attribution.generatedText");
    if (!memberKey || generatedText === undefined) throw new StoredDataValidationError("bot attribution member key and text are required");
    const start = integer(candidate.generatedStartUtf16, "attribution.generatedStartUtf16");
    const length = integer(candidate.generatedLengthUtf16, "attribution.generatedLengthUtf16");
    const revision = integer(candidate.appliedNicknameRevision, "attribution.appliedNicknameRevision");
    if (start < 0 || length < 0 || length !== generatedText.length || revision < 0) throw new StoredDataValidationError("bot attribution offsets or revision are invalid");
    return { ownership: "bot", placement: candidate.placement, memberKey, generatedText, generatedStartUtf16: start, generatedLengthUtf16: length, appliedNicknameRevision: revision };
  }
  throw new StoredDataValidationError("attribution.ownership is invalid");
};

export const validatePreparationContractV1 = (value: unknown): PreparationContractV1 => {
  const candidate = record(value);
  if (candidate.version !== 1 || (candidate.kind !== "prepare" && candidate.kind !== "refresh")) throw new StoredDataValidationError("Preparation contract version or kind is invalid");
  if (!Array.isArray(candidate.capturedMembers) || candidate.capturedMembers.length === 0 || !Array.isArray(candidate.steps)) throw new StoredDataValidationError("Preparation contract members and steps are required");
  const capturedMembers = candidate.capturedMembers.map((member, index) => validatePreparedMember(member, `contract.capturedMembers[${index}]`));
  const steps = candidate.steps.map((step, index) => validateTransferStep(step, `contract.steps[${index}]`));
  const itemId = integer(candidate.itemId, "contract.itemId");
  const capturedContentVersion = integer(candidate.capturedContentVersion, "contract.capturedContentVersion");
  const capturedSourceGeneration = integer(candidate.capturedSourceGeneration, "contract.capturedSourceGeneration");
  const targetNicknameRevision = integer(candidate.targetNicknameRevision, "contract.targetNicknameRevision");
  if (itemId <= 0 || capturedContentVersion < 1 || capturedSourceGeneration < 0 || targetNicknameRevision < 0) throw new StoredDataValidationError("Preparation contract versions are invalid");
  const result: PreparationContractV1 = {
    version: 1, kind: candidate.kind, itemId, capturedContentVersion, capturedSourceGeneration,
    originalOrigin: validateSemanticOrigin(candidate.originalOrigin), deliveryMode: validateDeliveryMode(candidate.deliveryMode, "contract.deliveryMode"),
    capturedMembers, steps, targetNicknameRevision, attribution: validateAttributionDescriptor(candidate.attribution),
  };
  const targetNicknameKey = optionalString(candidate.targetNicknameKey, "contract.targetNicknameKey");
  if (targetNicknameKey !== undefined) {
    if (targetNicknameKey.length === 0) throw new StoredDataValidationError("contract.targetNicknameKey must not be empty");
    result.targetNicknameKey = targetNicknameKey;
  }
  const targetName = optionalString(candidate.targetName, "contract.targetName");
  if (targetName !== undefined) result.targetName = targetName;
  const keys = new Set(capturedMembers.map((member) => member.memberKey));
  if (keys.size !== capturedMembers.length || steps.some((step) => step.members.some((member) => !keys.has(member.memberKey)))) throw new StoredDataValidationError("Preparation contract source associations are inconsistent");
  return result;
};

export const validatePreparedPublicationContractV2 = (value: unknown): PreparedPublicationContractV2 => {
  const candidate = record(value);
  if (candidate.version !== 2 || candidate.kind !== "prepared_delivery") throw new StoredDataValidationError("Prepared publication contract version or kind is invalid");
  if (!Array.isArray(candidate.sourceIds) || !Array.isArray(candidate.steps) || candidate.steps.length === 0) throw new StoredDataValidationError("Prepared publication contract requires source IDs and steps");
  const sourceIds = candidate.sourceIds.map((id, index) => {
    const parsed = integer(id, `contract.sourceIds[${index}]`);
    if (parsed <= 0) throw new StoredDataValidationError("Prepared source IDs must be positive");
    return asMessageId(parsed);
  });
  const steps = candidate.steps.map((step, index) => validateTransferStep(step, `contract.steps[${index}]`));
  const capturedContentVersion = integer(candidate.capturedContentVersion, "contract.capturedContentVersion");
  const capturedSourceGeneration = integer(candidate.capturedSourceGeneration, "contract.capturedSourceGeneration");
  const expectedOutputMessageCount = integer(candidate.expectedOutputMessageCount, "contract.expectedOutputMessageCount");
  const memberCount = steps.reduce((count, step) => count + step.members.length, 0);
  if (capturedContentVersion < 1 || capturedSourceGeneration < 0 || expectedOutputMessageCount < 1 || expectedOutputMessageCount !== memberCount) throw new StoredDataValidationError("Prepared publication counts or versions are inconsistent");
  return { version: 2, kind: "prepared_delivery", capturedContentVersion, capturedSourceGeneration, sourceIds, steps, expectedOutputMessageCount };
};

export const validatePreparedRenewalContractV2 = (value: unknown): PreparedRenewalContractV2 => {
  const candidate = record(value);
  if (candidate.version !== 2 || candidate.kind !== "prepared_renewal") throw new StoredDataValidationError("Prepared renewal contract version or kind is invalid");
  if (!logicalStatuses.has(candidate.capturedLogicalStatus as PublicationContract["capturedLogicalStatus"])) throw new StoredDataValidationError("Prepared renewal logical status is invalid");
  if (!Array.isArray(candidate.sourceIds) || !Array.isArray(candidate.steps) || candidate.steps.length === 0) throw new StoredDataValidationError("Prepared renewal contract requires source IDs and steps");
  const sourceIds = candidate.sourceIds.map((id, index) => {
    const parsed = integer(id, `renewal.sourceIds[${index}]`);
    if (parsed <= 0) throw new StoredDataValidationError("Prepared renewal source IDs must be positive");
    return asMessageId(parsed);
  });
  const steps = candidate.steps.map((step, index) => validateTransferStep(step, `renewal.steps[${index}]`));
  const memberIds = steps.flatMap((step) => step.members.map((member) => member.messageId));
  const memberKeys = steps.flatMap((step) => step.members.map((member) => member.memberKey));
  const stepKeys = steps.map((step) => step.stepKey);
  const capturedContentVersion = integer(candidate.capturedContentVersion, "renewal.capturedContentVersion");
  const capturedSourceGeneration = integer(candidate.capturedSourceGeneration, "renewal.capturedSourceGeneration");
  const expectedReplacementMessageCount = integer(candidate.expectedReplacementMessageCount, "renewal.expectedReplacementMessageCount");
  if (capturedContentVersion < 1 || capturedSourceGeneration < 0 || expectedReplacementMessageCount !== memberIds.length || sourceIds.length !== memberIds.length) throw new StoredDataValidationError("Prepared renewal counts or versions are inconsistent");
  if (new Set(memberKeys).size !== memberKeys.length || new Set(stepKeys).size !== stepKeys.length || sourceIds.some((id, index) => id !== memberIds[index])) throw new StoredDataValidationError("Prepared renewal member ordering or associations are inconsistent");
  return { version: 2, kind: "prepared_renewal", capturedLogicalStatus: candidate.capturedLogicalStatus as PublicationContract["capturedLogicalStatus"], capturedContentVersion, capturedSourceGeneration, sourceIds, steps, expectedReplacementMessageCount };
};

export const validateRenewalExecutionProgress = (value: unknown): RenewalExecutionProgress => {
  const candidate = record(value);
  if (candidate.version !== 1 || !Array.isArray(candidate.members)) throw new StoredDataValidationError("Renewal progress version or members are invalid");
  const effectiveContentVersion = integer(candidate.effectiveContentVersion, "renewal.progress.effectiveContentVersion");
  if (effectiveContentVersion < 1) throw new StoredDataValidationError("Renewal progress content version must be positive");
  const keys = new Set<string>();
  const members = candidate.members.map((value, index) => {
    const member = record(value);
    const memberKey = optionalString(member.memberKey, `renewal.progress.members[${index}].memberKey`);
    if (!memberKey || keys.has(memberKey) || !["pending", "sent", "confirmed_missing"].includes(String(member.outcome)) || !Array.isArray(member.outputIds)) throw new StoredDataValidationError(`Renewal progress member ${index} is invalid`);
    keys.add(memberKey);
    const outputIds = member.outputIds.map((id, outputIndex) => {
      const parsed = integer(id, `renewal.progress.members[${index}].outputIds[${outputIndex}]`);
      if (parsed <= 0) throw new StoredDataValidationError("Renewal progress output IDs must be positive");
      return asMessageId(parsed);
    });
    const outcome = member.outcome as RenewalExecutionProgress["members"][number]["outcome"];
    if ((outcome === "sent") !== (outputIds.length === 1) || (outcome === "confirmed_missing" && member.missingEvidence === undefined) || (outcome !== "confirmed_missing" && member.missingEvidence !== undefined)) throw new StoredDataValidationError(`Renewal progress outcome for ${memberKey} is inconsistent`);
    const result: RenewalExecutionProgress["members"][number] = { memberKey, outcome, outputIds };
    if (member.missingEvidence !== undefined) {
      const evidence = record(member.missingEvidence);
      const method = optionalString(evidence.method, "renewal.progress.missingEvidence.method");
      const description = optionalString(evidence.description, "renewal.progress.missingEvidence.description");
      const code = evidence.code === undefined ? undefined : integer(evidence.code, "renewal.progress.missingEvidence.code");
      if (!method || description === undefined) throw new StoredDataValidationError("Renewal missing-source evidence is incomplete");
      result.missingEvidence = { method, description, ...(code === undefined ? {} : { code }) };
    }
    return result;
  });
  return { version: 1, effectiveContentVersion, members };
};

export const validateExecutionProgress = (value: unknown): ExecutionProgress => {
  const candidate = record(value);
  if (candidate.version !== 1 || !Array.isArray(candidate.members)) throw new StoredDataValidationError("Execution progress version or members are invalid");
  const effectiveContentVersion = integer(candidate.effectiveContentVersion, "progress.effectiveContentVersion");
  if (effectiveContentVersion < 1) throw new StoredDataValidationError("progress.effectiveContentVersion must be positive");
  const members = candidate.members.map((entry, index) => {
    const member = record(entry);
    const memberKey = optionalString(member.memberKey, `progress.members[${index}].memberKey`);
    if (!memberKey || !["pending", "sent", "confirmed_missing"].includes(String(member.outcome)) || !Array.isArray(member.outputIds)) throw new StoredDataValidationError(`progress.members[${index}] is invalid`);
    const outputIds = member.outputIds.map((id, outputIndex) => {
      const parsed = integer(id, `progress.members[${index}].outputIds[${outputIndex}]`);
      if (parsed <= 0) throw new StoredDataValidationError("Progress output IDs must be positive");
      return asMessageId(parsed);
    });
    const result: ExecutionProgress["members"][number] = { memberKey, outcome: member.outcome as ExecutionProgress["members"][number]["outcome"], outputIds };
    if (member.missingEvidence !== undefined) {
      const evidence = record(member.missingEvidence);
      const method = optionalString(evidence.method, "progress.missingEvidence.method");
      const description = optionalString(evidence.description, "progress.missingEvidence.description");
      const code = evidence.code === undefined ? undefined : integer(evidence.code, "progress.missingEvidence.code");
      if (!method || description === undefined) throw new StoredDataValidationError("Progress missing evidence is incomplete");
      result.missingEvidence = { method, description, ...(code === undefined ? {} : { code }) };
    }
    return result;
  });
  return { version: 1, effectiveContentVersion, members };
};

import type { ContentType, MessageEntity, PublicationContract, SemanticOrigin, StoredMessageSnapshot } from "../types";
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
  if (candidate.schemaVersion !== 1) throw new StoredDataValidationError("Unsupported snapshot schema version");
  const contentType = candidate.contentType;
  if (typeof contentType !== "string" || !contentTypes.has(contentType as ContentType)) throw new StoredDataValidationError("Invalid snapshot content type");
  const result: StoredMessageSnapshot = {
    schemaVersion: 1,
    chatId: asChatId(integer(candidate.chatId, "chatId")),
    messageId: asMessageId(integer(candidate.messageId, "messageId")),
    ordinal: integer(candidate.ordinal, "ordinal"),
    contentType: contentType as ContentType,
    origin: validateSemanticOrigin(candidate.origin),
    telegramDate: integer(candidate.telegramDate, "telegramDate"),
    hasReplyMarkup: candidate.hasReplyMarkup === true,
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
  if (candidate.requiresInlineEdit !== undefined && typeof candidate.requiresInlineEdit !== "boolean") throw new StoredDataValidationError("contract.requiresInlineEdit must be boolean");
  if (candidate.requiresSeparateByline !== undefined && typeof candidate.requiresSeparateByline !== "boolean") throw new StoredDataValidationError("contract.requiresSeparateByline must be boolean");
  const result: PublicationContract = {
    capturedLogicalStatus: capturedLogicalStatus as PublicationContract["capturedLogicalStatus"],
    capturedContentVersion: integer(candidate.capturedContentVersion, "contract.capturedContentVersion"),
    capturedSourceGeneration: integer(candidate.capturedSourceGeneration, "contract.capturedSourceGeneration"),
    sourceIds,
    policy: policy as unknown as PublicationContract["policy"],
    expectedTransferredMessageCount: integer(candidate.expectedTransferredMessageCount, "contract.expectedTransferredMessageCount"),
    expectedOutputMessageCount: integer(candidate.expectedOutputMessageCount, "contract.expectedOutputMessageCount"),
    requiresInlineEdit: candidate.requiresInlineEdit === true,
    requiresSeparateByline: candidate.requiresSeparateByline === true,
  };
  const bylineText = optionalString(candidate.bylineText, "contract.bylineText");
  if (bylineText !== undefined) result.bylineText = bylineText;
  if (result.capturedContentVersion < 1 || result.capturedSourceGeneration < 0 || result.expectedTransferredMessageCount !== sourceIds.length || result.expectedOutputMessageCount < sourceIds.length) throw new StoredDataValidationError("contract output counts are inconsistent");
  return result;
};

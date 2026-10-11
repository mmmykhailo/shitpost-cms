import type { ContentType, MessageEntity, SemanticOrigin, StoredMessageSnapshot } from "../types";
import { asChatId, asMessageId, asUserId } from "../types";

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

const validateOrigin = (value: unknown): SemanticOrigin => {
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
    origin: validateOrigin(candidate.origin),
    telegramDate: integer(candidate.telegramDate, "telegramDate"),
    hasReplyMarkup: candidate.hasReplyMarkup === true,
  };
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

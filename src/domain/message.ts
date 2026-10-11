import type { Message } from "grammy/types";
import { asChatId, asMessageId, asUserId, type ContentType, type MessageEntity, type SemanticOrigin, type StoredMessageSnapshot } from "../types";

const entity = (value: { type: string; offset: number; length: number; url?: string; user?: { id: number; first_name: string; last_name?: string }; language?: string; custom_emoji_id?: string }): MessageEntity => {
  const result: MessageEntity = { type: value.type, offset: value.offset, length: value.length };
  if (value.url !== undefined) result.url = value.url;
  if (value.language !== undefined) result.language = value.language;
  if (value.custom_emoji_id !== undefined) result.customEmojiId = value.custom_emoji_id;
  if (value.user !== undefined) {
    result.user = { id: asUserId(value.user.id), firstName: value.user.first_name };
    if (value.user.last_name !== undefined) result.user.lastName = value.user.last_name;
  }
  return result;
};

const entities = (values: readonly { type: string; offset: number; length: number; url?: string; user?: { id: number; first_name: string; last_name?: string }; language?: string; custom_emoji_id?: string }[] | undefined): MessageEntity[] | undefined =>
  values?.map(entity);

const displayName = (user: { first_name: string; last_name?: string }): string => [user.first_name, user.last_name].filter(Boolean).join(" ");

export const originFromMessage = (message: Message): SemanticOrigin => {
  const origin = message.forward_origin;
  if (!origin) return { kind: "absent" };
  switch (origin.type) {
    case "channel": {
      const result: SemanticOrigin = {
        kind: "channel",
        chatId: asChatId(origin.chat.id),
        title: origin.chat.title,
      };
      if (origin.chat.username !== undefined) result.username = origin.chat.username;
      if (origin.author_signature !== undefined) result.authorSignature = origin.author_signature;
      return result;
    }
    case "user": {
      const result: SemanticOrigin = {
        kind: "user",
        userId: asUserId(origin.sender_user.id),
        displayName: displayName(origin.sender_user),
      };
      if (origin.sender_user.username !== undefined) result.username = origin.sender_user.username;
      return result;
    }
    case "hidden_user": return { kind: "hidden_user", senderUserName: origin.sender_user_name };
    case "chat": {
      const result: SemanticOrigin = { kind: "chat", chatId: asChatId(origin.sender_chat.id) };
      if (origin.sender_chat.title !== undefined) result.title = origin.sender_chat.title;
      if (origin.sender_chat.username !== undefined) result.username = origin.sender_chat.username;
      return result;
    }
    default: {
      const exhaustive: never = origin;
      return { kind: "unknown", type: String(exhaustive) };
    }
  }
};

export const contentTypeFromMessage = (message: Message): ContentType => {
  if ("text" in message) return "text";
  if ("photo" in message) return "photo";
  if ("video" in message) return "video";
  if ("animation" in message) return "animation";
  if ("audio" in message) return "audio";
  if ("document" in message) return "document";
  if ("voice" in message) return "voice";
  if ("sticker" in message) return "sticker";
  if ("video_note" in message) return "video_note";
  if ("contact" in message) return "contact";
  if ("location" in message) return "location";
  if ("venue" in message) return "venue";
  if ("dice" in message) return "dice";
  if ("poll" in message) return "poll";
  if ("game" in message) return "game";
  if ("paid_media" in message) return "paid_media";
  if ("giveaway" in message || "giveaway_winners" in message) return "giveaway";
  if (message.new_chat_members || message.left_chat_member || message.new_chat_title || message.pinned_message) return "service";
  return "unknown";
};

export const snapshotFromMessage = (message: Message, ordinal = 0): StoredMessageSnapshot => {
  const contentType = contentTypeFromMessage(message);
  const result: StoredMessageSnapshot = {
    schemaVersion: 1,
    chatId: asChatId(message.chat.id),
    messageId: asMessageId(message.message_id),
    ordinal,
    contentType,
    origin: originFromMessage(message),
    telegramDate: message.date * 1000,
    hasReplyMarkup: message.reply_markup !== undefined,
  };
  if (message.media_group_id !== undefined) result.mediaGroupId = message.media_group_id;
  if ("text" in message) {
    result.text = message.text;
    const textEntities = entities(message.entities);
    if (textEntities !== undefined) result.entities = textEntities;
  }
  if ("caption" in message && message.caption !== undefined) {
    result.caption = message.caption;
    const captionEntities = entities(message.caption_entities);
    if (captionEntities !== undefined) result.captionEntities = captionEntities;
  }
  if ("show_caption_above_media" in message && message.show_caption_above_media !== undefined) result.showCaptionAboveMedia = message.show_caption_above_media;
  if (message.edit_date !== undefined) result.editDate = message.edit_date * 1000;
  return result;
};

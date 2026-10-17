import type { Api } from "grammy";
import type { Chat, ForceReply, InlineKeyboardMarkup, Message, MessageEntity as GrammyMessageEntity, ReplyKeyboardMarkup, ReplyKeyboardRemove } from "@grammyjs/types";
import { classifyTelegramError } from "./errors";
import { asMessageId, type ChatId, type MessageId, type MessageEntity, type UserId } from "./types";

export type ChatRef = ChatId | string;

export type BotIdentity = {
  id: UserId;
  username?: string;
};

export type ResolvedChat = {
  id: ChatId;
  type: Chat["type"];
  title?: string;
  username?: string;
};

export type BotMembership = {
  status: string;
  canPostMessages: boolean;
  canDeleteMessages: boolean;
  canEditMessages: boolean;
};

export type TransferMessagesInput = {
  targetChatId: ChatId;
  sourceChatId: ChatId;
  messageIds: readonly MessageId[];
  disableNotification?: boolean;
};

export type EditTextInput = {
  chatId: ChatId;
  messageId: MessageId;
  text: string;
  entities?: readonly MessageEntity[];
  linkPreviewIsDisabled?: boolean;
};

export type EditCaptionInput = {
  chatId: ChatId;
  messageId: MessageId;
  caption: string;
  captionEntities?: readonly MessageEntity[];
  showCaptionAboveMedia?: boolean;
};

export type TelegramEditReceipt = {
  messageId: MessageId;
  editDate?: number;
};

export type SendTextInput = {
  chatId: ChatId;
  text: string;
  entities?: readonly MessageEntity[];
};

export type ReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup | ReplyKeyboardRemove | ForceReply;
export type AdminMessageInput = SendTextInput & { replyMarkup?: ReplyMarkup };

export type EditAdminMessageInput = {
  chatId: ChatId;
  messageId: MessageId;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
};

export type AnswerCallbackInput = {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
};

export type TelegramGateway = {
  getBotIdentity(): Promise<BotIdentity>;
  getChat(chatIdOrHandle: ChatRef): Promise<ResolvedChat>;
  getBotMembership(chatId: ChatId, botId: UserId): Promise<BotMembership>;
  forwardMessages(input: TransferMessagesInput): Promise<MessageId[]>;
  copyMessages(input: TransferMessagesInput): Promise<MessageId[]>;
  /** Single-member copy is used when source-specific failure association matters. */
  copyMessage?(input: { targetChatId: ChatId; sourceChatId: ChatId; messageId: MessageId; disableNotification?: boolean }): Promise<MessageId>;
  forwardMessage(input: { targetChatId: ChatId; sourceChatId: ChatId; messageId: MessageId; disableNotification?: boolean }): Promise<Message>;
  editText(input: EditTextInput): Promise<TelegramEditReceipt>;
  editCaption(input: EditCaptionInput): Promise<TelegramEditReceipt>;
  sendText(input: SendTextInput): Promise<MessageId>;
  deleteMessages(chatId: ChatId, messageIds: readonly MessageId[]): Promise<void>;
  sendAdminMessage(input: AdminMessageInput): Promise<MessageId>;
  editAdminMessage(input: EditAdminMessageInput): Promise<void>;
  answerCallbackQuery(input: AnswerCallbackInput): Promise<void>;
};

const assertOutboundMessageId = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
};

const assertTransferIds = (messageIds: readonly MessageId[]): number[] => {
  if (messageIds.length < 1 || messageIds.length > 100) throw new Error("Telegram transfer requires 1–100 message IDs");
  const numericIds = messageIds.map((messageId, index) => assertOutboundMessageId(messageId, `Telegram transfer message ID at index ${index}`));
  for (let index = 1; index < numericIds.length; index += 1) {
    if (numericIds[index]! <= numericIds[index - 1]!) throw new Error("Telegram transfer message IDs must be strictly increasing");
  }
  return numericIds;
};

const ambiguousSendResult = (method: string, reason: string, knownOutputs: readonly MessageId[] = []) => ({
  kind: "ambiguous_send_result" as const,
  method,
  description: `Telegram ${method} returned an invalid message ID (${reason})`,
  knownOutputs,
  requestMayHaveSucceeded: true,
});

const returnedMessageId = (value: unknown, method: string, label: string): MessageId => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw ambiguousSendResult(method, `${label} is not a positive safe integer`);
  return asMessageId(value);
};

const returnedEditReceipt = (value: unknown, method: string, expectedMessageId: MessageId): TelegramEditReceipt => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw ambiguousSendResult(method, "response did not contain the edited message");
  const record = value as { message_id?: unknown; edit_date?: unknown };
  const messageId = returnedMessageId(record.message_id, method, "edited message ID");
  if (messageId !== expectedMessageId) throw ambiguousSendResult(method, `response message ID ${messageId} did not match requested ID ${expectedMessageId}`);
  const receipt: TelegramEditReceipt = { messageId };
  if (record.edit_date !== undefined) {
    if (typeof record.edit_date !== "number" || !Number.isSafeInteger(record.edit_date) || record.edit_date < 0 || !Number.isSafeInteger(record.edit_date * 1_000)) throw ambiguousSendResult(method, "response edit date is invalid");
    receipt.editDate = record.edit_date * 1_000;
  }
  return receipt;
};

const normalizeBulkTransferResult = (result: unknown, method: "copyMessages" | "forwardMessages", requestedCount: number): MessageId[] => {
  if (!Array.isArray(result)) throw ambiguousSendResult(method, "response is not an array");
  const outputs: MessageId[] = [];
  const seen = new Set<number>();
  const problems: string[] = [];
  result.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) { problems.push(`response element ${index} is not an object`); return; }
    const rawId = (entry as { message_id?: unknown }).message_id;
    if (typeof rawId !== "number" || !Number.isSafeInteger(rawId) || rawId <= 0) { problems.push(`response element ${index} has an invalid message ID`); return; }
    if (seen.has(rawId)) { problems.push(`response contains duplicate message ID ${rawId}`); return; }
    seen.add(rawId);
    outputs.push(asMessageId(rawId));
  });
  if (result.length !== requestedCount) problems.push(`expected ${requestedCount} outputs, received ${result.length}`);
  if (problems.length > 0) throw ambiguousSendResult(method, problems.join("; "), outputs);
  return outputs;
};

const toTelegramEntities = (entities: readonly MessageEntity[] | undefined): GrammyMessageEntity[] | undefined => entities?.map((entity) => {
  const result: Record<string, unknown> = { type: entity.type, offset: entity.offset, length: entity.length };
  if (entity.url !== undefined) result.url = entity.url;
  if (entity.language !== undefined) result.language = entity.language;
  if (entity.customEmojiId !== undefined) result.custom_emoji_id = entity.customEmojiId;
  if (entity.user !== undefined) {
    result.user = { id: entity.user.id, first_name: entity.user.firstName, ...(entity.user.lastName === undefined ? {} : { last_name: entity.user.lastName }) };
  }
  return result as unknown as GrammyMessageEntity;
});

const optionalChatFields = (chat: Chat): ResolvedChat => {
  const result: ResolvedChat = { id: chat.id as ChatId, type: chat.type };
  if ("title" in chat && chat.title !== undefined) result.title = chat.title;
  if ("username" in chat && chat.username !== undefined) result.username = chat.username;
  return result;
};

const optionalBotFields = (user: { id: number; username?: string }): BotIdentity => {
  const result: BotIdentity = { id: user.id as UserId };
  if (user.username !== undefined) result.username = user.username;
  return result;
};

const call = async <T>(method: string, operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw classifyTelegramError(error, method);
  }
};

export const createTelegramGateway = (api: Api, adminChatId: ChatId): TelegramGateway => {
  const transfer = async (kind: "forward" | "copy", input: TransferMessagesInput): Promise<MessageId[]> => {
    const ids = assertTransferIds(input.messageIds);
    const options = input.disableNotification === undefined ? {} : { disable_notification: input.disableNotification };
    const method = kind === "forward" ? "forwardMessages" : "copyMessages";
    return call(method, async () => {
      const result = kind === "forward"
        ? await api.forwardMessages(input.targetChatId, input.sourceChatId, ids, options)
        : await api.copyMessages(input.targetChatId, input.sourceChatId, ids, options);
      return normalizeBulkTransferResult(result, method, ids.length);
    });
  };

  const sendText = async (input: SendTextInput): Promise<MessageId> => {
    const entities = toTelegramEntities(input.entities);
    const options = entities === undefined ? {} : { entities };
    return call("sendMessage", async () => {
      const message = await api.sendMessage(input.chatId, input.text, options);
      return returnedMessageId(message.message_id, "sendMessage", "response");
    });
  };

  const editText = async (input: EditTextInput): Promise<TelegramEditReceipt> => {
    const entities = toTelegramEntities(input.entities);
    const options: { entities?: GrammyMessageEntity[]; link_preview_options?: { is_disabled: boolean } } = {};
    if (entities !== undefined) options.entities = entities;
    if (input.linkPreviewIsDisabled !== undefined) options.link_preview_options = { is_disabled: input.linkPreviewIsDisabled };
    const result = await call("editMessageText", () => api.editMessageText(input.chatId, input.messageId, input.text, options));
    return returnedEditReceipt(result, "editMessageText", input.messageId);
  };

  const editCaption = async (input: EditCaptionInput): Promise<TelegramEditReceipt> => {
    const captionEntities = toTelegramEntities(input.captionEntities);
    const options: { caption: string; caption_entities?: GrammyMessageEntity[]; show_caption_above_media?: boolean } = { caption: input.caption };
    if (captionEntities !== undefined) options.caption_entities = captionEntities;
    if (input.showCaptionAboveMedia !== undefined) options.show_caption_above_media = input.showCaptionAboveMedia;
    const result = await call("editMessageCaption", () => api.editMessageCaption(input.chatId, input.messageId, options));
    return returnedEditReceipt(result, "editMessageCaption", input.messageId);
  };

  const sendAdminMessage = async (input: AdminMessageInput): Promise<MessageId> => {
    const entities = toTelegramEntities(input.entities);
    const options: { entities?: GrammyMessageEntity[]; reply_markup?: ReplyMarkup } = {};
    if (entities !== undefined) options.entities = entities;
    if (input.replyMarkup !== undefined) options.reply_markup = input.replyMarkup;
    return call("sendMessage", async () => {
      const message = await api.sendMessage(adminChatId, input.text, options);
      return returnedMessageId(message.message_id, "sendMessage", "response");
    });
  };

  const editAdminMessage = async (input: EditAdminMessageInput): Promise<void> => {
    const options: { reply_markup?: InlineKeyboardMarkup } = {};
    if (input.replyMarkup !== undefined) options.reply_markup = input.replyMarkup;
    await call("editMessageText", () => api.editMessageText(input.chatId, input.messageId, input.text, options));
  };

  return {
    getBotIdentity: async () => optionalBotFields(await call("getMe", () => api.getMe())),
    getChat: async (chatIdOrHandle) => optionalChatFields(await call("getChat", () => api.getChat(chatIdOrHandle))),
    getBotMembership: async (chatId, botId) => {
      const member = await call("getChatMember", () => api.getChatMember(chatId, botId));
      return {
        status: member.status,
        canPostMessages: member.status === "administrator" && (member.can_post_messages ?? true),
        canDeleteMessages: member.status === "administrator" && (member.can_delete_messages ?? false),
        canEditMessages: member.status === "administrator" && (member.can_edit_messages ?? false),
      };
    },
    forwardMessages: (input) => transfer("forward", input),
    copyMessages: (input) => transfer("copy", input),
    copyMessage: async (input) => {
      const options = input.disableNotification === undefined ? {} : { disable_notification: input.disableNotification };
      return call("copyMessage", async () => {
        const message = await api.copyMessage(input.targetChatId, input.sourceChatId, assertOutboundMessageId(input.messageId, "Telegram copy source ID"), options);
        return returnedMessageId(message.message_id, "copyMessage", "response");
      });
    },
    forwardMessage: async (input) => {
      const options = input.disableNotification === undefined ? {} : { disable_notification: input.disableNotification };
      return call("forwardMessage", async () => {
        const message = await api.forwardMessage(input.targetChatId, input.sourceChatId, input.messageId, options);
        returnedMessageId(message.message_id, "forwardMessage", "response");
        return message;
      });
    },
    editText,
    editCaption,
    sendText,
    deleteMessages: async (chatId, messageIds) => {
      if (messageIds.length === 0) return;
      const numericIds = messageIds.map((messageId, index) => assertOutboundMessageId(messageId, `Telegram deletion message ID at index ${index}`));
      for (let index = 0; index < numericIds.length; index += 100) {
        const chunk = numericIds.slice(index, index + 100);
        await call("deleteMessages", () => api.deleteMessages(chatId, chunk));
      }
    },
    sendAdminMessage,
    editAdminMessage,
    answerCallbackQuery: async (input) => {
      const options: { text?: string; show_alert?: boolean } = {};
      if (input.text !== undefined) options.text = input.text;
      if (input.showAlert !== undefined) options.show_alert = input.showAlert;
      await call("answerCallbackQuery", () => api.answerCallbackQuery(input.callbackQueryId, options));
    },
  };
};

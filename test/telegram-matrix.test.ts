import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { createTelegramGateway } from "../src/telegram";
import { asChatId, asMessageId, asUserId } from "../src/types";

const source = { targetChatId: asChatId(-200), sourceChatId: asChatId(-100), messageIds: [asMessageId(10), asMessageId(11)] };
const responseMessage = { message_id: 701, date: 1, chat: { id: -200, type: "channel" as const }, text: "hello" };

const rejected = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the gateway call to reject");
};

const createApi = (overrides: Record<string, unknown> = {}): { api: Api; calls: Array<{ method: string; args: unknown[] }> } => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const defaults: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    getMe: async () => ({ id: 9001, is_bot: true, first_name: "Bot" }),
    getChat: async () => ({ id: -100, type: "channel", title: "Queue", username: "queue" }),
    getChatMember: async () => ({ status: "administrator", can_post_messages: true, can_delete_messages: true, can_edit_messages: true }),
    forwardMessages: async () => [{ message_id: 801 }, { message_id: 802 }],
    copyMessages: async () => [{ message_id: 701 }, { message_id: 702 }],
    copyMessage: async () => responseMessage,
    forwardMessage: async () => responseMessage,
    sendMessage: async () => responseMessage,
    editMessageText: async () => ({ message_id: 1, edit_date: 2 }),
    editMessageCaption: async () => ({ message_id: 1, edit_date: 2 }),
    deleteMessages: async () => true,
    answerCallbackQuery: async () => true,
  };
  const implementation = { ...defaults, ...overrides };
  const api = new Proxy({}, {
    get: (_target, property: string) => (...args: unknown[]) => {
      calls.push({ method: property, args });
      const handler = implementation[property] as ((...handlerArgs: unknown[]) => Promise<unknown>) | undefined;
      return handler?.(...args) ?? Promise.resolve(true);
    },
  }) as unknown as Api;
  return { api, calls };
};

describe("Telegram gateway adapter", () => {
  test("forwards identity, chat, membership, and transfer calls exactly", async () => {
    const { api, calls } = createApi();
    const gateway = createTelegramGateway(api, asChatId(42));
    expect(await gateway.getBotIdentity()).toEqual({ id: asUserId(9001) });
    expect(await gateway.getChat("@queue")).toEqual({ id: asChatId(-100), type: "channel", title: "Queue", username: "queue" });
    expect(await gateway.getBotMembership(asChatId(-100), asUserId(9001))).toEqual({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true });
    expect(await gateway.forwardMessages({ ...source, disableNotification: true })).toEqual([asMessageId(801), asMessageId(802)]);
    expect(await gateway.copyMessages({ ...source, disableNotification: false })).toEqual([asMessageId(701), asMessageId(702)]);
    expect(await gateway.copyMessage!({ targetChatId: asChatId(-200), sourceChatId: asChatId(-100), messageId: asMessageId(10) })).toBe(asMessageId(701));
    expect(calls.find((call) => call.method === "forwardMessages")?.args).toEqual([-200, -100, [10, 11], { disable_notification: true }]);
    expect(calls.find((call) => call.method === "copyMessages")?.args).toEqual([-200, -100, [10, 11], { disable_notification: false }]);
    expect(calls.find((call) => call.method === "copyMessage")?.args).toEqual([-200, -100, 10, {}]);
  });

  test("normalizes optional fields and membership defaults", async () => {
    const { api } = createApi({
      getMe: async () => ({ id: 9001, is_bot: true, first_name: "Bot", username: "bot" }),
      getChat: async () => ({ id: -100, type: "private" }),
      getChatMember: async () => ({ status: "member", can_post_messages: true, can_delete_messages: true, can_edit_messages: true }),
    });
    const gateway = createTelegramGateway(api, asChatId(42));
    expect(await gateway.getBotIdentity()).toEqual({ id: asUserId(9001), username: "bot" });
    expect(await gateway.getChat(asChatId(-100))).toEqual({ id: asChatId(-100), type: "private" });
    expect(await gateway.getBotMembership(asChatId(-100), asUserId(9001))).toEqual({ status: "member", canPostMessages: false, canDeleteMessages: false, canEditMessages: false });
  });

  test("maps entities and all optional request fields", async () => {
    const { api, calls } = createApi();
    const gateway = createTelegramGateway(api, asChatId(42));
    const entities = [{ type: "text_link", offset: 0, length: 5, url: "https://example.test", language: "en", customEmojiId: "emoji", user: { id: asUserId(7), firstName: "Ada", lastName: "L" } }];
    await gateway.sendText({ chatId: asChatId(-100), text: "hello", entities });
    expect(await gateway.editText({ chatId: asChatId(-100), messageId: asMessageId(1), text: "edited", entities, linkPreviewIsDisabled: true })).toEqual({ messageId: asMessageId(1), editDate: 2_000 });
    expect(await gateway.editCaption({ chatId: asChatId(-100), messageId: asMessageId(1), caption: "caption", captionEntities: entities, showCaptionAboveMedia: true })).toEqual({ messageId: asMessageId(1), editDate: 2_000 });
    await gateway.sendAdminMessage({ chatId: asChatId(42), text: "admin", entities, replyMarkup: { inline_keyboard: [] } });
    await gateway.editAdminMessage({ chatId: asChatId(42), messageId: asMessageId(2), text: "menu", replyMarkup: { inline_keyboard: [] } });
    await gateway.answerCallbackQuery({ callbackQueryId: "callback", text: "done", showAlert: true });
    expect(calls.find((call) => call.method === "sendMessage")?.args).toEqual([-100, "hello", { entities: [{ type: "text_link", offset: 0, length: 5, url: "https://example.test", language: "en", custom_emoji_id: "emoji", user: { id: 7, first_name: "Ada", last_name: "L" } }] }]);
    expect(calls.find((call) => call.method === "editMessageText")?.args).toEqual([-100, 1, "edited", { entities: [{ type: "text_link", offset: 0, length: 5, url: "https://example.test", language: "en", custom_emoji_id: "emoji", user: { id: 7, first_name: "Ada", last_name: "L" } }], link_preview_options: { is_disabled: true } }]);
    expect(calls.find((call) => call.method === "editMessageCaption")?.args).toEqual([-100, 1, { caption: "caption", caption_entities: [{ type: "text_link", offset: 0, length: 5, url: "https://example.test", language: "en", custom_emoji_id: "emoji", user: { id: 7, first_name: "Ada", last_name: "L" } }], show_caption_above_media: true }]);
    expect(calls.find((call) => call.method === "answerCallbackQuery")?.args).toEqual(["callback", { text: "done", show_alert: true }]);
  });

  test("handles empty and chunked deletion plus forwarding singles", async () => {
    const { api, calls } = createApi();
    const gateway = createTelegramGateway(api, asChatId(42));
    await gateway.deleteMessages(asChatId(-100), []);
    await gateway.deleteMessages(asChatId(-100), Array.from({ length: 101 }, (_, index) => asMessageId(index + 1)));
    const forwarded = await gateway.forwardMessage({ targetChatId: asChatId(-200), sourceChatId: asChatId(-100), messageId: asMessageId(10), disableNotification: true });
    expect(forwarded as unknown).toEqual(responseMessage);
    expect(calls.filter((call) => call.method === "deleteMessages")).toHaveLength(2);
    expect(calls.find((call) => call.method === "forwardMessage")?.args).toEqual([-200, -100, 10, { disable_notification: true }]);
  });

  test("rejects unsafe transfer and output identifiers before unsafe state changes", async () => {
    const invalidInputs = [
      { ...source, messageIds: [] },
      { ...source, messageIds: Array.from({ length: 101 }, (_, index) => asMessageId(index + 1)) },
      { ...source, messageIds: [asMessageId(2), asMessageId(1)] },
      { ...source, messageIds: [{} as never] },
    ];
    const { api } = createApi();
    const gateway = createTelegramGateway(api, asChatId(42));
    for (const input of invalidInputs) expect(await rejected(() => gateway.copyMessages(input))).toBeInstanceOf(Error);
    const outputCases = [
      undefined,
      [],
      [{ message_id: 0 }],
      [{ message_id: 1.5 }],
      [{ message_id: "1" }],
      [{ message_id: 1 }, { unexpected: true }],
    ];
    for (const result of outputCases) {
      const { api: invalidApi } = createApi({ copyMessages: async () => result });
      const invalidGateway = createTelegramGateway(invalidApi, asChatId(42));
      const error = await rejected(() => invalidGateway.copyMessages(source));
      expect(error).toMatchObject({ kind: "ambiguous_send_result", method: "copyMessages" });
    }
    const { api: malformedApi } = createApi({ copyMessages: async () => [{ message_id: 20 }, null, { message_id: 22 }] });
    const malformedError = await rejected(() => createTelegramGateway(malformedApi, asChatId(42)).copyMessages(source));
    expect(malformedError).toMatchObject({ kind: "ambiguous_send_result", knownOutputs: [asMessageId(20), asMessageId(22)], requestMayHaveSucceeded: true });
  });

  test("requires an actual matching edited-message receipt", async () => {
    for (const response of [true, {}, { message_id: 0 }, { message_id: 2 }, { message_id: 1, edit_date: -1 }]) {
      const { api } = createApi({ editMessageText: async () => response });
      const error = await rejected(() => createTelegramGateway(api, asChatId(42)).editText({ chatId: asChatId(-100), messageId: asMessageId(1), text: "edited" }));
      expect(error).toMatchObject({ kind: "ambiguous_send_result", method: "editMessageText", requestMayHaveSucceeded: true });
    }
  });

  test("normalizes and classifies API failures for every public method", async () => {
    const { api } = createApi({
      getMe: async () => { throw { error_code: 403, description: "Forbidden" }; },
      sendMessage: async () => { throw new Error("network timeout"); },
      editMessageText: async () => { throw { error_code: 429, description: "Too many requests", parameters: { retry_after: 2 } }; },
    });
    const gateway = createTelegramGateway(api, asChatId(42));
    expect(await rejected(() => gateway.getBotIdentity())).toMatchObject({ kind: "permission_denied", method: "getMe", code: 403 });
    expect(await rejected(() => gateway.sendText({ chatId: asChatId(-100), text: "hello" }))).toMatchObject({ kind: "transient_network", method: "sendMessage" });
    expect(await rejected(() => gateway.editText({ chatId: asChatId(-100), messageId: asMessageId(1), text: "edited" }))).toMatchObject({ kind: "rate_limited", method: "editMessageText", retryAfterSeconds: 2 });
  });
});

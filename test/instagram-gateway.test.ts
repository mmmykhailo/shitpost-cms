import { describe, expect, test } from "bun:test";
import { InputFile, type Api } from "grammy";
import { parseConfig } from "../src/config";
import { createTelegramGateway } from "../src/telegram";
import { asChatId, asUserId, type MessageEntity } from "../src/types";

const chatId = asChatId(-100);
const videoMessage = {
  message_id: 701, date: 100, chat: { id: chatId, type: "channel" as const, title: "Queue" },
  video: { file_id: "telegram-video", file_unique_id: "unique-video", width: 1080, height: 1920, duration: 12 },
  caption: "Telegram caption\n\nby Alex",
};
const input = { chatId, path: "/tmp/reel-import.mp4", caption: videoMessage.caption };
const gatewayFor = (response: unknown = videoMessage) => {
  const calls: unknown[][] = [];
  const api = { sendVideo: async (...args: unknown[]) => { calls.push(args); return response; } } as unknown as Api;
  return { gateway: createTelegramGateway(api, asChatId(42)), calls };
};

describe("Instagram native video gateway", () => {
  test("uploads a local InputFile with native caption entities and returns the original video receipt", async () => {
    const { gateway, calls } = gatewayFor();
    const entities: readonly MessageEntity[] = [
      { type: "bold", offset: 0, length: 8 },
      { type: "text_link", offset: 9, length: 7, url: "https://example.com" },
      { type: "text_mention", offset: 21, length: 4, user: { id: asUserId(123), firstName: "Alex", lastName: "User" } },
      { type: "custom_emoji", offset: 0, length: 2, customEmojiId: "emoji-123" },
      { type: "pre", offset: 0, length: 8, language: "ts" },
    ];
    const receipt = await gateway.sendVideo!({ ...input, captionEntities: entities, supportsStreaming: true, disableNotification: true });
    expect(receipt).toBe(videoMessage);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(chatId);
    expect(calls[0]![1]).toBeInstanceOf(InputFile);
    expect((calls[0]![1] as InputFile).filename).toBe("reel-import.mp4");
    expect(calls[0]![2]).toEqual({
      caption: input.caption, supports_streaming: true, disable_notification: true,
      caption_entities: [
        { type: "bold", offset: 0, length: 8 },
        { type: "text_link", offset: 9, length: 7, url: "https://example.com" },
        { type: "text_mention", offset: 21, length: 4, user: { id: 123, first_name: "Alex", last_name: "User" } },
        { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "emoji-123" },
        { type: "pre", offset: 0, length: 8, language: "ts" },
      ],
    });
    expect(gateway.dispatchManaged).toBe(true);
  });

  test("omits unset options and preserves an empty caption", async () => {
    const { gateway, calls } = gatewayFor();
    await gateway.sendVideo!({ ...input, caption: "" });
    expect(calls[0]![2]).toEqual({ caption: "" });
  });

  test("preserves explicit false options and an empty entity array", async () => {
    const { gateway, calls } = gatewayFor();
    await gateway.sendVideo!({ ...input, captionEntities: [], supportsStreaming: false, disableNotification: false });
    expect(calls[0]![2]).toEqual({ caption: input.caption, caption_entities: [], supports_streaming: false, disable_notification: false });
  });

  test("passes an active upload deadline signal and propagates caller cancellation during dispatch", async () => {
    const { gateway: defaultGateway, calls } = gatewayFor();
    await defaultGateway.sendVideo!(input);
    expect(calls[0]![3]).toBeInstanceOf(AbortSignal);
    expect((calls[0]![3] as AbortSignal).aborted).toBe(false);

    const controller = new AbortController();
    let uploadSignal: AbortSignal | undefined;
    const api = { sendVideo: (_chat: unknown, _file: unknown, _options: unknown, signal: AbortSignal) => {
      uploadSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new TypeError("upload network request aborted")), { once: true });
      });
    } } as unknown as Api;
    const gateway = createTelegramGateway(api, asChatId(42));
    const pending = gateway.sendVideo!({ ...input, signal: controller.signal });
    expect(uploadSignal).toBeInstanceOf(AbortSignal);
    expect(uploadSignal!.aborted).toBe(false);
    controller.abort();
    expect(uploadSignal!.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ kind: "transient_network", method: "sendVideo" });
  });

  test.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, "701", undefined])("treats invalid output ID %s as ambiguous without inventing an ID", async (messageId) => {
    const { gateway, calls } = gatewayFor({ ...videoMessage, message_id: messageId });
    await expect(gateway.sendVideo!(input)).rejects.toMatchObject({
      kind: "ambiguous_send_result", method: "sendVideo", requestMayHaveSucceeded: true, knownOutputs: [],
    });
    expect(calls).toHaveLength(1);
  });

  test("retains known message ID when Telegram returns a message without video", async () => {
    const { video: _video, ...messageWithoutVideo } = videoMessage;
    const { gateway } = gatewayFor(messageWithoutVideo);
    await expect(gateway.sendVideo!(input)).rejects.toMatchObject({
      kind: "ambiguous_send_result", method: "sendVideo", requestMayHaveSucceeded: true, knownOutputs: [701],
    });
  });

  test("treats a video receipt for a different chat as ambiguous with its known output ID", async () => {
    const { gateway } = gatewayFor({ ...videoMessage, chat: { ...videoMessage.chat, id: -200 } });
    await expect(gateway.sendVideo!(input)).rejects.toMatchObject({
      kind: "ambiguous_send_result", method: "sendVideo", requestMayHaveSucceeded: true, knownOutputs: [701],
    });
  });

  test("preserves Telegram rate limits through the shared error normalization", async () => {
    const api = { sendVideo: async () => { throw { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 12 } }; } } as unknown as Api;
    const gateway = createTelegramGateway(api, asChatId(42));
    await expect(gateway.sendVideo!(input)).rejects.toMatchObject({ kind: "rate_limited", method: "sendVideo", retryAfterSeconds: 12 });
  });
});

describe("Instagram cookie configuration", () => {
  const base = { BOT_TOKEN: "token", ADMIN_USER_ID: "42", QUEUE_CHANNEL_ID: "-1001", TARGET_CHANNEL_ID: "-1002" };

  test("is optional and omits blank cookie paths", () => {
    expect(parseConfig(base, "/tmp/project").instagramCookieFile).toBeUndefined();
    expect(parseConfig({ ...base, INSTAGRAM_COOKIE_FILE: "  " }, "/tmp/project").instagramCookieFile).toBeUndefined();
  });

  test("accepts an absolute secret path and trims surrounding whitespace", () => {
    expect(parseConfig({ ...base, INSTAGRAM_COOKIE_FILE: "  /run/secrets/instagram.cookies  " }, "/tmp/project").instagramCookieFile).toBe("/run/secrets/instagram.cookies");
  });

  test.each(["cookies.txt", "../secrets/cookies", "/run/secrets/cookie\0file", "/run/secrets/cookie\nfile", "/run/secrets/cookie\rfile"])("rejects unsafe cookie path %j", (path) => {
    expect(() => parseConfig({ ...base, INSTAGRAM_COOKIE_FILE: path }, "/tmp/project")).toThrow(/INSTAGRAM_COOKIE_FILE/);
  });
});

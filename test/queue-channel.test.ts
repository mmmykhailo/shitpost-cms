import { describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { Message, Update } from "@grammyjs/types";
import { registerQueueChannelHandlers } from "../src/handlers/queue-channel";

const channelMessage = (messageId: number, edited = false): Message => ({
  message_id: messageId,
  date: 1,
  chat: { id: -100, type: "channel", title: "Queue" },
  ...(edited ? { edit_date: 2, text: "edited" } : { text: "post" }),
} as unknown as Message);

describe("queue channel handlers", () => {
  test("dispatches new and edited posts and records success after ingestion", async () => {
    const bot = new Bot("test-token", { botInfo: { id: 9001, is_bot: true, first_name: "Bot" } as never });
    const seen: string[] = [];
    const successful: string[] = [];
    registerQueueChannelHandlers(bot, {
      handleChannelPost: (message: Message) => { seen.push(`post:${message.message_id}`); },
      handleEditedChannelPost: (message: Message) => { seen.push(`edit:${message.message_id}`); },
    } as never, () => { successful.push("ok"); });

    await bot.handleUpdate({ update_id: 1, channel_post: channelMessage(10) } as Update);
    await bot.handleUpdate({ update_id: 2, edited_channel_post: channelMessage(10, true) } as Update);

    expect(seen).toEqual(["post:10", "edit:10"]);
    expect(successful).toEqual(["ok", "ok"]);
  });

  test("does not report a failed ingestion as a successful update", async () => {
    const bot = new Bot("test-token", { botInfo: { id: 9001, is_bot: true, first_name: "Bot" } as never });
    let successes = 0;
    registerQueueChannelHandlers(bot, {
      handleChannelPost: () => { throw new Error("database unavailable"); },
      handleEditedChannelPost: () => { throw new Error("database unavailable"); },
    } as never, () => { successes += 1; });

    await expect(bot.handleUpdate({ update_id: 3, channel_post: channelMessage(11) } as Update)).rejects.toThrow("database unavailable");
    await expect(bot.handleUpdate({ update_id: 4, edited_channel_post: channelMessage(11, true) } as Update)).rejects.toThrow("database unavailable");
    expect(successes).toBe(0);
  });
});

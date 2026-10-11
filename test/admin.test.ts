import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { InlineKeyboardMarkup, Message, Update, User } from "@grammyjs/types";
import { registerAdminHandlers } from "../src/handlers/admin";
import { createDatabase } from "../src/db/database";
import { createAdminRepository } from "../src/db/admin-repository";
import { createOrphanRepository } from "../src/db/orphan-repository";
import { createPendingUpdateRepository } from "../src/db/pending-update-repository";
import { createPolicyRepository, createQueueRepository, createScheduleRepository } from "../src/db/repositories";
import type { TelegramGateway } from "../src/telegram";
import { asChatId, asUserId } from "../src/types";
import type { LogFields } from "../src/logger";

const ADMIN_ID = asUserId(42);
const ADMIN_CHAT_ID = Number(ADMIN_ID);
const QUEUE_CHAT_ID = asChatId(-1001234567890);
const TARGET_CHAT_ID = asChatId(-1009876543210);
const NOW = 1_790_000_000_000;

const ADMIN: User = { id: ADMIN_ID, is_bot: false, first_name: "Admin" };
const BOT_INFO = {
  id: 9001,
  is_bot: true as const,
  first_name: "Schedule Bot",
  username: "schedule_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

type AdminDeps = Parameters<typeof registerAdminHandlers>[1];
type ApiCall = { method: string; payload: Record<string, unknown> };
type SentMessage = { message: Message.TextMessage; payload: Record<string, unknown> };

const privateChat = { id: ADMIN_CHAT_ID, type: "private" as const, first_name: "Admin" };

const makeMessage = (messageId: number, text: string, sender: User = ADMIN, replyTo?: Message): Message.TextMessage => ({
  message_id: messageId,
  date: 1,
  chat: privateChat,
  from: sender,
  text,
  ...(replyTo === undefined ? {} : { reply_to_message: replyTo }),
} as unknown as Message.TextMessage);

const commandUpdate = (updateId: number, messageId: number, command: string): Update => ({
  update_id: updateId,
  message: {
    ...makeMessage(messageId, `/${command}`),
    entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }],
  },
} as Update);

const replyUpdate = (updateId: number, messageId: number, text: string, replyTo: Message): Update => ({
  update_id: updateId,
  message: makeMessage(messageId, text, ADMIN, replyTo),
} as Update);

const callbackUpdate = (updateId: number, callbackId: string, data: string, message: Message, from: User = ADMIN): Update => ({
  update_id: updateId,
  callback_query: { id: callbackId, from, chat_instance: "test-chat", message, data },
} as Update);

const createHarness = () => {
  const directory = mkdtempSync(join(tmpdir(), "shitpost-cms-admin-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  const queue = createQueueRepository(database, { bootId: "admin-test" });
  const policy = createPolicyRepository(database);
  const schedule = createScheduleRepository(database);
  const admin = createAdminRepository(database);
  const pending = createPendingUpdateRepository(database);
  const orphan = createOrphanRepository(database);
  const calls: ApiCall[] = [];
  const sent: SentMessage[] = [];
  const deleted: Array<{ chatId: number; messageIds: number[] }> = [];
  const warnings: Array<{ event: string; fields: LogFields | undefined }> = [];
  let nextMessageId = 100;
  let deleteFailure: unknown;

  const gateway = {
    deleteMessages: async (chatId: number, messageIds: readonly number[]): Promise<void> => {
      deleted.push({ chatId: Number(chatId), messageIds: messageIds.map(Number) });
      if (deleteFailure !== undefined) throw deleteFailure;
    },
    getChat: async () => ({ id: asChatId(-100555), type: "channel" as const }),
  } as unknown as TelegramGateway;

  const logger = {
    debug: () => {},
    info: () => {},
    warn: (event: string, fields?: LogFields) => { warnings.push({ event, fields }); },
    error: () => {},
  };

  const bot = new Bot("test-token", { botInfo: BOT_INFO });
  bot.api.config.use(async (_previous, method, payload) => {
    const body = payload as Record<string, unknown>;
    calls.push({ method: String(method), payload: body });
    if (method === "sendMessage") {
      const message = {
        message_id: nextMessageId,
        date: 1,
        chat: privateChat,
        from: BOT_INFO,
        text: String(body.text),
        ...(body.reply_markup === undefined ? {} : { reply_markup: body.reply_markup }),
      } as unknown as Message.TextMessage;
      nextMessageId += 1;
      sent.push({ message, payload: body });
      return { ok: true, result: message } as never;
    }
    return { ok: true, result: true } as never;
  });

  const config = {
    botToken: "test-token",
    adminUserId: ADMIN_ID,
    queueChannelId: QUEUE_CHAT_ID,
    targetChannelId: TARGET_CHAT_ID,
    databasePath: join(directory, "bot.sqlite"),
    dataDirectory: directory,
    logLevel: "error" as const,
    releaseSha: "development",
  } as AdminDeps["config"];
  const deps = {
    config,
    queue,
    policy,
    schedule,
    admin,
    pending,
    orphan,
    gateway,
    publisher: {} as AdminDeps["publisher"],
    scheduler: { nextAt: () => undefined, manualPublish: async () => ({ kind: "empty" as const }) } as AdminDeps["scheduler"],
    recovery: {} as AdminDeps["recovery"],
    health: {} as AdminDeps["health"],
    logger,
    now: () => NOW,
  } as AdminDeps;
  registerAdminHandlers(bot, deps);

  return {
    bot,
    admin,
    schedule,
    calls,
    sent,
    deleted,
    warnings,
    setDeleteFailure: (error: unknown): void => { deleteFailure = error; },
    lastSent: (): SentMessage => {
      const message = sent.at(-1);
      if (!message) throw new Error("No bot message was sent");
      return message;
    },
    callbackData: (sentMessage: SentMessage, text: string): string => {
      const markup = sentMessage.payload.reply_markup as InlineKeyboardMarkup;
      const button = markup.inline_keyboard.flat().find((candidate) => candidate.text === text && "callback_data" in candidate);
      if (!button || !("callback_data" in button)) throw new Error(`No callback button named ${text}`);
      return button.callback_data;
    },
    run: (update: Update): Promise<void> => bot.handleUpdate(update),
    close: (): void => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

describe("admin schedule handlers", () => {
  test("binds Add UTC slot to its ForceReply question and renders Resume after adding", async () => {
    const harness = createHarness();
    try {
      await harness.run(commandUpdate(1, 1, "schedule"));
      const menu = harness.lastSent();
      expect(menu.message.text).toContain("Schedule is paused. Slots: none");
      const addToken = harness.callbackData(menu, "Add UTC slot");

      await harness.run(callbackUpdate(2, "callback-add", addToken, menu.message));

      expect(harness.calls.some((call) => call.method === "answerCallbackQuery" && call.payload.callback_query_id === "callback-add")).toBe(true);
      expect(harness.deleted).toEqual([{ chatId: ADMIN_CHAT_ID, messageIds: [menu.message.message_id] }]);
      const question = harness.lastSent();
      expect(question.message.text).toBe("Reply with the daily UTC slot as HH:MM.");
      expect(question.payload.reply_markup).toEqual({ force_reply: true, input_field_placeholder: "HH:MM UTC" });
      expect(harness.admin.getPrompt(ADMIN_ID, NOW)).toEqual({ kind: "slot_add", state: {}, expectedReplyToMessageId: question.message.message_id });
      expect(question.message.message_id).not.toBe(menu.message.message_id);

      await harness.run(replyUpdate(3, 3, "05:00", question.message));

      expect(harness.schedule.slots()).toEqual([300]);
      expect(harness.schedule.enabled()).toBe(false);
      expect(harness.admin.getPrompt(ADMIN_ID, NOW)).toBeUndefined();
      const replacement = harness.lastSent();
      expect(replacement.message.text).toContain("Added 05:00 UTC.");
      expect(replacement.message.text).toContain("Schedule is paused. Slots: 05:00 UTC");
      expect(harness.callbackData(replacement, "Resume")).toMatch(/^v1:/);
    } finally {
      harness.close();
    }
  });

  test("re-arms a ForceReply prompt after invalid UTC input without changing schedule state", async () => {
    const harness = createHarness();
    try {
      await harness.run(commandUpdate(10, 10, "schedule"));
      const menu = harness.lastSent();
      await harness.run(callbackUpdate(11, "callback-add", harness.callbackData(menu, "Add UTC slot"), menu.message));
      const firstQuestion = harness.lastSent();

      await harness.run(replyUpdate(12, 12, "5:00", firstQuestion.message));

      expect(harness.schedule.slots()).toEqual([]);
      expect(harness.schedule.enabled()).toBe(false);
      const retryQuestion = harness.lastSent();
      expect(retryQuestion.message.text).toContain("Reply with the daily UTC slot as HH:MM.");
      expect(retryQuestion.message.text).not.toBe(firstQuestion.message.text);
      expect(retryQuestion.payload.reply_markup).toEqual({ force_reply: true, input_field_placeholder: "HH:MM UTC" });
      expect(harness.admin.getPrompt(ADMIN_ID, NOW)?.expectedReplyToMessageId).toBe(retryQuestion.message.message_id);

      await harness.run(replyUpdate(13, 13, "05:00", retryQuestion.message));

      expect(harness.schedule.slots()).toEqual([300]);
      expect(harness.admin.getPrompt(ADMIN_ID, NOW)).toBeUndefined();
    } finally {
      harness.close();
    }
  });
});

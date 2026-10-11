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

  test("accepts only a reply to the active question and supports cancel", async () => {
    const harness = createHarness();
    try {
      await harness.run(commandUpdate(20, 20, "schedule"));
      const menu = harness.lastSent();
      await harness.run(callbackUpdate(21, "callback-add", harness.callbackData(menu, "Add UTC slot"), menu.message));
      const question = harness.lastSent();

      await harness.run(replyUpdate(22, 22, "05:00", menu.message));
      await harness.run(replyUpdate(23, 23, "05:00", makeMessage(23, "05:00")));

      expect(harness.schedule.slots()).toEqual([]);
      expect(harness.admin.getPrompt(ADMIN_ID, NOW)?.expectedReplyToMessageId).toBe(question.message.message_id);
      expect(harness.lastSent().message.text).toBe("Reply to the active admin prompt to continue, or use /cancel.");

      await harness.run(commandUpdate(24, 24, "cancel"));
      expect(harness.admin.getPrompt(ADMIN_ID, NOW)).toBeUndefined();
      await harness.run(replyUpdate(25, 25, "05:00", question.message));
      expect(harness.schedule.slots()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test("a second prompt replaces the first question binding", async () => {
    const harness = createHarness();
    try {
      await harness.run(commandUpdate(30, 30, "schedule"));
      const firstMenu = harness.lastSent();
      await harness.run(callbackUpdate(31, "callback-add-1", harness.callbackData(firstMenu, "Add UTC slot"), firstMenu.message));
      const firstQuestion = harness.lastSent();

      await harness.run(commandUpdate(32, 32, "schedule"));
      const secondMenu = harness.lastSent();
      await harness.run(callbackUpdate(33, "callback-add-2", harness.callbackData(secondMenu, "Add UTC slot"), secondMenu.message));
      const secondQuestion = harness.lastSent();

      expect(secondQuestion.message.message_id).not.toBe(firstQuestion.message.message_id);
      expect(harness.admin.getPrompt(ADMIN_ID, NOW)?.expectedReplyToMessageId).toBe(secondQuestion.message.message_id);
      await harness.run(replyUpdate(34, 34, "05:00", firstQuestion.message));
      expect(harness.schedule.slots()).toEqual([]);
      await harness.run(replyUpdate(35, 35, "05:00", secondQuestion.message));
      expect(harness.schedule.slots()).toEqual([300]);
    } finally {
      harness.close();
    }
  });

  test("keeps a valid action running when callback-menu deletion fails", async () => {
    const harness = createHarness();
    try {
      await harness.run(commandUpdate(40, 40, "schedule"));
      const menu = harness.lastSent();
      harness.setDeleteFailure({ kind: "permission_denied", description: "rights lost" });

      await harness.run(callbackUpdate(41, "callback-resume", harness.callbackData(menu, "Resume"), menu.message));

      expect(harness.schedule.enabled()).toBe(false);
      expect(harness.lastSent().message.text).toContain("Add at least one UTC slot before resuming.");
      expect(harness.deleted).toEqual([{ chatId: ADMIN_CHAT_ID, messageIds: [menu.message.message_id] }]);
      expect(harness.warnings).toEqual([{
        event: "admin_menu_delete_failed",
        fields: {
          chatId: ADMIN_CHAT_ID,
          messageId: menu.message.message_id,
          action: "schedule_resume",
          errorKind: "permission_denied",
        },
      }]);
    } finally {
      harness.close();
    }
  });

  test("does not delete menus for unauthorized or malformed callbacks", async () => {
    const harness = createHarness();
    try {
      await harness.run(commandUpdate(50, 50, "schedule"));
      const menu = harness.lastSent();
      const token = harness.callbackData(menu, "Add UTC slot");
      const stranger: User = { id: 77, is_bot: false, first_name: "Stranger" };

      await harness.run(callbackUpdate(51, "callback-unauthorized", token, menu.message, stranger));

      expect(harness.deleted).toEqual([]);
      expect(harness.calls.some((call) => call.method === "answerCallbackQuery" && call.payload.callback_query_id === "callback-unauthorized" && call.payload.text === "Not authorized" && call.payload.show_alert === true)).toBe(true);
      expect(harness.admin.getPrompt(ADMIN_ID, NOW)).toBeUndefined();

      await harness.run(callbackUpdate(52, "callback-malformed", "other:payload", menu.message));

      expect(harness.deleted).toEqual([]);
      expect(harness.lastSent().message.text).toBe("Stale action.");
    } finally {
      harness.close();
    }
  });

  test("binds every callback-created prompt to its own outgoing question", async () => {
    const harness = createHarness();
    const cases = [
      { action: "slot_add", payload: {}, kind: "slot_add", state: {}, placeholder: "HH:MM UTC" },
      { action: "whitelist_add", payload: {}, kind: "whitelist_add", state: {}, placeholder: "@channel or numeric ID" },
      { action: "alias_add", payload: {}, kind: "alias_add", state: {}, placeholder: "user and alias" },
      {
        action: "uncertain_publish_adopt_prompt",
        payload: { itemId: 7, operationId: "publish-7", sourceGeneration: 2, expectedCount: 3, phase: "uncertain" },
        kind: "uncertain_publish_adopt",
        state: { itemId: 7, operationId: "publish-7", sourceGeneration: 2, expectedCount: 3, phase: "uncertain" },
        placeholder: "message IDs",
      },
      {
        action: "renewal_adopt_prompt",
        payload: { itemId: 8, operationId: "renew-8", sourceGeneration: 4, expectedCount: 2, phase: "uncertain" },
        kind: "renewal_adopt",
        state: { itemId: 8, operationId: "renew-8", sourceGeneration: 4, expectedCount: 2, phase: "uncertain" },
        placeholder: "message IDs",
      },
      {
        action: "renewal_cleanup_prompt",
        payload: { itemId: 9, operationId: "renew-9", sourceGeneration: 5, phase: "uncertain" },
        kind: "renewal_manual_cleanup",
        state: { itemId: 9, operationId: "renew-9", sourceGeneration: 5, phase: "uncertain" },
        placeholder: "message IDs",
      },
    ] as const;
    try {
      for (const [index, entry] of cases.entries()) {
        const source = makeMessage(800 + index, "admin menu", BOT_INFO);
        const token = harness.admin.createCallbackToken(ADMIN_ID, entry.action, entry.payload, NOW);
        await harness.run(callbackUpdate(100 + index, `callback-prompt-${index}`, `v1:${token}`, source));
        const question = harness.lastSent();
        expect(question.payload.reply_markup).toEqual({ force_reply: true, input_field_placeholder: entry.placeholder });
        expect(harness.admin.getPrompt(ADMIN_ID, NOW)).toEqual({ kind: entry.kind, state: entry.state, expectedReplyToMessageId: question.message.message_id });
        expect(harness.admin.getPrompt(ADMIN_ID, NOW)?.expectedReplyToMessageId).not.toBe(source.message_id);
      }

      await harness.run(commandUpdate(200, 200, "recover"));
      const recoveryQuestion = harness.lastSent();
      expect(recoveryQuestion.payload.reply_markup).toEqual({ force_reply: true, input_field_placeholder: "queue link or message ID" });
      expect(harness.admin.getPrompt(ADMIN_ID, NOW)).toEqual({ kind: "recover", state: {}, expectedReplyToMessageId: recoveryQuestion.message.message_id });
    } finally {
      harness.close();
    }
  });

  test("replaces schedule menus after pause and resume", async () => {
    const harness = createHarness();
    try {
      harness.schedule.addSlot(300, ADMIN_ID, NOW);
      harness.schedule.setEnabled(true, ADMIN_ID, NOW);
      await harness.run(commandUpdate(210, 210, "schedule"));
      const runningMenu = harness.lastSent();
      expect(runningMenu.message.text).toContain("Schedule is running. Slots: 05:00 UTC");

      await harness.run(callbackUpdate(211, "callback-pause", harness.callbackData(runningMenu, "Pause"), runningMenu.message));
      const pausedMenu = harness.lastSent();
      expect(harness.schedule.enabled()).toBe(false);
      expect(pausedMenu.message.text).toContain("Schedule is paused. Slots: 05:00 UTC");
      expect(harness.callbackData(pausedMenu, "Resume")).toMatch(/^v1:/);

      await harness.run(callbackUpdate(212, "callback-resume", harness.callbackData(pausedMenu, "Resume"), pausedMenu.message));
      const resumedMenu = harness.lastSent();
      expect(harness.schedule.enabled()).toBe(true);
      expect(resumedMenu.message.text).toContain("Schedule is running. Slots: 05:00 UTC");
      expect(harness.callbackData(resumedMenu, "Pause")).toMatch(/^v1:/);
      expect(harness.deleted).toEqual([
        { chatId: ADMIN_CHAT_ID, messageIds: [runningMenu.message.message_id] },
        { chatId: ADMIN_CHAT_ID, messageIds: [pausedMenu.message.message_id] },
      ]);
    } finally {
      harness.close();
    }
  });
});

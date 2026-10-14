import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { InlineKeyboardMarkup, Message, Update, User } from "@grammyjs/types";
import { registerAdminHandlers } from "../src/handlers/admin";
import type { PublicationOutcome } from "../src/services/publisher";
import { createDatabase } from "../src/db/database";
import { createAdminRepository } from "../src/db/admin-repository";
import { createOrphanRepository } from "../src/db/orphan-repository";
import { createPendingUpdateRepository } from "../src/db/pending-update-repository";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository, createScheduleRepository } from "../src/db/repositories";
import { createRenewalService } from "../src/services/renewal";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import type { TelegramGateway } from "../src/telegram";
import { asChatId, asMessageId, asUserId, type PublicationContract } from "../src/types";
import type { LogFields } from "../src/logger";
import { snapshotFixture } from "./fixtures";

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

const createHarness = (manualPublish: AdminDeps["scheduler"]["manualPublish"] = async (): Promise<PublicationOutcome> => ({ kind: "empty" })) => {
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
  let nextSourceMessageId = 5_000;
  const sourceTransfers: number[][] = [];
  let deleteFailure: unknown;
  let physicalAgeMs: number | undefined;
  let resolvedChat: { id: ReturnType<typeof asChatId>; type: "channel" | "group" } = { id: asChatId(-100555), type: "channel" };

  const gateway = {
    copyMessages: async ({ messageIds }: { messageIds: readonly number[] }) => {
      sourceTransfers.push(messageIds.map(Number));
      return messageIds.map(() => asMessageId(nextSourceMessageId++));
    },
    forwardMessages: async ({ messageIds }: { messageIds: readonly number[] }) => {
      sourceTransfers.push(messageIds.map(Number));
      return messageIds.map(() => asMessageId(nextSourceMessageId++));
    },
    deleteMessages: async (chatId: number, messageIds: readonly number[]): Promise<void> => {
      deleted.push({ chatId: Number(chatId), messageIds: messageIds.map(Number) });
      if (deleteFailure !== undefined) throw deleteFailure;
    },
    getChat: async () => resolvedChat,
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
    scheduler: { nextAt: () => undefined, manualPublish } as AdminDeps["scheduler"],
    recovery: { recover: async () => ({ itemId: 1, sourceIds: [asMessageId(1)] }), reconcileExpiredSessions: async () => ({ completed: 0, blocked: 0 }) } as AdminDeps["recovery"],
    health: {
      snapshot: () => ({
        databaseOk: true,
        bootId: "admin-test",
        uptimeMs: 0,
        leaseOwned: true,
        lastCleanShutdownAt: null,
        lastSuccessfulUpdateAt: null,
        lastRightsCheckAt: undefined,
        lastBackupAt: undefined,
        queueCounts: {},
        queueHead: undefined,
        oldestLogicalAgeMs: undefined,
        oldestPhysicalAgeMs: physicalAgeMs,
        nextSlotAt: undefined,
        lastSchedulerScanAt: null,
        activeOperations: 0,
        uncertainOperations: 0,
        pendingUpdates: {},
        orphanCounts: { unresolved: 0, terminal: 0 },
        renewalCapacity: { safe: true },
        lastOperation: undefined,
        rights: undefined,
        alerts: { active: 0, critical: 0, immediate: 0, normal: 0 },
      }),
    } as AdminDeps["health"],
    logger,
    now: () => NOW,
  } as AdminDeps;
  registerAdminHandlers(bot, deps);

  return {
    bot,
    database,
    queue,
    policy,
    pending,
    orphan,
    gateway,
    config,
    admin,
    schedule,
    calls,
    sent,
    deleted,
    sourceTransfers,
    warnings,
    setDeleteFailure: (error: unknown): void => { deleteFailure = error; },
    setPhysicalAge: (ageMs: number): void => { physicalAgeMs = ageMs; },
    setResolvedChat: (chat: { id: ReturnType<typeof asChatId>; type: "channel" | "group" }): void => { resolvedChat = chat; },
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

const prepareUncertainPublication = (harness: ReturnType<typeof createHarness>, messageId: number, destinationIds: number[] = []) => {
  const item = harness.queue.observeQueueSnapshot(snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(messageId) }), NOW).item;
  const claimed = harness.queue.claimPublication("admin-uncertain", "manual_publish", NOW)!;
  const contract: PublicationContract = {
    capturedLogicalStatus: "queued",
    capturedContentVersion: claimed.capturedContentVersion,
    capturedSourceGeneration: claimed.capturedSourceGeneration,
    sourceIds: [asMessageId(messageId)],
    policy: { kind: "copy", reason: "direct_queue_post" },
    expectedTransferredMessageCount: 1,
    expectedOutputMessageCount: destinationIds.length > 0 ? destinationIds.length : 1,
    requiresInlineEdit: false,
    requiresSeparateByline: false,
  };
  const guard = { operationId: claimed.operationId, itemId: item.id, capturedContentVersion: claimed.capturedContentVersion, capturedSourceGeneration: claimed.capturedSourceGeneration };
  harness.queue.persistPublicationContract(claimed.operationId, contract, NOW);
  harness.queue.beginPublicationTransfer(guard, NOW);
  for (const [ordinal, destinationId] of destinationIds.entries()) harness.queue.recordOutput(claimed.operationId, "transferred", TARGET_CHAT_ID, asMessageId(destinationId), ordinal, NOW);
  harness.queue.transition(item.id, "publishing", "uncertain_publish", NOW, "ambiguous_send_result", "response lost");
  harness.queue.setOperationState(claimed.operationId, "uncertain", NOW, "ambiguous_send_result");
  harness.queue.setOperationPhase(claimed.operationId, "uncertain", NOW, "ambiguous_send_result");
  return { item, operationId: claimed.operationId };
};

const prepareUncertainRenewal = (harness: ReturnType<typeof createHarness>, messageId: number, replacementIds: number[] = []) => {
  const item = harness.queue.observeQueueSnapshot(snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(messageId), telegramDate: 0 }), 1).item;
  const claimed = harness.queue.claimRenewal("admin-renewal", NOW, NOW)!;
  harness.queue.setRenewalUncertain(item.id, claimed.operationId, NOW, "transient_network", "response lost");
  for (const [ordinal, replacementId] of replacementIds.entries()) harness.queue.recordReplacementOutput(claimed.operationId, QUEUE_CHAT_ID, asMessageId(replacementId), ordinal, NOW);
  return { item, operationId: claimed.operationId };
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

  test("renders an explicit successful manual publication result", async () => {
    const harness = createHarness(async () => ({ kind: "published", itemId: 1, destinationMessageIds: [asMessageId(701)], operationId: "published-1" }));
    try {
      harness.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(51) }), NOW);
      const source = makeMessage(901, "publish menu", BOT_INFO);
      const token = harness.admin.createCallbackToken(ADMIN_ID, "publish_execute", { itemId: 1, sourceGeneration: 0 }, NOW, 1);

      await harness.run(callbackUpdate(902, "callback-publish", `v1:${token}`, source));

      expect(harness.lastSent().message.text).toBe("Queue item #1 was published and source cleanup completed.");
    } finally {
      harness.close();
    }
  });

  test("renders the shared uncertainty resolution menu after manual publication", async () => {
    let harness!: ReturnType<typeof createHarness>;
    harness = createHarness(async () => {
      const claimed = harness.queue.claimPublication("uncertain-1", "manual_publish", NOW)!;
      const contract: PublicationContract = {
        capturedLogicalStatus: "queued",
        capturedContentVersion: claimed.capturedContentVersion,
        capturedSourceGeneration: claimed.capturedSourceGeneration,
        sourceIds: [asMessageId(52)],
        policy: { kind: "copy", reason: "direct_queue_post" },
        expectedTransferredMessageCount: 1,
        expectedOutputMessageCount: 1,
        requiresInlineEdit: false,
        requiresSeparateByline: false,
      };
      const guard = { operationId: claimed.operationId, itemId: 1, capturedContentVersion: claimed.capturedContentVersion, capturedSourceGeneration: claimed.capturedSourceGeneration };
      harness.queue.persistPublicationContract(claimed.operationId, contract, NOW);
      harness.queue.beginPublicationTransfer(guard, NOW);
      harness.queue.transition(1, "publishing", "uncertain_publish", NOW, "ambiguous_send_result", "Telegram response was lost");
      harness.queue.setOperationState(claimed.operationId, "uncertain", NOW, "ambiguous_send_result");
      harness.queue.setOperationPhase(claimed.operationId, "uncertain", NOW, "ambiguous_send_result");
      return { kind: "uncertain", itemId: 1, operationId: claimed.operationId };
    });
    try {
      harness.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(52) }), NOW);
      const source = makeMessage(903, "publish menu", BOT_INFO);
      const token = harness.admin.createCallbackToken(ADMIN_ID, "publish_execute", { itemId: 1, sourceGeneration: 0 }, NOW, 1);

      await harness.run(callbackUpdate(904, "callback-uncertain", `v1:${token}`, source));

      const response = harness.lastSent();
      expect(response.message.text).toContain("Uncertain publication #1");
      expect(response.message.text).toContain("destination may already contain this post");
      expect(response.message.text).toContain("retrying can duplicate");
      expect(harness.callbackData(response, "Enter exact destination IDs")).toMatch(/^v1:/);
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

describe("admin command, queue, and publication handlers", () => {
  test("renders readable queue age and links the stable item number to its current source", async () => {
    const harness = createHarness();
    try {
      const queueAge = 247_668_018;
      const sourceMessageId = 1501;
      const item = harness.queue.observeQueueSnapshot(snapshotFixture({
        chatId: QUEUE_CHAT_ID,
        messageId: asMessageId(sourceMessageId),
        telegramDate: NOW - queueAge,
      }), NOW - queueAge).item;

      await harness.run(commandUpdate(299, 299, "queue"));

      const listing = harness.lastSent();
      expect(listing.message.text).toContain(`#${item.id} · text · queued · age 2.87 days`);
      expect(listing.message.text).not.toContain(`${queueAge} ms`);
      const entities = listing.payload.entities as Array<{ type: string; offset: number; length: number; url?: string }>;
      const link = entities?.find((entity) => entity.type === "text_link");
      expect(link).toBeDefined();
      expect(listing.message.text.slice(link!.offset, link!.offset + link!.length)).toBe(`#${item.id}`);
      expect(link?.url).toBe("https://t.me/c/1234567890/1501");
      expect(listing.payload.parse_mode).toBeUndefined();

      await harness.run(commandUpdate(298, 298, "manage"));
      expect(harness.lastSent().message.text).toContain("logical age 2.87 days");
      harness.setPhysicalAge(queueAge);
      await harness.run(commandUpdate(297, 297, "health"));
      expect(harness.lastSent().message.text).toContain("oldest physical source age: 2.87 days");
    } finally {
      harness.close();
    }
  });

  test("keeps the queue link on each replacement across repeated real renewals", async () => {
    const harness = createHarness();
    try {
      const logicalAge = 247_668_018;
      const item = harness.queue.observeQueueSnapshot(snapshotFixture({
        chatId: QUEUE_CHAT_ID,
        messageId: asMessageId(1502),
        telegramDate: NOW - logicalAge,
        origin: { kind: "absent" },
      }), NOW - logicalAge).item;
      const clock = createFakeClock(NOW);
      const renewal = createRenewalService({
        queue: harness.queue,
        policy: harness.policy,
        generated: createGeneratedMessageRepository(harness.database),
        gateway: harness.gateway,
        queueChannelId: QUEUE_CHAT_ID,
        clock,
        logger: createLogger("error"),
      });
      const links: string[] = [];

      for (let renewalNumber = 0; renewalNumber < 3; renewalNumber += 1) {
        await harness.run(commandUpdate(360 + renewalNumber, 360 + renewalNumber, "queue"));
        const listing = harness.lastSent();
        expect(listing.message.text).toContain(`#${item.id} · text · queued · age 2.87 days`);
        const link = (listing.payload.entities as Array<{ type: string; offset: number; length: number; url: string }>).find((entity) => entity.type === "text_link");
        expect(link).toBeDefined();
        expect(listing.message.text.slice(link!.offset, link!.offset + link!.length)).toBe(`#${item.id}`);
        links.push(link!.url);

        expect((await renewal.renewNext(36 * 60 * 60_000)).kind).toBe("renewed");
        if (renewalNumber < 2) clock.advance(36 * 60 * 60_000);
      }
      await harness.run(commandUpdate(363, 363, "queue"));
      const finalListing = harness.lastSent();
      expect(finalListing.message.text).toContain(`#${item.id} · text · queued · age 2.87 days`);
      const finalLink = (finalListing.payload.entities as Array<{ type: string; offset: number; length: number; url: string }>).find((entity) => entity.type === "text_link");
      expect(finalLink).toBeDefined();
      expect(finalListing.message.text.slice(finalLink!.offset, finalLink!.offset + finalLink!.length)).toBe(`#${item.id}`);
      links.push(finalLink!.url);

      expect(links).toEqual([
        "https://t.me/c/1234567890/1502",
        "https://t.me/c/1234567890/5000",
        "https://t.me/c/1234567890/5001",
        "https://t.me/c/1234567890/5002",
      ]);
      expect(harness.queue.currentSourceIds(item.id)).toEqual([asMessageId(5002)]);
      expect(harness.sourceTransfers).toEqual([[1502], [5000], [5001]]);
    } finally {
      harness.close();
    }
  });

  test("links an album label to its first current member and falls back to plain text for invalid chats", async () => {
    const harness = createHarness();
    try {
      const album = harness.queue.observeQueueSnapshot(snapshotFixture({
        chatId: QUEUE_CHAT_ID,
        messageId: asMessageId(1510),
        mediaGroupId: "linked-album",
      }), NOW).item;
      harness.queue.addAlbumMember(album.id, snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(1512), mediaGroupId: "linked-album" }), NOW + 100);
      harness.queue.finalizeAlbums(NOW + 10_000);

      await harness.run(commandUpdate(364, 364, "queue"));
      const listing = harness.lastSent();
      const link = (listing.payload.entities as Array<{ type: string; offset: number; length: number; url: string }>).find((entity) => entity.type === "text_link");
      expect(link?.url).toBe("https://t.me/c/1234567890/1510");
      expect(harness.queue.currentSourceIds(album.id)).toEqual([asMessageId(1510), asMessageId(1512)]);

      harness.config.queueChannelId = asChatId(-123_456_789);
      await harness.run(commandUpdate(365, 365, "queue"));
      const invalidChatListing = harness.lastSent();
      expect(invalidChatListing.message.text).toContain(`#${album.id}`);
      expect(invalidChatListing.payload.entities).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test("renders every dashboard command and paginates a populated queue", async () => {
    const harness = createHarness();
    try {
      for (const [index, command] of ["start", "manage", "queue", "schedule", "whitelist", "authors", "health"].entries()) {
        await harness.run(commandUpdate(300 + index, 300 + index, command));
        expect(harness.lastSent().message.text.length).toBeGreaterThan(0);
      }
      expect(harness.calls.some((call) => call.method === "setMyCommands")).toBe(true);
      for (let index = 0; index < 11; index += 1) harness.queue.observeQueueSnapshot(snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(1000 + index) }), NOW + index);
      await harness.run(commandUpdate(310, 310, "queue"));
      const firstPage = harness.lastSent();
      expect(firstPage.message.text).toContain("items 1–10");
      expect(firstPage.payload.entities).toHaveLength(10);
      await harness.run(callbackUpdate(311, "queue-next", harness.callbackData(firstPage, "Next"), firstPage.message));
      const secondPage = harness.lastSent();
      expect(secondPage.message.text).toContain("items 11–11");
      expect(secondPage.payload.entities).toHaveLength(1);
      expect((secondPage.payload.entities as Array<{ url: string }>)[0]?.url).toBe("https://t.me/c/1234567890/1010");
    } finally {
      harness.close();
    }
  });

  test("manages whitelist and author prompts, including invalid input and confirmation", async () => {
    const harness = createHarness();
    try {
      await harness.run(commandUpdate(320, 320, "whitelist"));
      let menu = harness.lastSent();
      await harness.run(callbackUpdate(321, "whitelist-add", harness.callbackData(menu, "Add channel"), menu.message));
      let question = harness.lastSent();
      await harness.run(replyUpdate(322, 322, "not a channel", question.message));
      expect(harness.lastSent().message.text).toContain("exact public");
      await harness.run(replyUpdate(323, 323, "@valid_channel", question.message));
      const confirmation = harness.lastSent();
      expect(confirmation.message.text).toContain("Confirm whitelist");
      await harness.run(callbackUpdate(324, "whitelist-confirm", harness.callbackData(confirmation, "Confirm"), confirmation.message));
      expect(harness.policy.listChannels()).toHaveLength(1);

      await harness.run(commandUpdate(325, 325, "authors"));
      menu = harness.lastSent();
      harness.policy.observeAuthor({ kind: "user", userId: asUserId(7), username: "observed_user", displayName: "Observed" }, NOW);
      await harness.run(callbackUpdate(326, "alias-add", harness.callbackData(menu, "Set alias"), menu.message));
      question = harness.lastSent();
      await harness.run(replyUpdate(327, 327, "wrong-format", question.message));
      expect(harness.lastSent().message.text).toContain("Use");
      await harness.run(replyUpdate(328, 328, "@observed_user The Alias", question.message));
      expect(harness.policy.listAuthors().find((author) => author.userId === 7)?.alias).toBe("The Alias");
    } finally {
      harness.close();
    }
  });

  test("handles recovery prompts, safety review, and unauthorized private messages", async () => {
    const harness = createHarness();
    try {
      harness.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(1) }), NOW);
      await harness.run(commandUpdate(330, 330, "recover"));
      const recoveryQuestion = harness.lastSent();
      await harness.run(replyUpdate(331, 331, "88", recoveryQuestion.message));
      expect(harness.sent.some((message) => message.message.text.includes("Recovered queue item #1"))).toBe(true);

      harness.pending.upsert(snapshotFixture({ messageId: asMessageId(901) }), NOW, NOW);
      harness.pending.markState(-1001234567890, 901, "quarantined_renewal_candidate", NOW, "renew-901", "renewal pending");
      const item = harness.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(902) }), NOW).item;
      harness.database.raw.query("INSERT INTO orphaned_sources (item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, attempt_count, next_attempt_at, terminal_reason) VALUES (?, 0, ?, 903, 'age', ?, ?, 1, NULL, 'telegram_age_limit')").run(item.id, Number(QUEUE_CHAT_ID), NOW, NOW);
      await harness.run(commandUpdate(332, 332, "manage"));
      const dashboard = harness.lastSent();
      await harness.run(callbackUpdate(333, "safety", harness.callbackData(dashboard, "Safety review"), dashboard.message));
      expect(harness.lastSent().message.text).toContain("Safety review");

      const stranger: User = { id: 99, is_bot: false, first_name: "Stranger" };
      await harness.run(commandUpdate(334, 334, "queue"));
      await harness.run({ update_id: 335, message: makeMessage(335, "hello", stranger) } as Update);
      expect(harness.lastSent().message.text).toBe("Not authorized.");
    } finally {
      harness.close();
    }
  });

  test("keeps queue link offsets correct when the uncertainty notice precedes rows", async () => {
    const harness = createHarness();
    try {
      prepareUncertainPublication(harness, 1601);
      await harness.run(commandUpdate(338, 338, "queue"));
      const listing = harness.lastSent();
      expect(listing.message.text).toContain("destination may already contain");
      const link = (listing.payload.entities as Array<{ type: string; offset: number; length: number; url: string }>).find((entity) => entity.type === "text_link");
      expect(link).toBeDefined();
      expect(listing.message.text.slice(link!.offset, link!.offset + link!.length)).toBe("#1");
      expect(link?.url).toBe("https://t.me/c/1234567890/1601");
    } finally {
      harness.close();
    }
  });

  test("confirms retry, move, deletion, stale versions, and Telegram deletion outcomes", async () => {
    const harness = createHarness();
    try {
      const first = harness.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(950) }), NOW).item;
      harness.queue.transition(first.id, "queued", "blocked", NOW, "manual", "review");
      await harness.run(commandUpdate(340, 340, "queue"));
      let menu = harness.lastSent();
      await harness.run(callbackUpdate(341, "retry", harness.callbackData(menu, "Retry #1"), menu.message));
      let confirmation = harness.lastSent();
      await harness.run(callbackUpdate(342, "retry-confirm", harness.callbackData(confirmation, "Confirm retry"), confirmation.message));
      expect(harness.queue.findItemById(1)?.status).toBe("queued");

      const second = harness.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(951) }), NOW + 1).item;
      await harness.run(commandUpdate(343, 343, "queue"));
      menu = harness.lastSent();
      await harness.run(callbackUpdate(344, "move", harness.callbackData(menu, `Move #${second.id}`), menu.message));
      confirmation = harness.lastSent();
      await harness.run(callbackUpdate(345, "move-confirm", harness.callbackData(confirmation, "Confirm move to end"), confirmation.message));
      expect(harness.queue.findItemById(second.id)?.lastErrorCode).toBe("moved_to_end");

      await harness.run(commandUpdate(346, 346, "queue"));
      menu = harness.lastSent();
      await harness.run(callbackUpdate(347, "delete", harness.callbackData(menu, "Delete #1"), menu.message));
      confirmation = harness.lastSent();
      await harness.run(callbackUpdate(348, "delete-confirm", harness.callbackData(confirmation, "Confirm delete #1"), confirmation.message));
      expect(harness.queue.findItemById(1)?.status).toBe("deleted");

      const stale = harness.queue.observeQueueSnapshot(snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(952) }), NOW + 2).item;
      const staleToken = harness.admin.createCallbackToken(ADMIN_ID, "queue_move_end", { itemId: stale.id }, NOW, stale.contentVersion);
      harness.queue.updateSnapshot(QUEUE_CHAT_ID, 952, snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(952), editDate: NOW + 1, text: "changed" }));
      await harness.run(callbackUpdate(349, "stale", `v1:${staleToken}`, makeMessage(349, "menu", BOT_INFO)));
      expect(harness.lastSent().message.text).toContain("changed");

      const missing = harness.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(953) }), NOW + 3).item;
      const missingToken = harness.admin.createCallbackToken(ADMIN_ID, "queue_delete_confirm", { itemId: missing.id }, NOW, missing.contentVersion);
      harness.setDeleteFailure({ kind: "source_missing", description: "message not found" });
      await harness.run(callbackUpdate(350, "missing", `v1:${missingToken}`, makeMessage(350, "menu", BOT_INFO)));
      expect(harness.queue.findItemById(missing.id)?.status).toBe("deleted_external");

      const denied = harness.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(954) }), NOW + 4).item;
      const deniedToken = harness.admin.createCallbackToken(ADMIN_ID, "queue_delete_confirm", { itemId: denied.id }, NOW, denied.contentVersion);
      harness.setDeleteFailure({ kind: "permission_denied", description: "not enough rights" });
      await harness.run(callbackUpdate(351, "denied", `v1:${deniedToken}`, makeMessage(351, "menu", BOT_INFO)));
      expect(harness.lastSent().message.text).toContain("Deletion failed (permission_denied)");
    } finally {
      harness.close();
    }
  });

  test.each([
    [{ kind: "cleanup_pending", itemId: 1, operationId: "op" }, "cleanup is pending"],
    [{ kind: "retry_scheduled", itemId: 1, retryAt: NOW + 60_000 }, "retry is scheduled"],
    [{ kind: "blocked", itemId: 1, status: "blocked", reason: "manual" }, "remains blocked"],
    [{ kind: "failed", itemId: 1, status: "queued", error: "failed" }, "failed"],
    [{ kind: "deleted_external", itemId: 1 }, "already missing"],
    [{ kind: "empty" }, "queue is empty"],
  ] as const)("renders publication outcome %s", async (outcome, expectedText) => {
    const harness = createHarness(async () => outcome);
    try {
      harness.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(980) }), NOW);
      const token = harness.admin.createCallbackToken(ADMIN_ID, "publish_execute", { itemId: 1, sourceGeneration: 0 }, NOW);
      await harness.run(callbackUpdate(360, "outcome", `v1:${token}`, makeMessage(360, "menu", BOT_INFO)));
      expect(harness.lastSent().message.text.toLowerCase()).toContain(expectedText);
    } finally {
      harness.close();
    }
  });
});

describe("admin uncertainty resolution handlers", () => {
  test("shows incomplete renewal evidence and rejects a conflicting exact replacement set", async () => {
    const harness = createHarness();
    try {
      const first = snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(1701), mediaGroupId: "partial-review", telegramDate: 0 });
      const item = harness.queue.observeQueueSnapshot(first, 1).item;
      harness.queue.addAlbumMember(item.id, snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(1702), mediaGroupId: "partial-review", telegramDate: 0 }), 1);
      harness.queue.addAlbumMember(item.id, snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(1703), mediaGroupId: "partial-review", telegramDate: 0 }), 1);
      harness.queue.finalizeAlbums(NOW);
      const claimed = harness.queue.claimRenewal("partial-review-op", NOW, NOW)!;
      harness.queue.recordReplacementOutput(claimed.operationId, QUEUE_CHAT_ID, asMessageId(1711), 0, NOW);
      harness.queue.recordReplacementOutput(claimed.operationId, QUEUE_CHAT_ID, asMessageId(1712), 1, NOW);
      harness.queue.setRenewalUncertain(item.id, claimed.operationId, NOW, "partial_replacement", "Incomplete replacement: expected 3 messages but received 2");

      await harness.run(commandUpdate(430, 430, "queue"));
      const queueMenu = harness.lastSent();
      await harness.run(callbackUpdate(431, "open-partial", harness.callbackData(queueMenu, "Resolve renewal #1"), queueMenu.message));
      const review = harness.lastSent();
      expect(review.message.text).toContain("partial_replacement");
      expect(review.message.text).toContain("Known replacement IDs (2): 1711, 1712");
      expect(review.message.text).toContain("Known replacement count: 2 of 3");
      const reviewButtons = (review.payload.reply_markup as InlineKeyboardMarkup).inline_keyboard.flat().map((button) => button.text);
      expect(reviewButtons).not.toContain("Adopt known replacements");

      await harness.run(callbackUpdate(432, "enter-exact-partial", harness.callbackData(review, "Enter exact replacements"), review.message));
      const prompt = harness.lastSent();
      await harness.run(replyUpdate(433, 433, "1711 1713 1714", prompt.message));
      expect(harness.lastSent().message.text).toContain("Known partial replacement IDs conflict");
      expect(harness.queue.findItemById(item.id)?.sourceGeneration).toBe(0);
      expect(harness.queue.currentSourceIds(item.id)).toEqual([asMessageId(1701), asMessageId(1702), asMessageId(1703)]);
      expect(harness.queue.operationEvidence(item.id)?.knownReplacementIds).toEqual([asMessageId(1711), asMessageId(1712)]);
    } finally {
      harness.close();
    }
  });

  test("retries, adopts, and prompts for uncertain publication evidence", async () => {
    const retryHarness = createHarness();
    try {
      const prepared = prepareUncertainPublication(retryHarness, 1100);
      await retryHarness.run(commandUpdate(400, 400, "queue"));
      const menu = retryHarness.lastSent();
      await retryHarness.run(callbackUpdate(401, "resolve-publication", retryHarness.callbackData(menu, "Resolve #1"), menu.message));
      expect(retryHarness.lastSent().message.text).toContain("Uncertain publication #1");
      const retryToken = retryHarness.admin.createCallbackToken(ADMIN_ID, "uncertain_publish_retry", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, phase: "uncertain" }, NOW);
      await retryHarness.run(callbackUpdate(402, "retry-publication", `v1:${retryToken}`, makeMessage(402, "menu", BOT_INFO)));
      expect(retryHarness.queue.findItemById(1)?.status).toBe("queued");
    } finally {
      retryHarness.close();
    }

    const adoptHarness = createHarness();
    try {
      const prepared = prepareUncertainPublication(adoptHarness, 1101, [710]);
      const adoptToken = adoptHarness.admin.createCallbackToken(ADMIN_ID, "uncertain_publish_adopt_known", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, phase: "uncertain" }, NOW);
      await adoptHarness.run(callbackUpdate(403, "adopt-publication", `v1:${adoptToken}`, makeMessage(403, "menu", BOT_INFO)));
      expect(adoptHarness.queue.findItemById(1)?.status).toBe("published_cleanup_pending");
    } finally {
      adoptHarness.close();
    }

    const promptHarness = createHarness();
    try {
      const prepared = prepareUncertainPublication(promptHarness, 1102);
      const promptToken = promptHarness.admin.createCallbackToken(ADMIN_ID, "uncertain_publish_adopt_prompt", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, expectedCount: 1, phase: "uncertain" }, NOW);
      await promptHarness.run(callbackUpdate(404, "prompt-publication", `v1:${promptToken}`, makeMessage(404, "menu", BOT_INFO)));
      const question = promptHarness.lastSent();
      await promptHarness.run(replyUpdate(405, 405, "not ids", question.message));
      expect(promptHarness.lastSent().message.text).toContain("exactly 1");
      await promptHarness.run(replyUpdate(406, 406, "711", question.message));
      expect(promptHarness.queue.findItemById(1)?.status).toBe("published_cleanup_pending");
    } finally {
      promptHarness.close();
    }
  });

  test("resolves uncertain renewal by adoption, no replacement, and explicit cleanup", async () => {
    const noReplacement = createHarness();
    try {
      const prepared = prepareUncertainRenewal(noReplacement, 1200);
      await noReplacement.run(commandUpdate(410, 410, "queue"));
      const menu = noReplacement.lastSent();
      await noReplacement.run(callbackUpdate(411, "resolve-renewal", noReplacement.callbackData(menu, "Resolve renewal #1"), menu.message));
      const noReplacementToken = noReplacement.admin.createCallbackToken(ADMIN_ID, "renewal_no_replacement", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, phase: "uncertain" }, NOW);
      await noReplacement.run(callbackUpdate(412, "no-replacement", `v1:${noReplacementToken}`, makeMessage(412, "menu", BOT_INFO)));
      expect(noReplacement.queue.findItemById(1)?.maintenanceStatus).toBe("idle");
    } finally {
      noReplacement.close();
    }

    const adopt = createHarness();
    try {
      const prepared = prepareUncertainRenewal(adopt, 1201, [801]);
      const token = adopt.admin.createCallbackToken(ADMIN_ID, "renewal_adopt_known", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, phase: "uncertain" }, NOW);
      await adopt.run(callbackUpdate(413, "adopt-renewal", `v1:${token}`, makeMessage(413, "menu", BOT_INFO)));
      expect(adopt.queue.findItemById(1)?.maintenanceStatus).toBe("renewal_cleanup_pending");
    } finally {
      adopt.close();
    }

    const prompt = createHarness();
    try {
      const prepared = prepareUncertainRenewal(prompt, 1202);
      const token = prompt.admin.createCallbackToken(ADMIN_ID, "renewal_adopt_prompt", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, expectedCount: 1, phase: "uncertain" }, NOW);
      await prompt.run(callbackUpdate(414, "prompt-renewal", `v1:${token}`, makeMessage(414, "menu", BOT_INFO)));
      const question = prompt.lastSent();
      await prompt.run(replyUpdate(415, 415, "801 802", question.message));
      expect(prompt.lastSent().message.text).toContain("exactly 1");
      await prompt.run(replyUpdate(416, 416, "802", question.message));
      expect(prompt.queue.findItemById(1)?.maintenanceStatus).toBe("renewal_cleanup_pending");
    } finally {
      prompt.close();
    }

    const cleanup = createHarness();
    try {
      const prepared = prepareUncertainRenewal(cleanup, 1203, [803]);
      const token = cleanup.admin.createCallbackToken(ADMIN_ID, "renewal_cleanup_prompt", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, phase: "uncertain" }, NOW);
      await cleanup.run(callbackUpdate(417, "cleanup-prompt", `v1:${token}`, makeMessage(417, "menu", BOT_INFO)));
      const question = cleanup.lastSent();
      await cleanup.run(replyUpdate(418, 418, "803", question.message));
      expect(cleanup.queue.findItemById(1)?.maintenanceStatus).toBe("idle");
    } finally {
      cleanup.close();
    }
  });

  test("handles known-output cleanup success, missing output, and failure", async () => {
    const missing = createHarness();
    try {
      const prepared = prepareUncertainPublication(missing, 1300, [901]);
      const token = missing.admin.createCallbackToken(ADMIN_ID, "uncertain_publish_delete_retry", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, phase: "uncertain" }, NOW);
      missing.setDeleteFailure({ kind: "source_missing", description: "message not found" });
      await missing.run(callbackUpdate(420, "missing-output", `v1:${token}`, makeMessage(420, "menu", BOT_INFO)));
      expect(missing.queue.findItemById(1)?.status).toBe("queued");
    } finally {
      missing.close();
    }

    const failed = createHarness();
    try {
      const prepared = prepareUncertainPublication(failed, 1301, [902]);
      const token = failed.admin.createCallbackToken(ADMIN_ID, "uncertain_publish_delete_retry", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, phase: "uncertain" }, NOW);
      failed.setDeleteFailure({ kind: "permission_denied", description: "not enough rights" });
      await failed.run(callbackUpdate(421, "failed-output", `v1:${token}`, makeMessage(421, "menu", BOT_INFO)));
      expect(failed.lastSent().message.text).toContain("Known output cleanup failed");
    } finally {
      failed.close();
    }

    const renewalDelete = createHarness();
    try {
      const prepared = prepareUncertainRenewal(renewalDelete, 1302, [903]);
      const token = renewalDelete.admin.createCallbackToken(ADMIN_ID, "renewal_delete_replacements", { itemId: 1, operationId: prepared.operationId, sourceGeneration: 0, phase: "uncertain" }, NOW);
      renewalDelete.setDeleteFailure({ kind: "source_missing", description: "message not found" });
      await renewalDelete.run(callbackUpdate(422, "missing-replacement", `v1:${token}`, makeMessage(422, "menu", BOT_INFO)));
      expect(renewalDelete.queue.findItemById(1)?.maintenanceStatus).toBe("idle");
    } finally {
      renewalDelete.close();
    }
  });
});

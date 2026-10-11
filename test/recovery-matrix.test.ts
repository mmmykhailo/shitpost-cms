import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@grammyjs/types";
import { createDatabase } from "../src/db/database";
import { createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createRecoveryRepository } from "../src/db/recovery-repository";
import { createRecoveryService, parseRecoveryReference, queueInternalId } from "../src/services/recovery";
import { createFakeClock } from "../src/clock";
import type { Logger } from "../src/logger";
import type { TelegramGateway } from "../src/telegram";
import { asChatId, asMessageId, asUserId } from "../src/types";

const QUEUE_CHAT_ID = asChatId(-1001234567890);
const ADMIN_CHAT_ID = asChatId(99);
const directories: string[] = [];

const loggerSpy = (): { logger: Logger; events: string[] } => {
  const events: string[] = [];
  const logger: Logger = {
    debug: (event) => events.push(`debug:${event}`),
    info: (event) => events.push(`info:${event}`),
    warn: (event) => events.push(`warn:${event}`),
    error: (event) => events.push(`error:${event}`),
  };
  return { logger, events };
};

const preview = (messageId: number, options: { origin?: Message["forward_origin"]; album?: boolean; text?: boolean } = {}): Message => ({
  message_id: messageId,
  date: 1,
  chat: { id: 99, type: "private" },
  ...(options.text === false ? { photo: [{ file_id: `photo-${messageId}`, width: 10, height: 10 }] } : { text: "recovered" }),
  ...(options.album ? { media_group_id: "album-1" } : {}),
  ...(options.origin === undefined ? {} : { forward_origin: options.origin }),
}) as Message;

const baseGateway = (forward: (messageId: number) => Promise<Message>): TelegramGateway => ({
  getBotIdentity: async () => ({ id: asUserId(1) }),
  getChat: async () => ({ id: QUEUE_CHAT_ID, type: "channel" }),
  getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
  forwardMessages: async () => [],
  copyMessages: async () => [],
  forwardMessage: async ({ messageId }) => forward(Number(messageId)),
  editText: async () => {},
  editCaption: async () => {},
  sendText: async () => asMessageId(1),
  deleteMessages: async () => {},
  sendAdminMessage: async () => asMessageId(1),
  editAdminMessage: async () => {},
  answerCallbackQuery: async () => {},
});

const open = (gateway: TelegramGateway, withRepository = true) => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-recovery-matrix-"));
  directories.push(directory);
  const database = createDatabase(join(directory, "bot.sqlite"));
  const recoveryRepository = withRepository ? createRecoveryRepository(database) : undefined;
  const { logger, events } = loggerSpy();
  const recovery = createRecoveryService({
    queue: createQueueRepository(database),
    policy: createPolicyRepository(database),
    gateway,
    ...(recoveryRepository === undefined ? {} : { recovery: recoveryRepository }),
    queueChannelId: QUEUE_CHAT_ID,
    adminChatId: ADMIN_CHAT_ID,
    clock: createFakeClock(10_000),
    logger,
    operationId: (() => { let count = 0; return () => `matrix-recovery-${++count}`; })(),
  });
  return { database, recovery, recoveryRepository, events };
};

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("recovery reference and recovery lifecycle matrix", () => {
  test("rejects malformed links, ranges, duplicates, and invalid queue IDs", () => {
    expect(() => queueInternalId(asChatId(-123))).toThrow(/Private queue links/);
    expect(() => parseRecoveryReference("", QUEUE_CHAT_ID)).toThrow(/Provide/);
    expect(() => parseRecoveryReference("https://t.me/c/1234567890/88/extra", QUEUE_CHAT_ID)).toThrow(/private/);
    expect(() => parseRecoveryReference("3-2", QUEUE_CHAT_ID)).toThrow(/1–10/);
    expect(() => parseRecoveryReference("1-12", QUEUE_CHAT_ID)).toThrow(/1–10/);
    expect(() => parseRecoveryReference("1,1", QUEUE_CHAT_ID)).toThrow(/unique/);
    expect(() => parseRecoveryReference("2 1", QUEUE_CHAT_ID)).toThrow(/unique/);
    expect(() => parseRecoveryReference("not-an-id", QUEUE_CHAT_ID)).toThrow(/numeric IDs/);
    expect(() => parseRecoveryReference(Array.from({ length: 11 }, (_, index) => index + 1).join(" "), QUEUE_CHAT_ID)).toThrow(/unique/);
  });

  test("preserves an external channel origin and handles cleanup already missing", async () => {
    const gateway = baseGateway(async (id) => preview(id + 600, { origin: { type: "channel", date: 1, chat: { id: -300, type: "channel", title: "Source" }, message_id: id } }));
    const deleted: number[] = [];
    gateway.deleteMessages = async (_chatId, ids) => { deleted.push(...ids.map(Number)); throw { kind: "source_missing", description: "message not found" }; };
    const current = open(gateway);
    const result = await current.recovery.recover("88");
    expect(result.sourceIds).toEqual([asMessageId(88)]);
    expect(current.database.raw.query("SELECT origin_json FROM queue_items WHERE id = ?").get(result.itemId)).toEqual({ origin_json: JSON.stringify({ kind: "channel", chatId: -300, title: "Source" }) });
    expect(deleted).toEqual([688]);
    expect(current.recoveryRepository?.session("matrix-recovery-1")?.phase).toBe("completed");
  });

  test("recovers a compatible album and observes each author", async () => {
    const gateway = baseGateway(async (id) => preview(id + 700, {
      album: true,
      text: false,
      origin: { type: "channel", date: 1, chat: { id: -300, type: "channel", title: "Source" }, message_id: id },
    }));
    const current = open(gateway);
    const result = await current.recovery.recover("88-89");
    expect(result.sourceIds).toEqual([asMessageId(88), asMessageId(89)]);
    expect(current.database.raw.query("SELECT COUNT(*) AS count FROM queue_messages WHERE item_id = ?").get(result.itemId)).toEqual({ count: 2 });
    expect(current.recoveryRepository?.session("matrix-recovery-1")?.phase).toBe("completed");
  });

  test("fails incompatible albums and forward calls while cleaning any known previews", async () => {
    const calls: number[] = [];
    const gateway = baseGateway(async (id) => {
      calls.push(id);
      if (id === 89) throw new Error("preview fetch failed");
      return preview(id + 800);
    });
    const current = open(gateway);
    await expect(current.recovery.recover("88-89")).rejects.toThrow("preview fetch failed");
    expect(calls).toEqual([88, 89]);
    expect(current.recoveryRepository?.session("matrix-recovery-1")?.phase).toBe("completed");

    const incompatibleGateway = baseGateway(async (id) => preview(id + 810, { album: true }));
    const incompatible = open(incompatibleGateway);
    await expect(incompatible.recovery.recover("90-91")).rejects.toThrow(/incompatible content/);
    expect(incompatible.recoveryRepository?.session("matrix-recovery-1")?.phase).toBe("completed");
  });

  test("keeps a durable cleanup retry when preview deletion fails", async () => {
    const gateway = baseGateway(async (id) => preview(id + 900));
    gateway.deleteMessages = async () => { throw { kind: "permission_denied", description: "rights lost" }; };
    const current = open(gateway);
    const result = await current.recovery.recover("92");
    expect(result.itemId).toBe(1);
    expect(current.recoveryRepository?.session("matrix-recovery-1")?.phase).toBe("preview_cleanup_pending");
    expect(current.events).toContain("error:recovery_preview_cleanup_failed");
  });

  test("reconciles incomplete and failed restart sessions and supports no durable repository", async () => {
    const gateway = baseGateway(async (id) => preview(id + 950));
    const current = open(gateway);
    current.recoveryRepository!.createSession("missing-preview", [asMessageId(1)], "old", 0, 1);
    current.recoveryRepository!.addPreviewPending("missing-preview", 1, 0, 0);
    expect(await current.recovery.reconcileExpiredSessions()).toEqual({ completed: 0, blocked: 1 });
    expect(current.recoveryRepository!.session("missing-preview")?.phase).toBe("preview_cleanup_pending");

    const failingGateway = baseGateway(async (id) => preview(id + 960));
    failingGateway.deleteMessages = async () => { throw new Error("cleanup unavailable"); };
    const failing = open(failingGateway);
    failing.recoveryRepository!.createSession("recorded-preview", [asMessageId(2)], "old", 0, 1);
    failing.recoveryRepository!.addPreviewPending("recorded-preview", 2, 0, 0);
    failing.recoveryRepository!.recordPreview("recorded-preview", 2, Number(ADMIN_CHAT_ID), 962, {
      schemaVersion: 1,
      chatId: QUEUE_CHAT_ID,
      messageId: asMessageId(2),
      ordinal: 0,
      contentType: "text",
      text: "preview",
      origin: { kind: "absent" },
      telegramDate: 1,
      hasReplyMarkup: false,
    }, 0);
    expect(await failing.recovery.reconcileExpiredSessions()).toEqual({ completed: 0, blocked: 1 });
    expect(failing.recoveryRepository!.session("recorded-preview")?.phase).toBe("preview_cleanup_pending");

    const withoutRepository = open(gateway, false);
    expect(await withoutRepository.recovery.reconcileExpiredSessions()).toEqual({ completed: 0, blocked: 0 });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createRecoveryRepository } from "../src/db/recovery-repository";
import { createRecoveryService, parseRecoveryReference, queueInternalId } from "../src/services/recovery";
import { snapshotFromMessage } from "../src/domain/message";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId, asUserId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import type { Message } from "@grammyjs/types";

const resources: Array<{ directory: string; close(): void }> = [];

const preview = (id: number, origin: Message["forward_origin"]): Message => ({
  message_id: id,
  date: 1,
  chat: { id: 99, type: "private" },
  text: "recovered",
  ...(origin === undefined ? {} : { forward_origin: origin }),
}) as Message;

const open = () => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-recovery-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  let nextPreview = 700;
  const deleted: number[] = [];
  const gateway: TelegramGateway = {
    getBotIdentity: async () => ({ id: asUserId(1) }),
    getChat: async () => ({ id: asChatId(-1001234567890), type: "channel" }),
    getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
    forwardMessages: async () => [],
    copyMessages: async () => [],
    forwardMessage: async ({ messageId }) => preview(nextPreview++, { type: "channel", date: 1, chat: { id: -1001234567890, type: "channel", title: "Queue" }, message_id: Number(messageId) }),
    editText: async ({ messageId }) => ({ messageId }),
    editCaption: async ({ messageId }) => ({ messageId }),
    sendText: async () => asMessageId(1),
    deleteMessages: async (_chatId, messageIds) => { deleted.push(...messageIds.map(Number)); },
    sendAdminMessage: async () => asMessageId(1),
    editAdminMessage: async () => {},
    answerCallbackQuery: async () => {},
  };
  const recoveryRepository = createRecoveryRepository(database);
  const recovery = createRecoveryService({ queue: createQueueRepository(database), policy: createPolicyRepository(database), recovery: recoveryRepository, gateway, queueChannelId: asChatId(-1001234567890), adminChatId: asChatId(99), clock: createFakeClock(10_000), logger: createLogger("error"), operationId: () => "recover-1" });
  resources.push({ directory, close: database.close });
  return { recovery, recoveryRepository, deleted, queue: createQueueRepository(database), database };
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("recovery", () => {
  test("accepts only links for the configured private queue channel", () => {
    const channel = asChatId(-1001234567890);
    expect(queueInternalId(channel)).toBe("1234567890");
    expect(parseRecoveryReference("https://t.me/c/1234567890/88", channel)).toEqual([88]);
    expect(parseRecoveryReference("88-90", channel)).toEqual([88, 89, 90]);
    expect(() => parseRecoveryReference("https://t.me/c/999/88", channel)).toThrow(/not from/);
    expect(() => parseRecoveryReference("https://t.me/public/88", channel)).toThrow(/private/);
  });

  test("recovers direct queue posts as originless and removes admin previews", async () => {
    const { recovery, deleted, queue, database } = open();
    const recovered = await recovery.recover("t.me/c/1234567890/88");
    expect(recovered.sourceIds).toEqual([asMessageId(88)]);
    expect(queue.findItemById(recovered.itemId)?.status).toBe("queued");
    expect(queue.findItemById(recovered.itemId)?.origin).toEqual({ kind: "absent" });
    expect(deleted).toEqual([asMessageId(700)]);
    expect((database.raw.query("SELECT phase FROM recovery_sessions WHERE id = 'recover-1'").get() as { phase: string }).phase).toBe("completed");
  });

  test("reconciles recorded previews after a restart", async () => {
    const { recovery, recoveryRepository, deleted, database } = open();
    recoveryRepository.createSession("stale-recovery", [asMessageId(88)], "old-boot", 0, 1);
    recoveryRepository.addPreviewPending("stale-recovery", 88, 0, 0);
    recoveryRepository.recordPreview("stale-recovery", 88, 99, 701, snapshotFromMessage(preview(701, undefined)), 0);
    recoveryRepository.markPreviewCleanupPending("stale-recovery", 0, "process restarted before cleanup");

    expect(await recovery.reconcileExpiredSessions()).toEqual({ completed: 1, blocked: 0 });
    expect(deleted).toEqual([asMessageId(701)]);
    expect((database.raw.query("SELECT phase FROM recovery_sessions WHERE id = 'stale-recovery'").get() as { phase: string }).phase).toBe("completed");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createAlertRepository } from "../src/db/alert-repository";
import { createAdminRepository } from "../src/db/admin-repository";
import { createPendingUpdateRepository } from "../src/db/pending-update-repository";
import { createGeneratedMessageRepository, createQueueRepository } from "../src/db/repositories";
import { createAlertService, resolutionTextForDedupeKey } from "../src/services/alerts";
import { calculateRenewalCapacity } from "../src/services/capacity";
import { createBackupService } from "../src/services/backup";
import { createRestoreService } from "../src/services/restore";
import { createRetentionService } from "../src/services/retention";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId, asUserId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";
import { createLoggerSpy, createTestDatabase } from "./support";

const resources: Array<{ close(): void }> = [];

const openDatabase = (prefix: string) => {
  const resource = createTestDatabase(prefix);
  resources.push(resource);
  return resource.database;
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
  }
});

describe("operations safety net", () => {
  test("deduplicates alerts, repeats by policy, and sends a resolution", async () => {
    const database = openDatabase("queuebot-alert");
    const messages: string[] = [];
    const gateway = {
      getBotIdentity: async () => ({ id: asUserId(1) }), getChat: async () => ({ id: asChatId(-100), type: "channel" as const }), getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
      forwardMessages: async () => [], copyMessages: async () => [], forwardMessage: async () => { throw new Error("unused"); }, editText: async () => {}, editCaption: async () => {}, sendText: async () => asMessageId(1), deleteMessages: async () => {}, editAdminMessage: async () => {}, answerCallbackQuery: async () => {},
      sendAdminMessage: async ({ text }: { text: string }) => { messages.push(text); return asMessageId(messages.length); },
    } satisfies TelegramGateway;
    const service = createAlertService({ alert: createAlertRepository(database), gateway, adminChatId: asChatId(99), logger: createLogger("error") });
    await service.raise("permissions:-100", "immediate", "Rights lost", 1_000);
    await service.raise("permissions:-100", "immediate", "Rights lost", 1_001);
    expect(messages).toHaveLength(1);
    await service.resolve("permissions:-100", "Rights restored", 1_002);
    await service.raise("permissions:-100", "immediate", "Rights lost again", 1_003);
    expect(messages).toHaveLength(3);
  });

  test("sends on-change issue alerts once per fingerprint and again after a material change or recurrence", async () => {
    const database = openDatabase("queuebot-alert-on-change");
    const messages: string[] = [];
    const gateway = {
      getBotIdentity: async () => ({ id: asUserId(1) }), getChat: async () => ({ id: asChatId(-100), type: "channel" as const }), getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
      forwardMessages: async () => [], copyMessages: async () => [], forwardMessage: async () => { throw new Error("unused"); }, editText: async () => {}, editCaption: async () => {}, sendText: async () => asMessageId(1), deleteMessages: async () => {}, editAdminMessage: async () => {}, answerCallbackQuery: async () => {},
      sendAdminMessage: async ({ text }: { text: string }) => { messages.push(text); return asMessageId(messages.length); },
    } satisfies TelegramGateway;
    const service = createAlertService({ alert: createAlertRepository(database), gateway, adminChatId: asChatId(99), logger: createLogger("error") });
    const payload = { text: "Queue item #1 needs review", actions: [{ text: "Review", action: "queue_item", payload: { itemId: 1 } }] };

    await service.raiseOnChange("item_issue:1", "normal", "reason-a", { ...payload, operationId: "retry-1" }, 1_000);
    await service.raiseOnChange("item_issue:1", "normal", "reason-a", { ...payload, operationId: "retry-2" }, 86_400_000);
    expect(messages).toHaveLength(1);
    await service.raiseOnChange("item_issue:1", "normal", "reason-b", { ...payload, text: "Queue item #1 needs an edit" }, 86_401_000);
    expect(messages).toHaveLength(2);
    await service.resolve("item_issue:1", "Queue item #1 was fixed", 86_402_000);
    await service.raiseOnChange("item_issue:1", "normal", "reason-a", payload, 86_403_000);
    expect(messages).toHaveLength(4);
  });

  test("retries failed on-change delivery with durable backoff and fresh single-use buttons", async () => {
    const database = openDatabase("queuebot-alert-on-change-retry");
    const sent: Array<{ text: string; markup?: unknown }> = [];
    let fail = true;
    let tokenNumber = 0;
    const gateway = {
      sendAdminMessage: async ({ text, replyMarkup }: { text: string; replyMarkup?: unknown }) => {
        sent.push({ text, markup: replyMarkup });
        if (fail) throw new Error("temporary Telegram failure");
        return asMessageId(sent.length);
      },
    } as unknown as TelegramGateway;
    const service = createAlertService({
      alert: createAlertRepository(database),
      gateway,
      adminChatId: asChatId(99),
      logger: createLogger("error"),
      createCallbackToken: () => `token-${++tokenNumber}`,
    });
    const payload = { text: "Review item #7", actions: [{ text: "Review", action: "queue_item", payload: { itemId: 7 }, itemVersion: 3 }] };

    await service.raiseOnChange("item_issue:7", "immediate", "stable-fingerprint", payload, 1_000);
    const pendingAlert = createAlertRepository(database).find("item_issue:7");
    expect(pendingAlert?.sentFingerprint).toBeUndefined();
    expect(pendingAlert).toMatchObject({ deliveryAttempts: 1, deliveryRetryNotBefore: 31_000 });
    expect(await createAlertService({ alert: createAlertRepository(database), gateway, adminChatId: asChatId(99), logger: createLogger("error") }).retryPendingOnChange(30_999)).toBe(0);

    fail = false;
    const restarted = createAlertService({
      alert: createAlertRepository(database), gateway, adminChatId: asChatId(99), logger: createLogger("error"),
      createCallbackToken: () => `token-${++tokenNumber}`,
    });
    expect(await restarted.retryPendingOnChange(31_000)).toBe(1);
    const markup = sent[1]?.markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(markup.inline_keyboard[0]?.[0]?.callback_data).toBe("v1:token-2");
    expect(createAlertRepository(database).find("item_issue:7")).toMatchObject({ sentFingerprint: "stable-fingerprint", deliveryAttempts: 0 });
    await restarted.raiseOnChange("item_issue:7", "immediate", "stable-fingerprint", { ...payload, operationId: "new-retry-id" }, 86_400_000);
    expect(sent).toHaveLength(2);
  });

  test("labels alert resolutions with the exact publication item", async () => {
    const database = openDatabase("queuebot-alert-labels");
    const messages: string[] = [];
    const gateway = {
      getBotIdentity: async () => ({ id: asUserId(1) }), getChat: async () => ({ id: asChatId(-100), type: "channel" as const }), getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
      forwardMessages: async () => [], copyMessages: async () => [], forwardMessage: async () => { throw new Error("unused"); }, editText: async () => {}, editCaption: async () => {}, sendText: async () => asMessageId(1), deleteMessages: async () => {}, editAdminMessage: async () => {}, answerCallbackQuery: async () => {},
      sendAdminMessage: async ({ text }: { text: string }) => { messages.push(text); return asMessageId(messages.length); },
    } satisfies TelegramGateway;
    const service = createAlertService({ alert: createAlertRepository(database), gateway, adminChatId: asChatId(99), logger: createLogger("error") });

    await service.raise("uncertain_publish:1", "immediate", "Publication for queue item #1 is uncertain.", 1_000);
    await service.resolve("uncertain_publish:1", resolutionTextForDedupeKey("uncertain_publish:1"), 1_001);
    await service.raise("uncertain_publish:2", "immediate", "Publication for queue item #2 is uncertain.", 1_002);

    expect(messages).toEqual([
      "[immediate] Publication for queue item #1 is uncertain.",
      "Resolved: Publication uncertainty for queue item #1 cleared.",
      "[immediate] Publication for queue item #2 is uncertain.",
    ]);
    expect(service.active().map((alert) => alert.dedupeKey)).toEqual(["uncertain_publish:2"]);
    expect(resolutionTextForDedupeKey("future_condition:example")).toBe("Condition future_condition:example cleared.");
  });

  test("uses the worker pacing cost for single messages and albums", () => {
    const now = 36 * 60 * 60_000;
    const capacity = calculateRenewalCapacity({ now, sources: [
      { itemId: 1, logicalSequence: 1, physicalCreatedAt: 0, memberCount: 1 },
      { itemId: 2, logicalSequence: 2, physicalCreatedAt: 0, memberCount: 10 },
    ] });

    expect(capacity).toMatchObject({ safe: true, availableAt: now + 33_000, totalMessages: 11 });
  });

  test("flags the first source that exceeds the 46-hour deadline", () => {
    const now = 36 * 60 * 60_000;
    const sources = Array.from({ length: 21 }, (_, index) => ({
      itemId: index + 1,
      logicalSequence: index + 1,
      physicalCreatedAt: now - (46 * 60 * 60_000 - 60_000),
      memberCount: 1,
    }));
    const capacity = calculateRenewalCapacity({ now, sources });

    expect(capacity.safe).toBe(false);
    expect(capacity.projectedFirstMiss).toMatchObject({ itemId: 21, projectedAt: now + 63_000 });
  });

  test("lets a ready source go before an older source with a future retry", () => {
    const now = 36 * 60 * 60_000;
    const capacity = calculateRenewalCapacity({ now, sources: [
      { itemId: 1, logicalSequence: 1, physicalCreatedAt: now - (46 * 60 * 60_000 - 60_000), memberCount: 1, maintenanceRetryNotBefore: now + 5 * 60 * 60_000 },
      { itemId: 2, logicalSequence: 2, physicalCreatedAt: now - 45 * 60 * 60_000, memberCount: 1 },
    ] });

    expect(capacity.projectedFirstMiss).toMatchObject({ itemId: 1, projectedAt: now + 5 * 60 * 60_000 + 3_000 });
  });

  test("applies shared cooldown to every projected source", () => {
    const now = 36 * 60 * 60_000;
    const capacity = calculateRenewalCapacity({ now, cooldownUntil: now + 10_000, sources: [
      { itemId: 1, physicalCreatedAt: 0, memberCount: 1 },
      { itemId: 2, physicalCreatedAt: 0, memberCount: 1 },
    ] });

    expect(capacity.availableAt).toBe(now + 16_000);
  });

  test("projects eligibility from the 36-hour start age and surfaces due uncertainty", () => {
    const now = 20 * 60 * 60_000;
    const eligibleLater = calculateRenewalCapacity({ now, sources: [{ itemId: 2, physicalCreatedAt: 0, memberCount: 1 }] });
    const blocked = calculateRenewalCapacity({ now: 36 * 60 * 60_000, sources: [
      { itemId: 1, physicalCreatedAt: 0, memberCount: 1, maintenanceStatus: "uncertain_renewal" },
    ] });

    expect(eligibleLater.availableAt).toBe(36 * 60 * 60_000 + 3_000);
    expect(blocked).toMatchObject({ safe: false, blockedItemIds: [1], totalMessages: 0, availableAt: 36 * 60 * 60_000 });
    expect(blocked.projectedFirstMiss).toBeUndefined();
  });

  test("creates an integrity-checked rolling backup", () => {
    const resource = createTestDatabase("queuebot-backup");
    resources.push(resource);
    const { database, directory } = resource;
    const log = createLoggerSpy();
    const backup = createBackupService({ database, directory: join(directory, "backups"), logger: log.logger, now: () => 1_000 });
    const path = backup.runOnce();
    expect(path.endsWith(".sqlite")).toBe(true);
    expect(Bun.file(path).size).toBeGreaterThan(0);
    expect(log.entries.map((entry) => entry.event)).toContain("backup_completed");
  });

  test("verifies and atomically restores a standalone backup", () => {
    const resource = createTestDatabase("queuebot-restore");
    resources.push(resource);
    const { database, directory } = resource;
    const backup = createBackupService({ database, directory: join(directory, "backups"), logger: createLogger("error"), now: () => 2_000 });
    const source = backup.runOnce();
    const destination = join(directory, "restored.sqlite");
    const service = createRestoreService();
    expect(service.inspectBackup(source).integrity).toBe("ok");
    const first = service.restoreBackup(source, destination);
    expect(first.previousPath).toBeUndefined();
    const second = service.restoreBackup(source, destination);
    expect(second.previousPath).toBeDefined();
    expect(Bun.file(destination).size).toBeGreaterThan(0);
    expect(Bun.file(second.previousPath!).size).toBeGreaterThan(0);
  });

  test("rejects non-standalone and schema-less restore sources", () => {
    const resource = createTestDatabase("queuebot-restore-invalid");
    resources.push(resource);
    const { database, directory } = resource;
    const backup = createBackupService({ database, directory: join(directory, "backups"), logger: createLogger("error"), now: () => 3_000 });
    const source = backup.runOnce();
    const service = createRestoreService();

    writeFileSync(`${source}-wal`, "sidecar");
    expect(() => service.inspectBackup(source)).toThrow(/WAL sidecars/);
    rmSync(`${source}-wal`);
    expect(() => service.restoreBackup(source, source)).toThrow(/different files/);

    const schemaLess = join(directory, "schema-less.sqlite");
    const raw = new Database(schemaLess);
    raw.exec("CREATE TABLE schema_migrations (version INTEGER)");
    raw.close();
    expect(() => service.inspectBackup(schemaLess)).toThrow(/no schema migration history/);
  });

  test("expires, validates, consumes, and purges admin state", () => {
    const database = openDatabase("queuebot-admin-state");
    const admin = createAdminRepository(database);

    expect(admin.getPrompt(7, 100)).toBeUndefined();
    admin.setPrompt(7, "author", { step: "name" }, 44, 100, 10);
    expect(admin.getPrompt(7, 109)).toEqual({ kind: "author", state: { step: "name" }, expectedReplyToMessageId: 44 });
    expect(admin.getPrompt(7, 110)).toBeUndefined();

    admin.setPrompt(7, "author", { step: "alias" }, undefined, 200, 100);
    expect(admin.getPrompt(7, 201)).toEqual({ kind: "author", state: { step: "alias" } });
    database.raw.query("UPDATE admin_prompts SET state_json = ? WHERE admin_id = ?").run("[]", 7);
    expect(admin.getPrompt(7, 202)).toBeUndefined();
    admin.setPrompt(7, "author", { step: "clear" }, undefined, 300);
    admin.clearPrompt(7);
    expect(admin.getPrompt(7, 301)).toBeUndefined();

    const expired = admin.createCallbackToken(7, "expired", { item: 1 }, 400, undefined, 1);
    expect(admin.consumeCallbackToken(999, expired, 400)).toBeUndefined();
    expect(admin.consumeCallbackToken(7, expired, 401)).toBeUndefined();

    const valid = admin.createCallbackToken(7, "publish", { item: 2 }, 500, 3, 100);
    expect(admin.consumeCallbackToken(7, valid, 501)).toEqual({ action: "publish", payload: { item: 2 }, itemVersion: 3 });
    expect(admin.consumeCallbackToken(7, valid, 502)).toBeUndefined();

    const corrupt = admin.createCallbackToken(7, "corrupt", { item: 3 }, 600, undefined, 100);
    database.raw.query("UPDATE callback_tokens SET payload_json = ? WHERE token = ?").run("[]", corrupt);
    expect(admin.consumeCallbackToken(7, corrupt, 601)).toBeUndefined();

    admin.createCallbackToken(7, "old", { item: 4 }, 0, undefined, 1);
    admin.setPrompt(7, "expired", { old: true }, undefined, 0, 1);
    admin.audit("old", "admin:7", 1, undefined, undefined, { old: true });
    admin.audit("new", "admin:7", 20, undefined, "op-1");
    expect(admin.purgeExpiredTokensAndPrompts(8 * 86_400_000)).toEqual({ tokens: 4, prompts: 1 });
    expect(admin.purgeAuditEvents(10)).toBe(1);
  });

  test("retention purges old terminal pending-update rows", () => {
    const database = openDatabase("queuebot-retention");
    const pending = createPendingUpdateRepository(database);
    pending.upsert(snapshotFixture({ messageId: asMessageId(906) }), 1_000);
    pending.markState(-100, 906, "ingested", 1_001);
    const retention = createRetentionService({
      queue: createQueueRepository(database),
      generated: createGeneratedMessageRepository(database),
      pending,
      admin: createAdminRepository(database),
      alerts: createAlertRepository(database),
      clock: { now: () => 8 * 86_400_000, sleep: async () => {} },
      logger: createLogger("error"),
    });
    retention.runOnce();
    expect(pending.find(-100, 906)).toBeUndefined();
  });
});

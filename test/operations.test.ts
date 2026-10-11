import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
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

const resources: Array<{ directory: string; close(): void }> = [];

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("operations safety net", () => {
  test("deduplicates alerts, repeats by policy, and sends a resolution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-alert-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    resources.push({ directory, close: database.close });
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

  test("labels alert resolutions with the exact publication item", async () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-alert-labels-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    resources.push({ directory, close: database.close });
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

  test("projects renewal throughput against the 46-hour deadline", () => {
    const now = 1_000_000;
    const safe = calculateRenewalCapacity({ now, messagesPerMinute: 20, sources: [{ itemId: 1, physicalCreatedAt: now - 45 * 60 * 60_000, memberCount: 1 }] });
    const unsafe = calculateRenewalCapacity({ now, messagesPerMinute: 1, sources: [{ itemId: 1, physicalCreatedAt: now - 45 * 60 * 60_000, memberCount: 120 }] });
    expect(safe.safe).toBe(true);
    expect(unsafe.safe).toBe(false);
    expect(unsafe.projectedFirstMiss?.itemId).toBe(1);
  });

  test("creates an integrity-checked rolling backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-backup-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    resources.push({ directory, close: database.close });
    const backup = createBackupService({ database, directory: join(directory, "backups"), logger: createLogger("error"), now: () => 1_000 });
    const path = backup.runOnce();
    expect(path.endsWith(".sqlite")).toBe(true);
    expect(Bun.file(path).size).toBeGreaterThan(0);
  });

  test("verifies and atomically restores a standalone backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-restore-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    resources.push({ directory, close: database.close });
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

  test("retention purges old terminal pending-update rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-retention-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    resources.push({ directory, close: database.close });
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

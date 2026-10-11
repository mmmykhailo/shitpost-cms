import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createAlertRepository } from "../src/db/alert-repository";
import { createAlertService } from "../src/services/alerts";
import { calculateRenewalCapacity } from "../src/services/capacity";
import { createBackupService } from "../src/services/backup";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId, asUserId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";

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
});

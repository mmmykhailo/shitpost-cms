import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createOrphanRepository } from "../src/db/orphan-repository";
import { createOrphanCleanupService } from "../src/services/orphan-cleanup";
import { createRenewalService } from "../src/services/renewal";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId, asUserId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";

const resources: Array<{ directory: string; close(): void }> = [];

const gatewayWithDeleteFailure = (deleteFailureKind: "transient_network" | "permission_denied" | "telegram_age_limit" = "transient_network", failDelete = true) => {
  let nextId = 900;
  let fail = true;
  const calls: string[] = [];
  const gateway: TelegramGateway = {
    getBotIdentity: async () => ({ id: asUserId(1) }),
    getChat: async () => ({ id: asChatId(-100), type: "channel" }),
    getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
    forwardMessages: async ({ messageIds }) => { calls.push("forward"); return messageIds.map(() => asMessageId(nextId++)); },
    copyMessages: async ({ messageIds }) => { calls.push("copy"); return messageIds.map(() => asMessageId(nextId++)); },
    forwardMessage: async () => { throw new Error("unused"); },
    editText: async () => {},
    editCaption: async () => {},
    sendText: async () => asMessageId(nextId++),
    deleteMessages: async () => {
      calls.push("delete");
      if (fail && failDelete) { fail = false; throw { kind: deleteFailureKind, description: deleteFailureKind === "telegram_age_limit" ? "message can't be deleted for everyone" : "old source temporarily unavailable" }; }
    },
    sendAdminMessage: async () => asMessageId(nextId++),
    editAdminMessage: async () => {},
    answerCallbackQuery: async () => {},
  };
  return { gateway, calls };
};

const open = (gateway: TelegramGateway) => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-renewal-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  const queue = createQueueRepository(database);
  const clock = createFakeClock(100_000);
  const renewal = createRenewalService({
    queue,
    policy: createPolicyRepository(database),
    generated: createGeneratedMessageRepository(database),
    gateway,
    queueChannelId: asChatId(-100),
    clock,
    logger: createLogger("error"),
    operationId: (() => { let i = 0; return () => `renew-${++i}`; })(),
  });
  resources.push({ directory, close: database.close });
  return { queue, renewal, database };
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("renewal service", () => {
  test("copies originless queue posts into a new generation and cleans the old source", async () => {
    const fake = gatewayWithDeleteFailure();
    const { queue, renewal, database } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(50), telegramDate: 0, origin: { kind: "absent" } }), 1);
    const result = await renewal.renewNext(36_000);
    expect(result.kind).toBe("renewed");
    expect(queue.findItemById(1)?.sourceGeneration).toBe(1);
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(900)]);
    expect(fake.calls).toEqual(["copy", "delete"]);
    expect(queue.findItemById(1)?.status).toBe("queued");
    expect(queue.findItemById(1)?.maintenanceStatus).toBe("idle");
    expect((database.raw.query("SELECT COUNT(*) AS count FROM orphaned_sources WHERE resolved_at IS NULL").get() as { count: number }).count).toBe(1);
    const orphanCleanup = createOrphanCleanupService({ orphan: createOrphanRepository(database), gateway: fake.gateway, clock: createFakeClock(100_000), logger: createLogger("error") });
    expect((await orphanCleanup.runOnce()).resolved).toBe(1);
    expect((database.raw.query("SELECT COUNT(*) AS count FROM orphaned_sources WHERE resolved_at IS NULL").get() as { count: number }).count).toBe(0);
  });

  test("re-forwards semantic channel origins", async () => {
    const fake = gatewayWithDeleteFailure();
    const { queue, renewal } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(51), telegramDate: 0, origin: { kind: "channel", chatId: asChatId(-300) } }), 1);
    const result = await renewal.renewNext(36_000);
    expect(result.kind).toBe("renewed");
    expect(fake.calls[0]).toBe("forward");
  });

  test("turns an old-generation age-limit failure into a terminal orphan", async () => {
    const fake = gatewayWithDeleteFailure("telegram_age_limit");
    const { queue, renewal, database } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(52), telegramDate: 0, origin: { kind: "absent" } }), 1);
    expect((await renewal.renewNext(36_000)).kind).toBe("renewed");
    const orphan = database.raw.query("SELECT resolved_at, terminal_reason, next_attempt_at FROM orphaned_sources").get() as { resolved_at: number | null; terminal_reason: string | null; next_attempt_at: number | null };
    expect(orphan).toEqual({ resolved_at: null, terminal_reason: "telegram_age_limit", next_attempt_at: null });
  });

  test("backs off permission-denied orphan cleanup for six hours", async () => {
    const fake = gatewayWithDeleteFailure("permission_denied");
    const { queue, renewal, database } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(54), telegramDate: 0, origin: { kind: "absent" } }), 1);
    expect((await renewal.renewNext(36_000)).kind).toBe("renewed");
    const orphan = database.raw.query("SELECT next_attempt_at FROM orphaned_sources").get() as { next_attempt_at: number };
    expect(orphan.next_attempt_at).toBe(100_000 + 6 * 60 * 60_000);
  });

  test("notifies the operator when orphan cleanup loses deletion rights", async () => {
    const fake = gatewayWithDeleteFailure();
    const { queue, database } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(53), telegramDate: 0 }), 1);
    database.raw.query("INSERT INTO orphaned_sources (item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, resolved_at, attempt_count, next_attempt_at, terminal_reason) VALUES (1, 0, -100, 903, 'permission_denied', 1, 1, NULL, 0, 1, NULL)").run();
    const alerts: number[] = [];
    const permissionGateway: TelegramGateway = { ...fake.gateway, deleteMessages: async () => { throw { kind: "permission_denied", description: "rights lost" }; } };
    const orphanCleanup = createOrphanCleanupService({ orphan: createOrphanRepository(database), gateway: permissionGateway, clock: createFakeClock(100_000), logger: createLogger("error"), onPermissionAlert: async () => { alerts.push(1); } });
    expect((await orphanCleanup.runOnce()).attempted).toBe(1);
    expect(alerts).toHaveLength(1);
    expect((database.raw.query("SELECT next_attempt_at FROM orphaned_sources WHERE telegram_message_id = 903").get() as { next_attempt_at: number }).next_attempt_at).toBeGreaterThan(100_000);
  });

  test("retries a durable post-install cleanup phase without republishing", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    const { queue, renewal, database } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(55), telegramDate: 0, origin: { kind: "absent" } }), 1);
    const claimed = queue.claimRenewal("renew-cleanup", 100_000, 64_000)!;
    const guard = { operationId: claimed.operationId, itemId: 1, capturedContentVersion: claimed.capturedContentVersion, capturedSourceGeneration: claimed.capturedSourceGeneration };
    queue.setOperationPhase("renew-cleanup", "replacement_pending", 100_001);
    queue.recordReplacementOutput("renew-cleanup", -100, 905, 0, 100_002);
    queue.markReplacementOutputsRecorded(guard, 100_003);
    const original = queue.getCurrentSnapshotSet(1)[0]!;
    queue.installRenewedGeneration(guard, [{ ...original, messageId: asMessageId(905), ordinal: 0, telegramDate: 100_004 }], 100_004);

    expect(queue.findItemById(1)?.maintenanceStatus).toBe("renewal_cleanup_pending");
    expect((await renewal.cleanupPending(1)).kind).toBe("renewed");
    expect(queue.findItemById(1)?.maintenanceStatus).toBe("idle");
    expect((database.raw.query("SELECT phase FROM operations WHERE id = 'renew-cleanup'").get() as { phase: string }).phase).toBe("completed");
  });
});

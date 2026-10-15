import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createTelegramCooldownRepository } from "../src/db/telegram-cooldown-repository";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createOrphanRepository } from "../src/db/orphan-repository";
import { createOrphanCleanupService } from "../src/services/orphan-cleanup";
import { createRenewalService } from "../src/services/renewal";
import { createTelegramCooldown } from "../src/telegram-cooldown";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId, asUserId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";
import { markQueueItemPrepared } from "./support";

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
    forwardMessage: async () => { calls.push("forward"); return { message_id: nextId++ } as never; },
    copyMessage: async () => { calls.push("copy"); return asMessageId(nextId++); },
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
  const cooldown = createTelegramCooldown({ repository: createTelegramCooldownRepository(database), clock });
  const renewal = createRenewalService({
    queue,
    policy: createPolicyRepository(database),
    generated: createGeneratedMessageRepository(database),
    gateway,
    queueChannelId: asChatId(-100),
    clock,
    logger: createLogger("error"),
    cooldown,
    operationId: (() => { let i = 0; return () => `renew-${++i}`; })(),
  });
  resources.push({ directory, close: database.close });
  return { queue, renewal, database, cooldown, clock };
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("renewal service", () => {
  test("returns nothing when no source is old enough and blocks invalid cleanup requests", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    const { queue, renewal } = open(fake.gateway);
    expect(await renewal.renewNext(36_000)).toEqual({ kind: "nothing_due" });
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(49), telegramDate: 0 }), 1);
    expect(await renewal.cleanupPending(1)).toEqual({ kind: "blocked", itemId: 1, reason: "renewal_cleanup_not_pending" });
    expect(await renewal.cleanupPending(99)).toEqual({ kind: "blocked", itemId: 99, reason: "renewal_cleanup_not_pending" });
  });

  test.each([
    [{ kind: "source_missing", description: "source is gone" }, "deleted_external"],
    [{ kind: "rate_limited", description: "slow down", retryAfterSeconds: 3 }, "retry_scheduled"],
    [{ kind: "transient_network", description: "connection lost" }, "uncertain"],
    [{ kind: "permission_denied", description: "rights lost" }, "blocked"],
  ] as const)("classifies copy failures as %s", async (failure, expectedKind) => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    const gateway: TelegramGateway = {
      ...fake.gateway,
      copyMessage: async () => { throw failure; },
    };
    const { queue, renewal } = open(gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(48), telegramDate: 0, origin: { kind: "absent" } }), 1);
    const result = await renewal.renewNext(36_000);
    expect(result.kind).toBe(expectedKind);
    if (expectedKind === "deleted_external") expect(queue.findItemById(1)?.status).toBe("deleted_external");
    if (expectedKind === "uncertain") expect(queue.findItemById(1)?.maintenanceStatus).toBe("uncertain_renewal");
    if (expectedKind === "blocked") expect(queue.findItemById(1)?.maintenanceStatus).toBe("idle");
    if (expectedKind === "blocked") expect(queue.findItemById(1)?.maintenanceRetryNotBefore).toBe(160_000);
    if (expectedKind === "retry_scheduled") expect(result.kind === "retry_scheduled" && result.retryAt).toBeGreaterThan(100_000);
  });

  test("keeps the complete Telegram flood wait on the item retry deadline", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    const gateway: TelegramGateway = {
      ...fake.gateway,
      copyMessage: async () => { throw { kind: "rate_limited", description: "slow down", retryAfterSeconds: 1_800 }; },
    };
    const { queue, renewal, cooldown } = open(gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(481), telegramDate: 0, origin: { kind: "absent" } }), 1);

    const result = await renewal.renewNext(36_000);

    expect(result.kind).toBe("retry_scheduled");
    expect(result.kind === "retry_scheduled" && result.retryAt).toBe(1_900_000);
    expect(queue.findItemById(1)?.maintenanceRetryNotBefore).toBe(result.kind === "retry_scheduled" ? result.retryAt : undefined);
    expect(cooldown.notBefore()).toBe(1_900_000);
  });

  test("quarantines malformed replacement IDs as an ambiguous result", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    const gateway: TelegramGateway = {
      ...fake.gateway,
      copyMessage: async () => 0 as never,
    };
    const { queue, renewal } = open(gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(47), telegramDate: 0, origin: { kind: "absent" } }), 1);
    expect((await renewal.renewNext(36_000)).kind).toBe("uncertain");
    expect(queue.findItemById(1)?.maintenanceStatus).toBe("uncertain_renewal");
  });

  test("preserves originals and replacement evidence when an album replacement is partial", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", true);
    const { queue, database } = open(fake.gateway);
    const first = snapshotFixture({ messageId: asMessageId(45), mediaGroupId: "renewal-album", telegramDate: 0, origin: { kind: "absent" } });
    const second = snapshotFixture({ messageId: asMessageId(46), mediaGroupId: "renewal-album", telegramDate: 0, origin: { kind: "absent" } });
    const third = snapshotFixture({ messageId: asMessageId(47), mediaGroupId: "renewal-album", telegramDate: 0, origin: { kind: "absent" } });
    const album = queue.observeQueueSnapshot(first, 1).item;
    queue.addAlbumMember(album.id, second, 1);
    queue.addAlbumMember(album.id, third, 1);
    queue.finalizeAlbums(100_000);
    const partialGateway: TelegramGateway = {
      ...fake.gateway,
      copyMessages: async () => { fake.calls.push("copy"); return [asMessageId(910), asMessageId(911)]; },
    };
    const partialRenewal = createRenewalService({
      queue,
      policy: createPolicyRepository(database),
      generated: createGeneratedMessageRepository(database),
      gateway: partialGateway,
      queueChannelId: asChatId(-100),
      clock: createFakeClock(100_000),
      logger: createLogger("error"),
      operationId: () => "renew-partial",
    });
    expect((await partialRenewal.renewNext(36_000)).kind).toBe("uncertain");
    const item = queue.findItemById(1);
    expect(item?.status).toBe("queued");
    expect(item?.maintenanceStatus).toBe("uncertain_renewal");
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(45), asMessageId(46), asMessageId(47)]);
    expect(queue.operationEvidence(1)?.knownReplacementIds).toEqual([asMessageId(910), asMessageId(911)]);
    expect(fake.calls).toEqual(["copy"]);
    expect(item?.lastErrorCode).toBe("partial_replacement");
    expect(item?.lastError).toContain("Expected 3");
    expect(item?.lastError).toContain("received 2");
  });

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

  test("dates a replacement from immediately before the transfer request", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    let advanceClock = (): void => {};
    const gateway: TelegramGateway = {
      ...fake.gateway,
      copyMessages: async (transfer) => {
        const result = await fake.gateway.copyMessages(transfer);
        advanceClock();
        return result;
      },
      copyMessage: async (transfer) => {
        const result = await fake.gateway.copyMessage!(transfer);
        advanceClock();
        return result;
      },
    };
    const { queue, renewal, clock } = open(gateway);
    advanceClock = () => clock.advance(45_000);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(56), telegramDate: 0, origin: { kind: "absent" } }), 1);

    expect((await renewal.renewNext(36_000)).kind).toBe("renewed");

    expect(queue.findItemById(1)?.physicalCreatedAt).toBe(100_000);
    expect(queue.findItemById(1)?.lastRenewedAt).toBe(145_000);
    expect(queue.getCurrentSnapshotSet(1)[0]?.telegramDate).toBe(100_000);
  });

  test("recovers an old complete replacement without restarting its age window", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    const copiedFrom: number[][] = [];
    const gateway: TelegramGateway = {
      ...fake.gateway,
      copyMessages: async (transfer) => {
        copiedFrom.push(transfer.messageIds.map(Number));
        return fake.gateway.copyMessages(transfer);
      },
      copyMessage: async (transfer) => {
        copiedFrom.push([Number(transfer.messageId)]);
        return fake.gateway.copyMessage!(transfer);
      },
    };
    const { queue, renewal, clock } = open(gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(57), telegramDate: 0, origin: { kind: "absent" } }), 1);
    const claimed = queue.claimRenewal("renew-recovery-age", 100_000, 64_000)!;
    const guard = { operationId: claimed.operationId, itemId: 1, capturedContentVersion: claimed.capturedContentVersion, capturedSourceGeneration: claimed.capturedSourceGeneration };
    queue.setOperationPhase(claimed.operationId, "replacement_pending", 100_001);
    queue.recordReplacementOutput(claimed.operationId, -100, 905, 0, 100_002);
    queue.markReplacementOutputsRecorded(guard, 100_003);

    clock.advance(40 * 60 * 60_000);
    expect(queue.recoverExpiredOperations(clock.now())).toEqual([1]);
    expect(queue.findItemById(1)?.physicalCreatedAt).toBe(100_000);
    expect(queue.getCurrentSnapshotSet(1)[0]?.telegramDate).toBe(100_000);
    expect(queue.findItemById(1)?.maintenanceStatus).toBe("renewal_cleanup_pending");

    expect((await renewal.cleanupPending(1)).kind).toBe("renewed");
    expect(fake.calls).toEqual(["delete"]);
    expect(copiedFrom).toEqual([]);
    expect(clock.now() - queue.findItemById(1)!.physicalCreatedAt).toBe(40 * 60 * 60_000);

    expect((await renewal.renewNext(36 * 60 * 60_000)).kind).toBe("renewed");
    expect(copiedFrom).toEqual([[905]]);
    expect(queue.findItemById(1)?.sourceGeneration).toBe(2);
  });

  test("re-forwards semantic channel origins", async () => {
    const fake = gatewayWithDeleteFailure();
    const { queue, renewal } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(51), telegramDate: 0, origin: { kind: "channel", chatId: asChatId(-300) } }), 1);
    const result = await renewal.renewNext(36_000);
    expect(result.kind).toBe("renewed");
    expect(fake.calls[0]).toBe("forward");
  });

  test("renews a prepared user copy with its frozen mode and stable member identity", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    const { queue, renewal, database } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(58), telegramDate: 0, origin: { kind: "user", userId: asUserId(800), displayName: "Alex" } }), 1);
    markQueueItemPrepared(database, 1, "copy", 2);
    const before = queue.getCurrentMembers(1)[0]!;

    expect((await renewal.renewNext(36_000)).kind).toBe("renewed");

    const after = queue.getCurrentMembers(1)[0]!;
    expect(fake.calls).toEqual(["copy", "delete"]);
    expect(after.memberKey).toBe(before.memberKey);
    expect(after.role).toBe("content");
    expect(after.deliveryMode).toBe("copy");
    expect(after.snapshot.nativeOrigin).toEqual({ kind: "absent" });
  });

  test("renews a separate credit as a copied member and tombstones a definitely missing standalone source", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    const deleted: number[][] = [];
    const base = fake.gateway;
    const gateway: TelegramGateway = {
      ...base,
      copyMessage: async (transfer) => {
        fake.calls.push(`copy:${Number(transfer.messageId)}`);
        if (Number(transfer.messageId) === 60) throw { kind: "source_missing", method: "copyMessage", code: 400, description: "message to copy not found" };
        return base.copyMessage!(transfer);
      },
      deleteMessages: async (_chatId, ids) => { deleted.push(ids.map(Number)); },
    };
    const { queue, renewal, database } = open(gateway);
    const { text: _text, ...videoNote } = snapshotFixture({ messageId: asMessageId(60), telegramDate: 0, contentType: "video_note", origin: { kind: "absent" } });
    const item = queue.observeQueueSnapshot(videoNote, 1, "copy", 1).item;
    const credit = snapshotFixture({ messageId: asMessageId(61), ordinal: 1, telegramDate: 0, text: "by Alice", origin: { kind: "absent" } });
    database.raw.query(`INSERT INTO queue_messages (item_id, source_generation, queue_chat_id, telegram_message_id, ordinal, telegram_date, edit_date, snapshot_json, member_key, member_role, member_delivery_mode, album_key)
      VALUES (?, 0, ?, ?, 1, ?, NULL, ?, 'credit:61', 'credit', 'copy', NULL)`).run(item.id, -100, 61, credit.telegramDate, JSON.stringify(credit));
    database.raw.query("UPDATE queue_messages SET member_key = 'content:60', member_role = 'content', member_delivery_mode = 'copy' WHERE item_id = ? AND telegram_message_id = 60").run(item.id);
    database.raw.query(`UPDATE queue_items SET representation_kind = 'prepared', preparation_state = 'ready', delivery_mode = 'copy', attribution_json = ?, nickname_revision_wanted = 1, nickname_revision_applied = 1 WHERE id = ?`)
      .run(JSON.stringify({ ownership: "bot", placement: "separate", memberKey: "credit:61", generatedText: "by Alice", generatedStartUtf16: 0, generatedLengthUtf16: 8, appliedNicknameRevision: 1 }), item.id);

    expect((await renewal.renewNext(36_000)).kind).toBe("renewed");

    expect(queue.findItemById(item.id)?.sourceGeneration).toBe(1);
    expect(queue.findItemById(item.id)?.contentVersion).toBe(2);
    expect(queue.getMessages(item.id, 0).find((member) => member.telegramMessageId === asMessageId(60))?.removedAt).toBeDefined();
    expect(queue.getCurrentMembers(item.id).map((member) => ({ key: member.memberKey, role: member.role, mode: member.deliveryMode }))).toEqual([{ key: "credit:61", role: "credit", mode: "copy" }]);
    expect(deleted).toEqual([[61]]);
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

  test("stops orphan cleanup after a flood wait and persists the full shared deadline", async () => {
    const fake = gatewayWithDeleteFailure("transient_network", false);
    const { queue, database, cooldown, clock } = open(fake.gateway);
    const item = queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(541), telegramDate: 0 }), 1).item;
    const insert = database.raw.query("INSERT INTO orphaned_sources (item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, attempt_count, next_attempt_at) VALUES (?, ?, -100, ?, 'transient', ?, ?, 0, ?)");
    insert.run(item.id, 0, 9501, 1, 1, 100_000);
    insert.run(item.id, 1, 9502, 1, 1, 100_000);
    let calls = 0;
    const gateway: TelegramGateway = {
      ...fake.gateway,
      deleteMessages: async () => { calls += 1; throw { kind: "rate_limited", description: "slow down", retryAfterSeconds: 1_800 }; },
    };
    const cleanup = createOrphanCleanupService({ orphan: createOrphanRepository(database), gateway, clock, logger: createLogger("error"), cooldown });

    const result = await cleanup.runOnce();
    const attempts = database.raw.query("SELECT COUNT(*) AS count FROM orphaned_sources WHERE attempt_count > 0 AND next_attempt_at >= ?").get(1_900_000) as { count: number };

    expect(result.attempted).toBe(1);
    expect(calls).toBe(1);
    expect(attempts.count).toBe(1);
    expect(cooldown.notBefore()).toBe(1_900_000);
    expect((await cleanup.runOnce()).attempted).toBe(0);
    expect(calls).toBe(1);
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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createPolicyRepository, createQueueRepository, createScheduleRepository } from "../src/db/repositories";
import { asChatId, asMessageId, asUserId, type PublicationContract } from "../src/types";
import { snapshotFixture } from "./fixtures";

const resources: Array<{ close(): void; path: string }> = [];

const open = () => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-test-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  resources.push({ close: database.close, path: directory });
  return { database, queue: createQueueRepository(database), policy: createPolicyRepository(database), schedule: createScheduleRepository(database) };
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.path, { recursive: true, force: true });
  }
});

describe("queue repository", () => {
  test("ingestion is idempotent and album finalization preserves FIFO", () => {
    const { queue } = open();
    const first = snapshotFixture({ messageId: asMessageId(10), mediaGroupId: "album" });
    const second = snapshotFixture({ messageId: asMessageId(12), mediaGroupId: "album", ordinal: 2 });
    expect(queue.observeQueueSnapshot(first, 1_000).inserted).toBe(true);
    expect(queue.observeQueueSnapshot(first, 1_000).inserted).toBe(false);
    expect(queue.addAlbumMember(1, second, 1_500).status).toBe("collecting");
    expect(queue.finalizeAlbums(12_000)[0]?.status).toBe("queued");
    expect(queue.getMessages(1).map((message) => message.telegramMessageId)).toEqual([asMessageId(10), asMessageId(12)]);
    expect(queue.getHead()?.logicalSequence).toBe(1);
  });

  test("edits update snapshots and stale rows cannot be claimed", () => {
    const { queue } = open();
    const first = snapshotFixture({ messageId: asMessageId(20) });
    queue.observeQueueSnapshot(first, 1_000);
    const edited = snapshotFixture({ messageId: asMessageId(20), text: "edited", editDate: 2_000 });
    expect(queue.updateSnapshot(-100, 20, edited)?.contentVersion).toBe(2);
    expect(queue.getCurrentSnapshotSet(1)[0]?.text).toBe("edited");
    const claimed = queue.claimPublication("op-1", "publish", 2_000);
    expect(claimed?.item.status).toBe("publishing");
    expect(queue.getHead()?.status).toBe("publishing");
  });

  test("accepts later acknowledged edits with the same edit_date", () => {
    const { queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(24), editDate: 2_000, telegramUpdateId: 8 }), 1_000);
    expect(queue.updateSnapshot(-100, 24, snapshotFixture({ messageId: asMessageId(24), text: "later edit", editDate: 2_000, telegramUpdateId: 9 }))?.contentVersion).toBe(2);
    expect(queue.updateSnapshot(-100, 24, snapshotFixture({ messageId: asMessageId(24), text: "older edit", editDate: 2_000, telegramUpdateId: 8 }))?.contentVersion).toBe(2);
    expect(queue.getCurrentSnapshotSet(1)[0]?.text).toBe("later edit");
  });

  test("edits never replace the semantic origin captured at ingestion", () => {
    const { queue } = open();
    const origin = { kind: "channel" as const, chatId: asChatId(-300), title: "Source" };
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(21), origin }), 1_000);
    queue.updateSnapshot(-100, 21, snapshotFixture({ messageId: asMessageId(21), text: "edited", origin: { kind: "absent" } }));
    expect(queue.findItemById(1)?.origin).toEqual(origin);
    expect(queue.getCurrentSnapshotSet(1)[0]?.origin).toEqual(origin);
  });

  test("startup recovery releases a claimed publication that never began transfer", () => {
    const { database, queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(22) }), 1_000);
    expect(queue.claimPublication("expired-op", "publish", 1_000)?.item.status).toBe("publishing");
    expect(queue.recoverExpiredOperations(302_000)).toEqual([1]);
    expect(queue.findItemById(1)?.status).toBe("queued");
    expect((database.raw.query("SELECT state, phase FROM operations WHERE id = 'expired-op'").get() as { state: string; phase: string })).toEqual({ state: "failed", phase: "failed" });
  });

  test("renewal maintenance never changes the logical publication state", () => {
    const { queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(23), telegramDate: 0 }), 1_000);
    queue.transition(1, "queued", "blocked", 2_000, "manual_block", "needs review");
    const claimed = queue.claimRenewal("renew-preserve", 100_000, 36_000);
    expect(claimed?.item.status).toBe("blocked");
    expect(claimed?.item.maintenanceStatus).toBe("renewing");
    expect(queue.findItemById(1)?.status).toBe("blocked");
  });

  test("startup recovery installs an exact durable renewal output set", () => {
    const { database, queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(26), telegramDate: 0 }), 1_000);
    const claimed = queue.claimRenewal("renew-recover", 100_000, 64_000)!;
    const guard = {
      operationId: claimed.operationId,
      itemId: 1,
      capturedContentVersion: claimed.capturedContentVersion,
      capturedSourceGeneration: claimed.capturedSourceGeneration,
    };
    queue.setOperationPhase("renew-recover", "replacement_pending", 100_000);
    queue.recordReplacementOutput("renew-recover", -100, 902, 0, 100_001);
    queue.markReplacementOutputsRecorded(guard, 100_002);

    expect(queue.recoverExpiredOperations(400_001)).toEqual([1]);
    expect(queue.findItemById(1)?.sourceGeneration).toBe(1);
    expect(queue.findItemById(1)?.maintenanceStatus).toBe("renewal_cleanup_pending");
    expect(queue.findItemById(1)?.physicalCreatedAt).toBe(100_000);
    expect(queue.findItemById(1)?.lastRenewedAt).toBe(400_001);
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(902)]);
    expect(queue.getCurrentSnapshotSet(1)[0]?.telegramDate).toBe(100_000);
    expect((database.raw.query("SELECT phase, state FROM operations WHERE id = 'renew-recover'").get() as { phase: string; state: string })).toEqual({ phase: "generation_installed", state: "cleanup_pending" });
  });

  test("admin adoption installs renewal replacements without changing logical status", () => {
    const { database, queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(27), telegramDate: 0 }), 1_000);
    queue.transition(1, "queued", "blocked", 2_000, "manual_block", "keep blocked");
    const claimed = queue.claimRenewal("renew-adopt", 100_000, 64_000)!;
    queue.setRenewalUncertain(1, claimed.operationId, 100_001, "ambiguous_send_result", "Telegram response was lost");
    queue.adoptUncertainRenewalGeneration({ operationId: claimed.operationId, itemId: 1, capturedContentVersion: claimed.capturedContentVersion, capturedSourceGeneration: claimed.capturedSourceGeneration }, [asMessageId(903)], 100_002);

    expect(queue.findItemById(1)?.status).toBe("blocked");
    expect(queue.findItemById(1)?.maintenanceStatus).toBe("renewal_cleanup_pending");
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(903)]);
    expect((database.raw.query("SELECT kind FROM generated_messages WHERE chat_id = -100 AND message_id = 903").get() as { kind: string }).kind).toBe("renewal");
  });

  test("renewal retry backoff is enforced independently of logical status", () => {
    const { queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(28), telegramDate: 0 }), 1_000);
    const first = queue.claimRenewal("renew-backoff-1", 100_000, 64_000)!;
    queue.setRetry(1, first.operationId, 100_001, 200_000, "rate_limited", "try later");
    expect(queue.claimRenewal("renew-backoff-2", 100_002, 64_000)).toBeUndefined();
    expect(queue.claimRenewal("renew-backoff-3", 200_000, 136_000)?.item.status).toBe("queued");
  });

  test("startup recovery never treats recorded base output as complete publication", () => {
    const { database, queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(24) }), 1_000);
    const claimed = queue.claimPublication("partial-op", "publish", 1_000)!;
    const contract: PublicationContract = {
      capturedLogicalStatus: "queued",
      capturedContentVersion: claimed.capturedContentVersion,
      capturedSourceGeneration: claimed.capturedSourceGeneration,
      sourceIds: [asMessageId(24)],
      policy: { kind: "copy", reason: "direct_queue_post" },
      expectedTransferredMessageCount: 1,
      expectedOutputMessageCount: 1,
      requiresInlineEdit: false,
      requiresSeparateByline: false,
    };
    const guard = { operationId: "partial-op", itemId: 1, capturedContentVersion: 1, capturedSourceGeneration: 0 };
    queue.persistPublicationContract("partial-op", contract, 1_001);
    queue.beginPublicationTransfer(guard, 1_002);
    queue.recordCompleteBaseOutputs(guard, [{ chatId: -200, messageId: 901, ordinal: 0 }], 1_003);
    expect(queue.recoverExpiredOperations(302_000)).toEqual([1]);
    expect(queue.findItemById(1)?.status).toBe("uncertain_publish");
    expect((database.raw.query("SELECT phase FROM operations WHERE id = 'partial-op'").get() as { phase: string }).phase).toBe("uncertain");
  });

  test("does not let one operation claim another operation's Telegram output", () => {
    const { database, queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(30) }), 1_000);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(31) }), 1_001);
    const first = queue.claimPublication("output-owner", "publish", 1_002)!;
    database.raw.query("INSERT INTO operations (id, type, item_id, state, captured_content_version, captured_source_generation, created_at, updated_at) VALUES ('output-rival', 'publish', 2, 'running', 1, 0, 1000, 1000)").run();
    queue.recordOutput(first.operationId, "transferred", -200, 904, 0, 1_003);
    expect(() => queue.recordOutput(first.operationId, "transferred", -200, 904, 0, 1_004)).not.toThrow();
    expect(() => queue.recordOutput("output-rival", "transferred", -200, 904, 0, 1_004)).toThrow(/already belongs/);
  });

  test("rejects invalid numeric Telegram output IDs before SQLite binding", () => {
    const { database, queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(33) }), 1_000);
    const claimed = queue.claimPublication("numeric-output", "publish", 1_001)!;
    const invalid = [
      [Number.NaN, 901, 0],
      [-200, {} as unknown as number, 0],
      [-200, Number.NaN, 0],
      [-200, Number.POSITIVE_INFINITY, 0],
      [-200, 0, 0],
      [-200, -1, 0],
      [-200, 901.5, 0],
      [-200, 902, -1],
    ] as const;

    for (const [chatId, messageId, ordinal] of invalid) {
      expect(() => queue.recordOutput(claimed.operationId, "transferred", chatId, messageId, ordinal, 1_002)).toThrow(/Invalid numeric Telegram output/);
    }
    expect((database.raw.query("SELECT COUNT(*) AS count FROM operation_outputs").get() as { count: number }).count).toBe(0);

    queue.recordOutput(claimed.operationId, "transferred", -200, 903, 0, 1_003);
    expect(() => queue.recordOutput(claimed.operationId, "transferred", -200, 903, 0, 1_004)).not.toThrow();
    expect((database.raw.query("SELECT COUNT(*) AS count FROM operation_outputs").get() as { count: number }).count).toBe(1);
  });

  test("a new boot reconciles a prior live lease immediately", () => {
    const { database } = open();
    const oldQueue = createQueueRepository(database, { bootId: "old-boot" });
    oldQueue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(25) }), 1_000);
    oldQueue.claimPublication("old-op", "publish", 1_000);
    const newQueue = createQueueRepository(database, { bootId: "new-boot" });
    expect(newQueue.recoverExpiredOperations(2_000, "new-boot")).toEqual([1]);
    expect(newQueue.findItemById(1)?.status).toBe("queued");
  });

  test("heartbeats only nonterminal operations owned by the current boot", () => {
    const { database, queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(32) }), 1_000);
    queue.claimPublication("heartbeat-op", "publish", 1_000);
    expect(queue.heartbeatOperations(2_000, "heartbeat-op")).toBe(1);
    const lease = database.raw.query("SELECT lease_expires_at FROM operations WHERE id = 'heartbeat-op'").get() as { lease_expires_at: number };
    expect(lease.lease_expires_at).toBe(302_000);
    expect(queue.heartbeatOperations(3_000, "other-boot")).toBe(0);
  });

  test("quarantines a legacy nonterminal publication attached to a non-publishing item", () => {
    const { database, queue } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(29) }), 1_000);
    database.raw.query("INSERT INTO operations (id, type, item_id, state, captured_content_version, captured_source_generation, lease_owner, lease_expires_at, created_at, updated_at, boot_id, phase) VALUES ('legacy-publish', 'publish', 1, 'running', 1, 0, 'old', 1, 1, 1, 'old-boot', 'legacy')").run();

    expect(queue.recoverExpiredOperations(2, "new-boot")).toEqual([1]);
    expect(queue.findItemById(1)?.status).toBe("needs_review");
    expect((database.raw.query("SELECT state, phase FROM operations WHERE id = 'legacy-publish'").get() as { state: string; phase: string })).toEqual({ state: "uncertain", phase: "uncertain" });
    expect((database.raw.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'legacy_operation_quarantined'").get() as { count: number }).count).toBe(1);
  });
});

describe("policy repository", () => {
  test("uses numeric channel IDs and stable author IDs", () => {
    const { database, policy } = open();
    policy.upsertChannel(-1009, "old_handle", "Title", 1, 1);
    expect(policy.isChannelWhitelisted(-1009)).toBe(true);
    expect(policy.isChannelWhitelisted(-1010)).toBe(false);
    policy.observeAuthor({ kind: "user", userId: asUserId(42), username: "Ada", displayName: "Ada L" }, 1);
    policy.setAlias("@ada", "Analyst", 1, 2);
    expect(policy.aliasForOrigin({ kind: "user", userId: asUserId(42), username: "ada", displayName: "Ada L" })).toBe("Analyst");
    policy.observeAuthor({ kind: "user", userId: asUserId(42), username: "new_ada", displayName: "Ada Lovelace" }, 3);
    expect(policy.aliasForOrigin({ kind: "user", userId: asUserId(42), username: "new_ada", displayName: "Ada Lovelace" })).toBe("Analyst");
    policy.removeAlias(42, 1, 4);
    policy.removeChannel(-1009, 1, 5);
    expect((database.raw.query("SELECT event_type FROM audit_events WHERE actor = '1' ORDER BY id").all() as Array<{ event_type: string }>).map((row) => row.event_type)).toEqual(["whitelist_channel_upserted", "author_alias_set", "author_alias_removed", "whitelist_channel_removed"]);
  });

  test("stores hidden sender nicknames by exact name and invalidates only their bot-owned items", () => {
    const { database, policy, queue } = open();
    const hidden = { kind: "hidden_user" as const, senderUserName: " Alex " };
    policy.observeAuthor(hidden, 10);
    policy.observeAuthor({ kind: "hidden_user", senderUserName: "Alex" }, 11);
    const first = queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(70), origin: hidden }), 12).item;
    database.raw.query("UPDATE queue_items SET preparation_state = 'ready', representation_kind = 'prepared', attribution_json = ? WHERE id = ?").run(JSON.stringify({ ownership: "bot" }), first.id);
    const author = policy.listHiddenAuthors(20, 0).find((entry) => entry.senderName === " Alex ")!;
    policy.setHiddenAlias(author.hiddenAuthorId, "Professor", 1, 20);
    expect(policy.aliasForOrigin(hidden)).toBe("Professor");
    expect(policy.aliasForOrigin({ kind: "hidden_user", senderUserName: "Alex" })).toBeUndefined();
    expect((database.raw.query("SELECT preparation_state, nickname_revision_wanted FROM queue_items WHERE id = ?").get(first.id) as { preparation_state: string; nickname_revision_wanted: number })).toEqual({ preparation_state: "refresh_pending", nickname_revision_wanted: 1 });
    policy.removeHiddenAlias(author.hiddenAuthorId, 1, 30);
    expect(policy.aliasForOrigin(hidden)).toBeUndefined();
    expect((database.raw.query("SELECT nickname_revision_wanted FROM queue_items WHERE id = ?").get(first.id) as { nickname_revision_wanted: number }).nickname_revision_wanted).toBe(2);
  });

  test("paginates more than twenty hidden names without normalizing their keys", () => {
    const { policy } = open();
    for (let index = 0; index < 25; index += 1) policy.observeAuthor({ kind: "hidden_user", senderUserName: `Hidden ${index}` }, index);
    expect(policy.countHiddenAuthors()).toBe(25);
    expect(policy.listHiddenAuthors(20, 0)).toHaveLength(20);
    expect(policy.listHiddenAuthors(20, 20)).toHaveLength(5);
    expect(policy.getHiddenAuthor(policy.listHiddenAuthors(20, 20)[0]!.hiddenAuthorId)?.senderName).toStartWith("Hidden ");
  });
});

describe("schedule repository", () => {
  test("materializes each UTC occurrence once", () => {
    const { schedule } = open();
    schedule.addSlot(60, 1, 1);
    const occurrence = Date.parse("2026-10-05T01:00:00Z");
    expect(schedule.materialize(occurrence)).toBe(true);
    expect(schedule.materialize(occurrence)).toBe(false);
    expect(schedule.run(occurrence)?.status).toBe("pending");
    schedule.markRun(occurrence, "empty", occurrence + 1_000);
    expect(schedule.run(occurrence)?.status).toBe("empty");
    expect(schedule.slots()).toEqual([60]);
  });

  test("enforces the 96-slot limit and strict effective occurrence boundary", () => {
    const { schedule } = open();
    expect(() => schedule.setEnabled(true, 1, 1)).toThrow(/1–96/);
    for (let minute = 0; minute < 96; minute += 1) schedule.addSlot(minute, 1, 1);
    schedule.setEnabled(true, 1, 1);
    expect(schedule.slots()).toHaveLength(96);
    expect(() => schedule.addSlot(96, 1, 2)).toThrow(/96/);
    const paused = open();
    for (let minute = 0; minute < 96; minute += 1) paused.schedule.addSlot(minute, 1, 1);
    expect(() => paused.schedule.addSlot(96, 1, 2)).toThrow(/at most 96/);
    const occurrence = Date.parse("2026-10-05T02:00:00Z");
    const boundary = open();
    boundary.schedule.addSlot(120, 1, occurrence);
    expect(boundary.schedule.materialize(occurrence)).toBe(false);
    boundary.schedule.removeSlot(120, 1, occurrence);
    boundary.schedule.addSlot(120, 1, occurrence - 1);
    expect(boundary.schedule.materialize(occurrence)).toBe(true);
  });
});

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

  test("a new boot reconciles a prior live lease immediately", () => {
    const { database } = open();
    const oldQueue = createQueueRepository(database, { bootId: "old-boot" });
    oldQueue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(25) }), 1_000);
    oldQueue.claimPublication("old-op", "publish", 1_000);
    const newQueue = createQueueRepository(database, { bootId: "new-boot" });
    expect(newQueue.recoverExpiredOperations(2_000, "new-boot")).toEqual([1]);
    expect(newQueue.findItemById(1)?.status).toBe("queued");
  });
});

describe("policy repository", () => {
  test("uses numeric channel IDs and stable author IDs", () => {
    const { policy } = open();
    policy.upsertChannel(-1009, "old_handle", "Title", 1, 1);
    expect(policy.isChannelWhitelisted(-1009)).toBe(true);
    expect(policy.isChannelWhitelisted(-1010)).toBe(false);
    policy.observeAuthor({ kind: "user", userId: asUserId(42), username: "Ada", displayName: "Ada L" }, 1);
    policy.setAlias("@ada", "Analyst", 1, 2);
    expect(policy.aliasForOrigin({ kind: "user", userId: asUserId(42), username: "ada", displayName: "Ada L" })).toBe("Analyst");
    policy.observeAuthor({ kind: "user", userId: asUserId(42), username: "new_ada", displayName: "Ada Lovelace" }, 3);
    expect(policy.aliasForOrigin({ kind: "user", userId: asUserId(42), username: "new_ada", displayName: "Ada Lovelace" })).toBe("Analyst");
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
});

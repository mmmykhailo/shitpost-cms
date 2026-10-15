import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createTelegramCooldownRepository } from "../src/db/telegram-cooldown-repository";
import { createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createPublicationService } from "../src/services/publisher";
import { createTelegramCooldown } from "../src/telegram-cooldown";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId, asUserId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";
import { markQueueItemPrepared } from "./support";

const resources: Array<{ directory: string; close(): void }> = [];

const fakeGateway = (options: { failDelete?: boolean; sourceMissingOnDelete?: boolean; ambiguousEdit?: boolean; ambiguousByline?: boolean; shortTransfer?: boolean; ambiguousTransfer?: boolean; transferFailure?: unknown } = {}) => {
  let nextMessageId = 1000;
  let deleteAttempts = 0;
  const calls: string[] = [];
  const gateway: TelegramGateway = {
    getBotIdentity: async () => ({ id: asUserId(1) }),
    getChat: async (id) => ({ id: Number(id) as never, type: "channel" }),
    getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
    forwardMessages: async ({ messageIds }) => { calls.push("forward"); if (options.transferFailure !== undefined) throw options.transferFailure; if (options.ambiguousTransfer) throw { kind: "ambiguous_send_result", description: "transfer response lost" }; return (options.shortTransfer ? messageIds.slice(0, 1) : messageIds).map(() => asMessageId(nextMessageId++)); },
    copyMessages: async ({ messageIds }) => { calls.push("copy"); if (options.transferFailure !== undefined) throw options.transferFailure; if (options.ambiguousTransfer) throw { kind: "ambiguous_send_result", description: "transfer response lost" }; return (options.shortTransfer ? messageIds.slice(0, 1) : messageIds).map(() => asMessageId(nextMessageId++)); },
    copyMessage: async () => { calls.push("copy"); if (options.transferFailure !== undefined) throw options.transferFailure; if (options.ambiguousTransfer) throw { kind: "ambiguous_send_result", description: "transfer response lost" }; return asMessageId(nextMessageId++); },
    forwardMessage: async () => { calls.push("forward"); if (options.transferFailure !== undefined) throw options.transferFailure; if (options.ambiguousTransfer) throw { kind: "ambiguous_send_result", description: "transfer response lost" }; return { message_id: nextMessageId++, chat: { id: -200, type: "channel", title: "Target" }, date: 10 }; },
    editText: async () => { calls.push("editText"); if (options.ambiguousEdit) throw { kind: "ambiguous_send_result", description: "edit response lost" }; },
    editCaption: async () => { calls.push("editCaption"); },
    sendText: async () => { calls.push("sendText"); if (options.ambiguousByline) throw { kind: "ambiguous_send_result", description: "byline response lost" }; return asMessageId(nextMessageId++); },
    deleteMessages: async (_chatId, messageIds) => {
      calls.push(`delete:${messageIds.join(",")}`);
      deleteAttempts += 1;
      if (options.sourceMissingOnDelete) throw { kind: "source_missing", description: "message to delete not found" };
      if (options.failDelete && deleteAttempts === 1) throw { kind: "transient_network", description: "temporary delete failure" };
    },
    sendAdminMessage: async () => asMessageId(nextMessageId++),
    editAdminMessage: async () => {},
    answerCallbackQuery: async () => {},
  };
  return { gateway, calls };
};

const open = (gateway: TelegramGateway) => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-publisher-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  const queue = createQueueRepository(database);
  const policy = createPolicyRepository(database);
  const clock = createFakeClock(10_000);
  const cooldown = createTelegramCooldown({ repository: createTelegramCooldownRepository(database), clock });
  const service = createPublicationService({ queue, gateway, queueChannelId: asChatId(-100), targetChannelId: asChatId(-200), clock, logger: createLogger("error"), cooldown, operationId: (() => { let i = 0; return () => `op-${++i}`; })() });
  resources.push({ directory, close: database.close });
  return { database, queue, policy, service, clock, cooldown };
};

const ready = (run: ReturnType<typeof open>, itemId = 1, mode: "copy" | "forward" = "copy"): void => markQueueItemPrepared(run.database, itemId, mode, run.clock.now());

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("publication service", () => {
  test("returns empty or blocked without claiming an unsafe head", async () => {
    const fake = fakeGateway();
    const run = open(fake.gateway);
    const { queue, service } = run;
    expect(await service.publishNext()).toEqual({ kind: "empty" });
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(100) }), 1_000);
    queue.transition(1, "queued", "blocked", 2_000, "manual", "review");
    expect(await service.publishNext()).toEqual({ kind: "empty" });

    const maintenanceFake = fakeGateway();
    const maintenanceRun = open(maintenanceFake.gateway);
    maintenanceRun.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(101), telegramDate: 0 }), 1_000);
    ready(maintenanceRun);
    maintenanceRun.queue.claimRenewal("renewing", 10_000, 20_000);
    expect(await maintenanceRun.service.publishNext()).toEqual({ kind: "empty" });
  });

  test("classifies transfer rate limits and missing sources without deleting prematurely", async () => {
    const limited = fakeGateway({ transferFailure: { kind: "rate_limited", description: "slow down", retryAfterSeconds: 2 } });
    const limitedRun = open(limited.gateway);
    limitedRun.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(102) }), 1_000);
    ready(limitedRun);
    expect((await limitedRun.service.publishNext()).kind).toBe("retry_scheduled");
    expect(limitedRun.queue.findItemById(1)?.status).toBe("queued");
    expect(limited.calls).toEqual(["copy"]);

    const missing = fakeGateway({ transferFailure: { kind: "source_missing", description: "message not found" } });
    const missingRun = open(missing.gateway);
    missingRun.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(103) }), 1_000);
    ready(missingRun);
    expect((await missingRun.service.publishNext()).kind).toBe("deleted_external");
    expect(missingRun.queue.findItemById(1)?.status).toBe("deleted_external");
    expect(missing.calls).toEqual(["copy"]);
  });

  test("skips a confirmed missing ready item and publishes the next candidate in the same run", async () => {
    const fake = fakeGateway();
    const run = open(fake.gateway);
    run.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(130) }), 1_000);
    run.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(131) }), 1_001);
    ready(run, 1);
    ready(run, 2);
    const copy = fake.gateway.copyMessage!;
    let attempts = 0;
    fake.gateway.copyMessage = async (request) => {
      attempts += 1;
      if (attempts === 1) throw { kind: "source_missing", method: "copyMessage", description: "message to copy not found" };
      return copy(request);
    };

    const result = await run.service.publishNext();

    expect(result).toMatchObject({ kind: "published", itemId: 2 });
    expect(run.queue.findItemById(1)?.status).toBe("deleted_external");
    expect(run.queue.findItemById(2)?.status).toBe("done");
    expect(attempts).toBe(2);
  });

  test("stops a run after an ambiguous send and leaves later ready items untouched", async () => {
    const fake = fakeGateway({ ambiguousTransfer: true });
    const run = open(fake.gateway);
    run.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(132) }), 1_000);
    run.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(133) }), 1_001);
    ready(run, 1);
    ready(run, 2);

    expect((await run.service.publishNext()).kind).toBe("uncertain");
    expect(run.queue.findItemById(1)?.status).toBe("uncertain_publish");
    expect(run.queue.findItemById(2)?.status).toBe("queued");
  });

  test("sends a prepared album as one grouped transfer and reviews an unmappable missing member", async () => {
    const fake = fakeGateway();
    const run = open(fake.gateway);
    const first = snapshotFixture({ messageId: asMessageId(134), mediaGroupId: "prepared-album", contentType: "photo", ordinal: 0 });
    const second = snapshotFixture({ messageId: asMessageId(135), mediaGroupId: "prepared-album", contentType: "photo", ordinal: 1 });
    const item = run.queue.observeQueueSnapshot(first, 1_000).item;
    run.queue.addAlbumMember(item.id, second, 1_001);
    run.queue.finalizeAlbums(20_000);
    ready(run);
    expect((await run.service.publishNext()).kind).toBe("published");
    expect(fake.calls.filter((call) => call === "copy")).toHaveLength(1);

    const missing = fakeGateway({ transferFailure: { kind: "source_missing", description: "album source unavailable" } });
    const missingRun = open(missing.gateway);
    const missingFirst = snapshotFixture({ messageId: asMessageId(136), mediaGroupId: "missing-album", contentType: "photo", ordinal: 0 });
    const missingSecond = snapshotFixture({ messageId: asMessageId(137), mediaGroupId: "missing-album", contentType: "photo", ordinal: 1 });
    const missingItem = missingRun.queue.observeQueueSnapshot(missingFirst, 1_000).item;
    missingRun.queue.addAlbumMember(missingItem.id, missingSecond, 1_001);
    missingRun.queue.finalizeAlbums(20_000);
    ready(missingRun);
    expect(await missingRun.service.publishNext()).toMatchObject({ kind: "failed", status: "needs_review" });
    expect(missingRun.queue.currentSourceIds(1)).toEqual([asMessageId(136), asMessageId(137)]);
  });

  test("reports shared failures and recovery callbacks without losing publication progress", async () => {
    const limited = fakeGateway({ transferFailure: { kind: "rate_limited", description: "slow down" } });
    const run = open(limited.gateway);
    run.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(138) }), 1_000);
    ready(run);
    const failures: string[] = [];
    const service = createPublicationService({
      queue: run.queue, gateway: limited.gateway, queueChannelId: asChatId(-100), targetChannelId: asChatId(-200), clock: run.clock,
      logger: createLogger("error"), cooldown: run.cooldown,
      onSharedFailure: (error, context) => { failures.push(`${error.kind}:${context?.itemId}`); },
    });
    expect((await service.publishNext()).kind).toBe("retry_scheduled");
    expect(failures).toEqual(["rate_limited:1"]);

    const success = fakeGateway();
    const recovered = open(success.gateway);
    recovered.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(139) }), 1_000);
    ready(recovered);
    let recoveries = 0;
    const withRecovery = createPublicationService({
      queue: recovered.queue, gateway: success.gateway, queueChannelId: asChatId(-100), targetChannelId: asChatId(-200), clock: recovered.clock,
      logger: createLogger("error"), onSharedRecovery: () => { recoveries += 1; },
    });
    expect((await withRecovery.publishNext()).kind).toBe("published");
    expect(recoveries).toBe(1);
  });

  test("returns actionable outcomes for malformed prepared state and stale manual confirmations", async () => {
    const fake = fakeGateway();
    const empty = open(fake.gateway);
    empty.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(140) }), 1_000);
    ready(empty);
    const claimReadyPublication = empty.queue.claimReadyPublication.bind(empty.queue);
    empty.queue.claimReadyPublication = (...args) => {
      const claimed = claimReadyPublication(...args);
      if (claimed) empty.database.raw.query("DELETE FROM queue_messages WHERE item_id = 1 AND source_generation = 0").run();
      return claimed;
    };
    expect(await empty.service.publishNext()).toMatchObject({ kind: "failed", status: "needs_review" });

    const stale = open(fake.gateway);
    stale.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(141) }), 1_000);
    ready(stale);
    expect(await stale.service.publishNext("manual_publish", { itemId: 99, contentVersion: 1, sourceGeneration: 0 })).toMatchObject({ kind: "blocked", status: "stale_candidate" });
    expect(await stale.service.publishNext("manual_publish", { itemId: 1, contentVersion: 99, sourceGeneration: 0 })).toMatchObject({ kind: "blocked", status: "stale_candidate" });
  });

  test("keeps invalid destination content as an edit issue", async () => {
    const fake = fakeGateway({ transferFailure: { kind: "invalid_content_or_entities", description: "entities invalid" } });
    const run = open(fake.gateway);
    run.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(142) }), 1_000);
    ready(run);

    expect(await run.service.publishNext()).toMatchObject({ kind: "failed", status: "needs_edit" });
    expect(run.queue.findItemById(1)?.status).toBe("needs_edit");
  });

  test("persists the full Telegram flood wait for publication retries", async () => {
    const limited = fakeGateway({ transferFailure: { kind: "rate_limited", description: "slow down", retryAfterSeconds: 1_800 } });
    const run = open(limited.gateway);
    run.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(121) }), 1_000);
    ready(run);

    const result = await run.service.publishNext();

    expect(result.kind).toBe("retry_scheduled");
    expect(result.kind === "retry_scheduled" && result.retryAt).toBe(1_810_000);
    expect(run.queue.findItemById(1)?.retryNotBefore).toBe(1_810_000);
    expect(run.cooldown.notBefore()).toBe(1_810_000);
  });

  test("blocks unsupported and mixed-caption plans before transfer", async () => {
    const fake = fakeGateway();
    const unsupported = open(fake.gateway);
    unsupported.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(104), contentType: "service", origin: { kind: "user", userId: asUserId(4), displayName: "User" } }), 1_000);
    expect(await unsupported.service.publishNext()).toEqual({ kind: "empty" });
    expect(fake.calls).toEqual([]);

    const mixed = open(fake.gateway);
    const origin = { kind: "user" as const, userId: asUserId(5), displayName: "User" };
    mixed.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(105), mediaGroupId: "caption-album", contentType: "photo", caption: "first", origin }), 1_000);
    mixed.queue.addAlbumMember(1, snapshotFixture({ messageId: asMessageId(106), mediaGroupId: "caption-album", ordinal: 1, contentType: "photo", caption: "second", origin }), 1_100);
    mixed.queue.finalizeAlbums(20_000);
    expect(await mixed.service.publishNext()).toEqual({ kind: "empty" });
  });

  test("transfers prepared caption and credit content without generating attribution again", async () => {
    const captionFake = fakeGateway();
    const caption = open(captionFake.gateway);
    const captionOrigin = { kind: "user" as const, userId: asUserId(6), displayName: "Caption Author" };
    caption.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(107), contentType: "photo", caption: "photo\n\nby Caption Alias", origin: captionOrigin }), 1_000);
    caption.policy.observeAuthor(captionOrigin, 1);
    caption.policy.setAlias(6, "Caption Alias", 1, 2);
    ready(caption);
    expect((await caption.service.publishNext()).kind).toBe("published");
    expect(captionFake.calls).not.toContain("editCaption");

    const separateFake = fakeGateway();
    const separate = open(separateFake.gateway);
    const separateOrigin = { kind: "user" as const, userId: asUserId(7), displayName: "Sticker Author" };
    separate.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(108), contentType: "text", text: "by Sticker Author", origin: separateOrigin }), 1_000);
    ready(separate);
    expect((await separate.service.publishNext()).kind).toBe("published");
    expect(separateFake.calls).not.toContain("sendText");
    expect(separate.queue.findItemById(1)?.status).toBe("done");
  });

  test("reports missing operations and source-cleanup retry states", async () => {
    const fake = fakeGateway();
    const run = open(fake.gateway);
    const { queue, service } = run;
    expect(await service.cleanupPending(99)).toEqual({ kind: "failed", itemId: 99, status: "published_cleanup_pending", error: "Missing publication operation" });
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(109) }), 1_000);
    ready(run);
    expect(await service.publishNext()).toMatchObject({ kind: "published" });
  });

  test("copies an unlisted source and deletes it only after publication", async () => {
    const fake = fakeGateway();
    const run = open(fake.gateway);
    const { queue, service } = run;
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(1) }), 1_000);
    ready(run);
    const result = await service.publishNext();
    expect(result.kind).toBe("published");
    expect(fake.calls[0]).toBe("copy");
    expect(fake.calls.some((call) => call.startsWith("delete:"))).toBe(true);
    expect(queue.findItemById(1)?.status).toBe("done");
  });

  test("treats a missing source after complete output as successful cleanup", async () => {
    const fake = fakeGateway({ sourceMissingOnDelete: true });
    const run = open(fake.gateway);
    const { database, queue, service } = run;
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(10) }), 1_000);
    ready(run);
    expect((await service.publishNext()).kind).toBe("published");
    expect(queue.findItemById(1)?.status).toBe("done");
    expect((database.raw.query("SELECT event_type FROM audit_events WHERE item_id = 1 ORDER BY id DESC LIMIT 1").get() as { event_type: string }).event_type).toBe("source_already_absent_after_publication");
  });

  test("uses frozen member delivery modes and never adds another user alias", async () => {
    const fake = fakeGateway();
    const run = open(fake.gateway);
    const { queue, policy, service } = run;
    policy.upsertChannel(-300, "source", "Source", 1, 1);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(2), origin: { kind: "channel", chatId: asChatId(-300), title: "Source" } }), 1_000);
    ready(run, 1, "forward");
    expect((await service.publishNext()).kind).toBe("published");
    expect(fake.calls[0]).toBe("forward");

    const user = { kind: "user" as const, userId: 44 as never, displayName: "Original Name" };
    policy.observeAuthor(user, 1);
    policy.setAlias(44, "Alias", 1, 2);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(3), origin: user, text: "hello\n\nby Alias" }), 1_000);
    ready(run, 2, "copy");
    expect((await service.publishNext()).kind).toBe("published");
    expect(fake.calls).not.toContain("editText");
  });

  test("retries cleanup without republishing", async () => {
    const fake = fakeGateway({ failDelete: true });
    const run = open(fake.gateway);
    const { queue, service } = run;
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(4) }), 1_000);
    ready(run);
    expect((await service.publishNext()).kind).toBe("cleanup_pending");
    expect(queue.findItemById(1)?.status).toBe("published_cleanup_pending");
    const copyCount = fake.calls.filter((call) => call === "copy").length;
    expect((await service.cleanupPending(1)).kind).toBe("published");
    expect(fake.calls.filter((call) => call === "copy").length).toBe(copyCount);
    expect(queue.findItemById(1)?.status).toBe("done");
  });

  test("does not publish a raw item whose preparation has not completed", async () => {
    const fake = fakeGateway();
    const { queue, service } = open(fake.gateway);
    const user = { kind: "user" as const, userId: 45 as never, displayName: "A" };
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(5), text: "x".repeat(4095), origin: user }), 1_000);
    const result = await service.publishNext();
    expect(result).toEqual({ kind: "empty" });
    expect(queue.findItemById(1)?.representationKind).toBeUndefined();
    expect(fake.calls.filter((call) => call === "copy")).toHaveLength(0);
  });

  test("does not delete the source after a partial destination result", async () => {
    const fake = fakeGateway({ shortTransfer: true });
    const run = open(fake.gateway);
    const { queue, service } = run;
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(6), mediaGroupId: "album" }), 1_000);
    queue.addAlbumMember(1, snapshotFixture({ messageId: asMessageId(7), mediaGroupId: "album", ordinal: 1 }), 1_100);
    queue.finalizeAlbums(20_000);
    ready(run);
    const result = await service.publishNext();
    expect(result.kind).toBe("uncertain");
    expect(queue.findItemById(1)?.status).toBe("uncertain_publish");
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(6), asMessageId(7)]);
    expect(fake.calls.filter((call) => call.startsWith("delete:")).length).toBe(0);
  });

  test("blocks an ambiguous transfer before source cleanup", async () => {
    const fake = fakeGateway({ ambiguousTransfer: true });
    const run = open(fake.gateway);
    const { queue, service } = run;
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(60) }), 1_000);
    ready(run);
    const result = await service.publishNext();
    expect(result.kind).toBe("uncertain");
    expect(queue.findItemById(1)?.status).toBe("uncertain_publish");
    expect(fake.calls).toEqual(["copy"]);
    expect(fake.calls.filter((call) => call.startsWith("delete:"))).toHaveLength(0);
  });

  test("keeps a short result uncertain and preserves source/output evidence", async () => {
    const fake = fakeGateway({ shortTransfer: true, failDelete: true });
    const run = open(fake.gateway);
    const { queue, service } = run;
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(61), mediaGroupId: "album-uncertain" }), 1_000);
    queue.addAlbumMember(1, snapshotFixture({ messageId: asMessageId(62), mediaGroupId: "album-uncertain", ordinal: 1 }), 1_100);
    queue.finalizeAlbums(20_000);
    ready(run);
    const result = await service.publishNext();
    expect(result.kind).toBe("uncertain");
    expect(queue.findItemById(1)?.status).toBe("uncertain_publish");
    expect(fake.calls.filter((call) => call.startsWith("delete:")).length).toBe(0);
  });

  test("does not regenerate or edit a prepared inline credit during publication", async () => {
    const fake = fakeGateway({ ambiguousEdit: true });
    const run = open(fake.gateway);
    const { queue, service } = run;
    const origin = { kind: "user" as const, userId: 46 as never, displayName: "Author" };
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(8), origin, text: "hello\n\nby Author" }), 1_000);
    ready(run);
    const result = await service.publishNext();
    expect(result.kind).toBe("published");
    expect(queue.findItemById(1)?.status).toBe("done");
    expect(fake.calls.filter((call) => call === "copy")).toHaveLength(1);
    expect(fake.calls.filter((call) => call === "editText")).toHaveLength(0);
  });

  test("does not send a second separate byline during prepared publication", async () => {
    const fake = fakeGateway({ ambiguousByline: true });
    const run = open(fake.gateway);
    const { queue, service } = run;
    const origin = { kind: "user" as const, userId: 47 as never, displayName: "Author" };
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(9), contentType: "text", text: "by Author", origin }), 1_000);
    ready(run);
    const result = await service.publishNext();
    expect(result.kind).toBe("published");
    expect(queue.findItemById(1)?.status).toBe("done");
    expect(fake.calls).not.toContain("sendText");
  });
});

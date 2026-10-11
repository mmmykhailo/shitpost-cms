import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createPublicationService } from "../src/services/publisher";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId, asUserId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";

const resources: Array<{ directory: string; close(): void }> = [];

const fakeGateway = (options: { failDelete?: boolean; ambiguousEdit?: boolean; ambiguousByline?: boolean; shortTransfer?: boolean } = {}) => {
  let nextMessageId = 1000;
  let deleteAttempts = 0;
  const calls: string[] = [];
  const gateway: TelegramGateway = {
    getBotIdentity: async () => ({ id: asUserId(1) }),
    getChat: async (id) => ({ id: Number(id) as never, type: "channel" }),
    getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
    forwardMessages: async ({ messageIds }) => { calls.push("forward"); return (options.shortTransfer ? messageIds.slice(0, 1) : messageIds).map(() => asMessageId(nextMessageId++)); },
    copyMessages: async ({ messageIds }) => { calls.push("copy"); return (options.shortTransfer ? messageIds.slice(0, 1) : messageIds).map(() => asMessageId(nextMessageId++)); },
    forwardMessage: async () => { throw new Error("not used"); },
    editText: async () => { calls.push("editText"); if (options.ambiguousEdit) throw { kind: "ambiguous_send_result", description: "edit response lost" }; },
    editCaption: async () => { calls.push("editCaption"); },
    sendText: async () => { calls.push("sendText"); if (options.ambiguousByline) throw { kind: "ambiguous_send_result", description: "byline response lost" }; return asMessageId(nextMessageId++); },
    deleteMessages: async (_chatId, messageIds) => {
      calls.push(`delete:${messageIds.join(",")}`);
      deleteAttempts += 1;
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
  const service = createPublicationService({ queue, policy, gateway, queueChannelId: asChatId(-100), targetChannelId: asChatId(-200), clock, logger: createLogger("error"), operationId: (() => { let i = 0; return () => `op-${++i}`; })() });
  resources.push({ directory, close: database.close });
  return { queue, policy, service, clock };
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("publication service", () => {
  test("copies an unlisted source and deletes it only after publication", async () => {
    const fake = fakeGateway();
    const { queue, service } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(1) }), 1_000);
    const result = await service.publishNext();
    expect(result.kind).toBe("published");
    expect(fake.calls[0]).toBe("copy");
    expect(fake.calls.some((call) => call.startsWith("delete:"))).toBe(true);
    expect(queue.findItemById(1)?.status).toBe("done");
  });

  test("forwards whitelisted channels and appends a user alias", async () => {
    const fake = fakeGateway();
    const { queue, policy, service } = open(fake.gateway);
    policy.upsertChannel(-300, "source", "Source", 1, 1);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(2), origin: { kind: "channel", chatId: asChatId(-300), title: "Source" } }), 1_000);
    expect((await service.publishNext()).kind).toBe("published");
    expect(fake.calls[0]).toBe("forward");

    const user = { kind: "user" as const, userId: 44 as never, displayName: "Original Name" };
    policy.observeAuthor(user, 1);
    policy.setAlias(44, "Alias", 1, 2);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(3), origin: user }), 1_000);
    expect((await service.publishNext()).kind).toBe("published");
    expect(fake.calls).toContain("editText");
  });

  test("retries cleanup without republishing", async () => {
    const fake = fakeGateway({ failDelete: true });
    const { queue, service } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(4) }), 1_000);
    expect((await service.publishNext()).kind).toBe("cleanup_pending");
    expect(queue.findItemById(1)?.status).toBe("published_cleanup_pending");
    const copyCount = fake.calls.filter((call) => call === "copy").length;
    expect((await service.publishNext()).kind).toBe("published");
    expect(fake.calls.filter((call) => call === "copy").length).toBe(copyCount);
    expect(queue.findItemById(1)?.status).toBe("done");
  });

  test("blocks an overlong user byline before copying", async () => {
    const fake = fakeGateway();
    const { queue, service } = open(fake.gateway);
    const user = { kind: "user" as const, userId: 45 as never, displayName: "A" };
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(5), text: "x".repeat(4095), origin: user }), 1_000);
    const result = await service.publishNext();
    expect(result).toMatchObject({ kind: "failed", status: "needs_edit" });
    expect(queue.findItemById(1)?.status).toBe("needs_edit");
    expect(fake.calls.filter((call) => call === "copy")).toHaveLength(0);
  });

  test("does not delete the source after a partial destination result", async () => {
    const fake = fakeGateway({ shortTransfer: true });
    const { queue, service } = open(fake.gateway);
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(6), mediaGroupId: "album" }), 1_000);
    queue.addAlbumMember(1, snapshotFixture({ messageId: asMessageId(7), mediaGroupId: "album", ordinal: 1 }), 1_100);
    queue.finalizeAlbums(20_000);
    const result = await service.publishNext();
    expect(result).toMatchObject({ kind: "blocked", status: "needs_review" });
    expect(queue.findItemById(1)?.status).toBe("needs_review");
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(6), asMessageId(7)]);
    expect(fake.calls.filter((call) => call.startsWith("delete:")).length).toBe(1);
  });

  test("confirmed cleanup permits retry after an ambiguous inline edit", async () => {
    const fake = fakeGateway({ ambiguousEdit: true });
    const { queue, service } = open(fake.gateway);
    const origin = { kind: "user" as const, userId: 46 as never, displayName: "Author" };
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(8), origin }), 1_000);
    const result = await service.publishNext();
    expect(result.kind).toBe("retry_scheduled");
    expect(queue.findItemById(1)?.status).toBe("queued");
    expect(fake.calls.filter((call) => call === "copy")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.startsWith("delete:")).length).toBe(1);
  });

  test("an ambiguous separate byline remains uncertain even after base cleanup", async () => {
    const fake = fakeGateway({ ambiguousByline: true });
    const { queue, service } = open(fake.gateway);
    const origin = { kind: "user" as const, userId: 47 as never, displayName: "Author" };
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(9), contentType: "sticker", origin }), 1_000);
    const result = await service.publishNext();
    expect(result.kind).toBe("uncertain");
    expect(queue.findItemById(1)?.status).toBe("uncertain_publish");
    expect(fake.calls).toContain("sendText");
    expect(fake.calls.filter((call) => call.startsWith("delete:")).length).toBe(1);
  });
});

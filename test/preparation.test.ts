import { afterEach, describe, expect, test } from "bun:test";
import { createPreparationRepository } from "../src/db/preparation-repository";
import { createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createPreparationService } from "../src/services/preparation";
import type { TelegramGateway } from "../src/telegram";
import { asChatId, asMessageId, asUserId } from "../src/types";
import { createFakeClock } from "../src/clock";
import { createLoggerSpy, createTestDatabase } from "./support";
import { snapshotFixture } from "./fixtures";

const resources: Array<{ close(): void }> = [];
const open = () => {
  const resource = createTestDatabase("preparation-service");
  resources.push(resource);
  const queue = createQueueRepository(resource.database);
  const policy = createPolicyRepository(resource.database);
  const preparation = createPreparationRepository(resource.database, { operationId: (() => { let next = 1; return () => `prep-${next++}`; })() });
  return { ...resource, queue, policy, preparation };
};

afterEach(() => { while (resources.length) resources.pop()!.close(); });

const USER = { kind: "user", userId: asUserId(55), displayName: "Alice Example" } as const;
const NOW = Date.parse("2026-10-15T08:00:00Z");

const makeGateway = () => {
  let nextId = 500;
  const edits: Array<{ text?: string; caption?: string; messageId: number }> = [];
  const copied: number[] = [];
  const deleted: number[][] = [];
  const sentText: string[] = [];
  const gateway = {
    copyMessage: async ({ messageId }: { messageId: number }) => { copied.push(messageId); return asMessageId(nextId++); },
    copyMessages: async ({ messageIds }: { messageIds: readonly number[] }) => messageIds.map(() => asMessageId(nextId++)),
    forwardMessages: async ({ messageIds }: { messageIds: readonly number[] }) => messageIds.map(() => asMessageId(nextId++)),
    forwardMessage: async ({ messageId }: { messageId: number }) => ({ message_id: nextId++, chat: { id: -100, type: "channel", title: "Queue" }, date: NOW / 1000, text: String(messageId) }),
    editText: async ({ messageId, text }: { messageId: number; text: string }) => { edits.push({ messageId, text }); },
    editCaption: async ({ messageId, caption }: { messageId: number; caption: string }) => { edits.push({ messageId, caption }); },
    sendText: async ({ text }: { text: string }) => { sentText.push(text); return asMessageId(nextId++); },
    deleteMessages: async (_chatId: number, ids: readonly number[]) => { deleted.push([...ids]); },
  };
  return { gateway: gateway as unknown as TelegramGateway, copied, edits, deleted, sentText };
};

const serviceFor = (h: ReturnType<typeof open>, gateway: TelegramGateway) => createPreparationService({
  queue: h.queue,
  preparation: h.preparation,
  policy: h.policy,
  gateway,
  queueChannelId: asChatId(-100),
  bootId: "boot-test",
  clock: createFakeClock(NOW),
  logger: createLoggerSpy().logger,
});

describe("preparation service", () => {
  test("copies an identifiable-user post once, adds its visible credit in the queue, and then removes the raw source", async () => {
    const h = open();
    const snapshot = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(100), origin: USER, text: "hello" });
    h.policy.observeAuthor(USER, NOW);
    h.queue.observeQueueSnapshot(snapshot, NOW, "copy", NOW);
    const fake = makeGateway();

    const result = await serviceFor(h, fake.gateway).prepareNext();

    expect(result.kind).toBe("prepared");
    expect(fake.copied).toEqual([100]);
    expect(fake.edits).toEqual([{ messageId: 500, text: "hello\n\nby Alice Example" }]);
    expect(fake.deleted).toEqual([[100]]);
    const [prepared] = h.queue.getCurrentMembers(1);
    expect(prepared).toMatchObject({ messageId: asMessageId(500), deliveryMode: "copy", role: "content", snapshot: { text: "hello\n\nby Alice Example", origin: USER, nativeOrigin: { kind: "absent" } } });
  });

  test("uses an exact hidden-sender alias and refreshes only the bot-owned credit", async () => {
    const h = open();
    const hiddenOrigin = { kind: "hidden_user", senderUserName: "Alex" } as const;
    const source = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(110), origin: hiddenOrigin, text: "post" });
    h.policy.observeAuthor(hiddenOrigin, NOW);
    h.queue.observeQueueSnapshot(source, NOW, "copy", NOW);
    const hidden = h.policy.listHiddenAuthors()[0]!;
    h.policy.setHiddenAlias(hidden.hiddenAuthorId, "Professor", 1, NOW + 1);
    const fake = makeGateway();
    const service = serviceFor(h, fake.gateway);

    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(fake.edits[0]?.text).toBe("post\n\nby Professor");
    h.policy.setHiddenAlias(hidden.hiddenAuthorId, "Dr. Alex", 1, NOW + 2);

    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(fake.edits[1]?.text).toBe("post\n\nby Dr. Alex");
    expect(h.queue.getCurrentMembers(1)[0]?.snapshot.origin).toEqual(hiddenOrigin);
  });

  test("stores captionless media credits as a separate logical member outside the media group", async () => {
    const h = open();
    const photo = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(120), contentType: "sticker", origin: USER });
    delete photo.text;
    h.policy.observeAuthor(USER, NOW);
    h.queue.observeQueueSnapshot(photo, NOW, "copy", NOW);
    const fake = makeGateway();

    expect((await serviceFor(h, fake.gateway).prepareNext()).kind).toBe("prepared");
    const members = h.queue.getCurrentMembers(1);
    expect(members.map((member) => ({ role: member.role, deliveryMode: member.deliveryMode, text: member.snapshot.text, albumKey: member.albumKey }))).toEqual([
      { role: "content", deliveryMode: "copy", text: undefined, albumKey: undefined },
      { role: "credit", deliveryMode: "copy", text: "by Alice Example", albumKey: undefined },
    ]);
    expect(fake.sentText).toEqual(["by Alice Example"]);
  });

  test("whitelisted channel forwards are adopted in place without a destructive re-copy", async () => {
    const h = open();
    const origin = { kind: "channel", chatId: asChatId(-200), title: "Source" } as const;
    const snapshot = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(130), origin, nativeOrigin: origin });
    h.policy.upsertChannel(asChatId(-200), undefined, "Source", 1, NOW);
    h.queue.observeQueueSnapshot(snapshot, NOW, "forward", NOW);
    const fake = makeGateway();

    expect((await serviceFor(h, fake.gateway).prepareNext()).kind).toBe("prepared");
    expect(fake.copied).toEqual([]);
    expect(fake.deleted).toEqual([]);
    expect(h.queue.getCurrentMembers(1)[0]).toMatchObject({ messageId: asMessageId(130), deliveryMode: "forward", snapshot: { nativeOrigin: origin } });
  });
});

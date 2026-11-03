import { test, expect } from "bun:test";
import { createDatabase } from "../src/db/database";
import { createGeneratedMessageRepository, createQueueRepository, createPolicyRepository } from "../src/db/repositories";
import { createPreparationRepository } from "../src/db/preparation-repository";
import { createPreparationRequestRepository } from "../src/db/preparation-request-repository";
import { createPreparationService } from "../src/services/preparation";
import { createPublicationService } from "../src/services/publisher";
import { createRenewalService } from "../src/services/renewal";
import { createFakeClock } from "../src/clock";
import { asChatId, asMessageId, asUserId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";
import { createLoggerSpy, createTestDatabase } from "./support";

test("priority, signature credit, renewal, restart, and nickname refresh preserve one logical post", async () => {
  const resource = createTestDatabase();
  let database = resource.database;
  const clock = createFakeClock(1_000_000);
  const logger = createLoggerSpy().logger;
  let nextId = 500;
  const copies: Array<{ target: number; source: number }> = [];
  const gateway = {
    copyMessage: async ({ messageId, toChatId }: { messageId: number; toChatId: number }) => { copies.push({ source: messageId, target: toChatId }); return asMessageId(nextId++); },
    copyMessages: async ({ messageIds }: { messageIds: number[] }) => messageIds.map(() => asMessageId(nextId++)),
    editText: async ({ messageId }: { messageId: number }) => ({ messageId: asMessageId(messageId), editDate: clock.now() }),
    editCaption: async ({ messageId }: { messageId: number }) => ({ messageId: asMessageId(messageId), editDate: clock.now() }),
    deleteMessages: async () => {},
  } as unknown as TelegramGateway;
  const setup = () => {
    const queue = createQueueRepository(database), policy = createPolicyRepository(database);
    const preparation = createPreparationRepository(database);
    const service = createPreparationService({ queue, policy, preparation, requestEvidence: createPreparationRequestRepository(database), gateway, queueChannelId: asChatId(-100), bootId: "lifecycle", clock, logger });
    return { queue, policy, service };
  };
  try {
    let h = setup();
    h.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(1), telegramDate: clock.now(), origin: { kind: "absent" } }), clock.now(), "copy", clock.now());
    h.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(2), telegramDate: clock.now(), text: "second post", origin: { kind: "absent" }, queueAuthor: { kind: "signature", exactName: "Queue author" } }), clock.now(), "copy", clock.now());
    h.policy.observeAuthor({ kind: "signature", exactName: "Queue author", queueChatId: asChatId(-100) }, clock.now());
    const signature = h.policy.listSignatureAuthors(-100)[0]!;
    h.policy.setSignatureAlias(signature.id, "First alias", 42, clock.now());
    expect((await h.service.prepareNext()).kind).toBe("prepared");
    expect((await h.service.prepareNext()).kind).toBe("prepared");
    const item = h.queue.findItemById(2)!;
    expect(h.queue.moveToFirst(2, clock.now(), item.logicalSequence, 42)).toBe("moved");
    const position = h.queue.findItemById(2)!.logicalSequence;
    clock.advance(37 * 3_600_000);
    // Renew both due sources, irrespective of their physical age/order.
    const renewal = createRenewalService({ queue: h.queue, policy: h.policy, generated: createGeneratedMessageRepository(database), gateway, queueChannelId: asChatId(-100), clock, logger });
    expect((await renewal.renewNext(36 * 3_600_000)).kind).toBe("renewed");
    expect((await renewal.renewNext(36 * 3_600_000)).kind).toBe("renewed");
    expect(h.queue.getCurrentSnapshotSet(2)[0]?.text).toBe("second post\n\nby First alias");
    expect(h.queue.findItemById(2)).toMatchObject({ id: item.id, logicalSequence: position, enqueuedAt: item.enqueuedAt, creditIdentity: item.creditIdentity });
    database.close();
    database = createDatabase(resource.path);
    h = setup();
    h.policy.setSignatureAlias(signature.id, "After restart", 42, clock.now());
    expect(h.queue.findItemById(2)?.preparationState).toBe("refresh_pending");
    expect(h.queue.peekNextReady(clock.now())?.id).toBe(1);
    expect((await h.service.prepareNext()).kind).toBe("prepared");
    expect(h.queue.getCurrentSnapshotSet(2)[0]?.text).toBe("second post\n\nby After restart");
    expect(h.queue.peekNextReady(clock.now())?.id).toBe(2);
    expect(h.queue.findItemById(2)?.enqueuedAt).toBe(item.enqueuedAt);
    const sourceId = h.queue.currentSourceIds(2)[0];
    const publisher = createPublicationService({ queue: h.queue, gateway, queueChannelId: asChatId(-100), targetChannelId: asChatId(-200), clock, logger });
    expect(await publisher.publishNext()).toMatchObject({ kind: "published", itemId: 2 });
    expect(h.queue.findItemById(2)?.status).toBe("done");
    expect(copies.at(-1)?.source).toBe(sourceId);
  } finally { database.close(); resource.close(); }
});

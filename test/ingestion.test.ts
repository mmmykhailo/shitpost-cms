import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createPendingUpdateRepository } from "../src/db/pending-update-repository";
import { createIngestionService } from "../src/services/ingestion";
import { createRenewalService } from "../src/services/renewal";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";

const open = () => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-ingestion-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  let currentTime = 10_000;
  const clock = { now: () => currentTime, sleep: async (milliseconds: number) => { currentTime += milliseconds; } };
  const queue = createQueueRepository(database);
  const policy = createPolicyRepository(database);
  const generated = createGeneratedMessageRepository(database);
  const pending = createPendingUpdateRepository(database);
  const service = createIngestionService({
    queueChannelId: asChatId(-100),
    queue,
    policy,
    generated,
    pending,
    logger: createLogger("error"),
    now: clock.now,
  });
  return { directory, database, service, pending, queue, policy, generated, clock, advance: (milliseconds: number) => { currentTime += milliseconds; } };
};

let current: ReturnType<typeof open> | undefined;
afterEach(() => {
  current?.database.close();
  if (current) rmSync(current.directory, { recursive: true, force: true });
  current = undefined;
});

describe("ingestion service", () => {
  test("groups an album, suppresses generated replacements, and ignores other chats", () => {
    current = open();
    const first = snapshotFixture({ messageId: asMessageId(30), mediaGroupId: "g" });
    const second = snapshotFixture({ messageId: asMessageId(31), mediaGroupId: "g" });
    expect(current.service.observe(first, 10_000)).toMatchObject({ accepted: true, itemId: 1 });
    expect(current.service.observe(second, 10_500)).toMatchObject({ accepted: true, itemId: 1 });
    current.advance(3_000);
    expect(current.service.finalizeAlbums()).toEqual([1]);
    current.service.observe({ ...first, messageId: asMessageId(99) }, 11_000);
    expect(current.service.observe(first, 11_000).ignoredReason).toBe("duplicate");
  });

  test("uses the persistent suppression record for renewal updates", () => {
    current = open();
    const generated = createGeneratedMessageRepository(current.database);
    generated.register(-100, [500], "renew-1", "renewal", 10_000);
    const result = current.service.observe(snapshotFixture({ messageId: asMessageId(500) }), 10_001);
    expect(result).toEqual({ accepted: false, ignoredReason: "generated_message" });
  });

  test("finalizes channel updates from durable pending rows after the ordering window", () => {
    current = open();
    const snapshot = snapshotFixture({ messageId: asMessageId(501) });
    current.pending.upsert(snapshot, 10_000);
    expect(current.service.finalizePendingUpdates()).toEqual([]);
    current.advance(2_000);
    expect(current.service.finalizePendingUpdates()).toEqual([1]);
    expect(current.service.finalizePendingUpdates()).toEqual([]);
    expect(current.pending.find(-100, 501)?.state).toBe("ingested");
  });

  test("freezes a whitelisted channel decision at first receipt across the pending delay", () => {
    current = open();
    current.policy.upsertChannel(-55, "source", "Source", 1, 9_000);
    const message = {
      message_id: 550,
      date: 9,
      chat: { id: -100, type: "channel", title: "Queue" },
      forward_origin: { type: "channel", chat: { id: -55, type: "channel", title: "Source" }, date: 9 },
      text: "hello",
    } as never;
    current.service.handleChannelPost(message, 41);
    current.policy.removeChannel(-55, 1, 10_001);
    current.advance(500);
    current.service.handleChannelPost(message, 42);
    expect(current.pending.find(-100, 550)).toMatchObject({ capturedDeliveryMode: "forward", policyCapturedAt: 10_000, telegramUpdateId: 42, updateKind: "post" });
    current.advance(2_000);
    expect(current.service.finalizePendingUpdates()).toEqual([1]);
    expect((current.database.raw.query("SELECT delivery_mode, policy_captured_at FROM queue_items WHERE id = 1").get() as { delivery_mode: string; policy_captured_at: number })).toEqual({ delivery_mode: "forward", policy_captured_at: 10_000 });
  });

  test("does not treat an edit with no known submission as a new queue item", () => {
    current = open();
    const edited = { message_id: 551, date: 9, chat: { id: -100, type: "channel", title: "Queue" }, text: "edit only" } as never;
    current.service.handleEditedChannelPost(edited, 55);
    expect(current.service.finalizePendingUpdates()).toEqual([]);
    expect(current.queue.findBySource(-100, 551)).toBeUndefined();
    expect(current.pending.find(-100, 551)).toMatchObject({ state: "discarded", updateKind: "edit", telegramUpdateId: 55 });
  });

  test("quarantines an update while renewal output is unresolved, then suppresses it when registered", () => {
    current = open();
    current.service.observe(snapshotFixture({ messageId: asMessageId(502), telegramDate: 0 }), 1);
    const queue = createQueueRepository(current.database);
    queue.claimRenewal("renew-candidate", 10_000, 20_000);
    current.pending.upsert(snapshotFixture({ messageId: asMessageId(902) }), 10_000);
    current.advance(2_000);
    expect(current.service.finalizePendingUpdates()).toEqual([]);
    expect(current.pending.find(-100, 902)?.state).toBe("quarantined_renewal_candidate");
    const generated = createGeneratedMessageRepository(current.database);
    generated.register(-100, [902], "renew-candidate", "renewal", 12_000);
    expect(current.service.finalizePendingUpdates()).toEqual([]);
    expect(current.pending.find(-100, 902)?.state).toBe("consumed_generated");
    expect(queue.findBySource(-100, 902)).toBeUndefined();
  });

  test("suppresses a replacement update finalized before the send promise resolves", async () => {
    current = open();
    const earlier = current.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(700), telegramDate: 0 }), 1).item;
    const later = current.queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(701), telegramDate: 0 }), 2).item;
    const uncertain = current.queue.claimRenewal("earlier-uncertain-renewal", 10_000, 10_000)!;
    current.queue.setRenewalUncertain(earlier.id, uncertain.operationId, 10_000, "transient_network", "response lost");
    current.queue.recordReplacementOutput(uncertain.operationId, -100, 801, 0, 10_000);
    current.advance(1);

    const deleted: number[] = [];
    const gateway: TelegramGateway = {
      getBotIdentity: async () => ({ id: 1 as never }),
      getChat: async () => ({ id: asChatId(-100), type: "channel" }),
      getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
      forwardMessages: async () => [],
      copyMessages: async () => {
        const replacementId = asMessageId(902);
        current!.pending.upsert(snapshotFixture({ chatId: asChatId(-100), messageId: replacementId, telegramDate: current!.clock.now() }), current!.clock.now());
        current!.advance(2_000);
        expect(current!.service.finalizePendingUpdates()).toEqual([]);
        expect(current!.pending.find(-100, replacementId)).toMatchObject({ state: "quarantined_renewal_candidate", candidateOperationId: "earlier-uncertain-renewal" });
        return [replacementId];
      },
      forwardMessage: async () => { throw new Error("unused"); },
      editText: async () => {},
      editCaption: async () => {},
      sendText: async () => asMessageId(1),
      deleteMessages: async (_chatId, ids) => { deleted.push(...ids.map(Number)); },
      sendAdminMessage: async () => asMessageId(1),
      editAdminMessage: async () => {},
      answerCallbackQuery: async () => {},
    };
    const renewal = createRenewalService({
      queue: current.queue,
      policy: current.policy,
      generated: current.generated,
      gateway,
      queueChannelId: asChatId(-100),
      clock: current.clock,
      logger: createLogger("error"),
      operationId: () => "later-successful-renewal",
    });

    expect((await renewal.renewNext(0)).kind).toBe("renewed");
    expect(current.queue.findItemById(earlier.id)?.sourceGeneration).toBe(0);
    expect(current.queue.currentSourceIds(earlier.id)).toEqual([asMessageId(700)]);
    expect(current.queue.operationEvidence(earlier.id)?.knownReplacementIds).toEqual([asMessageId(801)]);
    expect(current.queue.currentSourceIds(later.id)).toEqual([asMessageId(902)]);
    expect(current.queue.operationEvidence(later.id)?.knownReplacementIds).toEqual([asMessageId(902)]);
    expect(deleted).toEqual([701]);

    expect(current.service.finalizePendingUpdates()).toEqual([]);
    expect(current.pending.find(-100, 902)).toMatchObject({ state: "consumed_generated", candidateOperationId: "later-successful-renewal" });
    expect(current.queue.listActive(10).map((item) => item.id)).toEqual([earlier.id, later.id]);
  });
});

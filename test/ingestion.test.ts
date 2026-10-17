import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createGeneratedEventRepository } from "../src/db/generated-event-repository";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { snapshotFromMessage } from "../src/domain/message";
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
  const events = createGeneratedEventRepository(database);
  const pending = createPendingUpdateRepository(database);
  const service = createIngestionService({
    queueChannelId: asChatId(-100),
    queue,
    policy,
    generated,
    events,
    pending,
    logger: createLogger("error"),
    now: clock.now,
  });
  return { directory, database, service, pending, queue, policy, generated, events, clock, advance: (milliseconds: number) => { currentTime += milliseconds; } };
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
    expect(current.service.observe(snapshotFixture({ messageId: asMessageId(32), ordinal: 2, mediaGroupId: "g" }), 11_001)).toMatchObject({ accepted: true, itemId: 1 });
  });

  test("handles generated posts and synchronous queue edits when no pending-update store is configured", () => {
    current = open();
    const direct = createIngestionService({ queueChannelId: asChatId(-100), queue: current.queue, policy: current.policy, generated: current.generated, events: current.events, logger: createLogger("error"), now: current.clock.now });
    const generated = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(799) });
    current.events.expect({ family: "preparation", operationId: "generated-799", chatId: -100, messageId: 799, kind: "post", now: current.clock.now() });
    expect(direct.observe(generated, current.clock.now())).toEqual({ accepted: false, ignoredReason: "generated_message" });

    expect(direct.handleChannelPost({ message_id: 800, date: 10, chat: { id: -999, type: "channel" }, text: "wrong chat" } as never)).toMatchObject({ accepted: false, ignoredReason: "wrong_chat" });
    expect(direct.handleChannelPost({ message_id: 800, date: 10, chat: { id: -100, type: "channel" }, text: "direct post" } as never)).toMatchObject({ accepted: true, itemId: 1 });
    expect(direct.handleEditedChannelPost({ message_id: 999, date: 10, chat: { id: -100, type: "channel" }, text: "unknown edit" } as never)).toMatchObject({ accepted: false, ignoredReason: "duplicate" });
    expect(direct.handleEditedChannelPost({ message_id: 800, date: 10, edit_date: 11, chat: { id: -100, type: "channel" }, text: "admin edit" } as never)).toMatchObject({ accepted: true, itemId: 1 });
    expect(current.queue.findItemById(1)).toMatchObject({ editorialFreezeReason: "admin_edit" });
    expect(direct.handleEditedChannelPost({ message_id: 800, date: 10, edit_date: 11, chat: { id: -100, type: "channel" }, text: "stale admin edit" } as never, 0)).toMatchObject({ accepted: false, ignoredReason: "duplicate" });
    expect(direct.finalizePendingUpdates()).toEqual([]);
  });

  test("suppresses provisional and accepted generated edits after matching their request receipts", () => {
    current = open();
    const inFlight = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(801), text: "generated edit", editDate: 11, telegramUpdateId: 3 });
    const inFlightEvent = current.events.expect({ family: "preparation", operationId: "preparation-801", chatId: -100, messageId: 801, kind: "edit", ...(inFlight.contentFingerprint === undefined ? {} : { fingerprint: inFlight.contentFingerprint }), snapshot: inFlight, now: 10_000 });
    current.events.markEditRequestStarted(inFlightEvent, 10_000);
    expect(current.service.handleEditedChannelPost({ message_id: 801, date: 10, edit_date: 11, chat: { id: -100, type: "channel" }, text: "generated edit" } as never, 3)).toMatchObject({ accepted: false, ignoredReason: "pending_update" });

    const acceptedMessage = { message_id: 802, date: 10, edit_date: 12, chat: { id: -100, type: "channel" }, text: "accepted generated edit" } as never;
    const accepted = snapshotFromMessage(acceptedMessage, 0, 4);
    const acceptedEvent = current.events.expect({ family: "preparation", operationId: "preparation-802", chatId: -100, messageId: 802, kind: "edit", ...(accepted.contentFingerprint === undefined ? {} : { fingerprint: accepted.contentFingerprint }), snapshot: accepted, now: 10_000 });
    current.events.markEditRequestStarted(acceptedEvent, 10_000);
    expect(current.events.markEditRequestAccepted(acceptedEvent, 10_001, accepted.editDate)).toEqual({ kind: "none" });
    const direct = createIngestionService({ queueChannelId: asChatId(-100), queue: current.queue, policy: current.policy, generated: current.generated, events: current.events, logger: createLogger("error"), now: current.clock.now });
    expect(direct.handleEditedChannelPost(acceptedMessage, 4)).toMatchObject({ accepted: false, ignoredReason: "generated_message" });
  });

  test("uses the persistent suppression record for renewal updates", () => {
    current = open();
    const generated = createGeneratedMessageRepository(current.database);
    generated.register(-100, [500], "renew-1", "renewal", 10_000);
    const result = current.service.observe(snapshotFixture({ messageId: asMessageId(500) }), 10_001);
    expect(result).toEqual({ accepted: false, ignoredReason: "generated_message" });
  });

  test("accepts an edit to a known current source immediately while retaining its pending receipt", () => {
    current = open();
    current.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(510), text: "before" }), 10_000);

    expect(current.service.handleEditedChannelPost({ message_id: 510, date: 10, edit_date: 11, chat: { id: -100, type: "channel" }, text: "edited now" } as never, 12)).toMatchObject({ accepted: true, itemId: 1 });
    expect(current.queue.findItemById(1)).toMatchObject({ editorialFreezeReason: "admin_edit", editorialFreezeUpdateId: 12 });
    expect(current.pending.find(-100, 510)).toMatchObject({ updateKind: "edit", state: "ingested", telegramUpdateId: 12 });
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

  test("preserves an unmatched edit coalesced with a post row and freezes the adopted submission", () => {
    current = open();
    const post = snapshotFixture({ messageId: asMessageId(552), text: "original" });
    const edited = { ...post, text: "admin version", editDate: 10_501, telegramUpdateId: 2 };
    current.pending.upsert(post, 10_000, 12_000, { updateKind: "post", telegramUpdateId: 1, deliveryMode: "copy", policyCapturedAt: 10_000 });
    const coalesced = current.pending.upsert(edited, 10_500, 12_000, { updateKind: "edit", telegramUpdateId: 2 });

    expect(coalesced).toMatchObject({ updateKind: "post", unmatchedEditAt: 10_500, unmatchedEditUpdateId: 2, snapshot: { text: "admin version" } });
    current.advance(2_001);

    expect(current.service.finalizePendingUpdates()).toEqual([1]);
    expect(current.pending.find(-100, 552)?.state).toBe("ingested");
    expect(current.queue.findItemById(1)).toMatchObject({
      editorialFreezeReason: "admin_edit",
      editorialFreezeMessageId: asMessageId(552),
      editorialFreezeUpdateId: 2,
    });
    expect(current.queue.getCurrentMembers(1)[0]?.snapshot.text).toBe("admin version");
  });

  test("does not let an older pending replay replace the latest edit snapshot or freeze provenance", () => {
    current = open();
    const post = snapshotFixture({ messageId: asMessageId(553), text: "original" });
    current.pending.upsert(post, 10_000, 12_000, { updateKind: "post", telegramUpdateId: 1 });
    const newest = { ...post, text: "newest", editDate: 10_800, telegramUpdateId: 8 };
    current.pending.upsert(newest, 10_800, 12_800, { updateKind: "edit", telegramUpdateId: 8 });
    const older = { ...post, text: "older replay", editDate: 10_700, telegramUpdateId: 7 };

    expect(current.pending.upsert(older, 10_900, 12_900, { updateKind: "edit", telegramUpdateId: 7 })).toMatchObject({
      updateKind: "post",
      unmatchedEditAt: 10_800,
      unmatchedEditUpdateId: 8,
      snapshot: { text: "newest", telegramUpdateId: 8 },
    });
  });

  test("reconciles a bot edit echo that arrives before the Telegram edit response", () => {
    current = open();
    const id = asMessageId(554);
    current.queue.observeQueueSnapshot(snapshotFixture({ messageId: id, text: "before" }), 10_000);
    const editedMessage = { message_id: Number(id), date: 10, edit_date: 11, chat: { id: -100, type: "channel" }, text: "bot version" } as never;
    const incoming = snapshotFromMessage(editedMessage, 0, 11);
    const eventId = current.events.expect({ family: "preparation", operationId: "prep-echo", chatId: -100, messageId: Number(id), kind: "edit", fingerprint: incoming.contentFingerprint!, snapshot: incoming, now: 10_000 });
    current.events.markEditRequestStarted(eventId, 10_000, 10);

    expect(current.service.handleEditedChannelPost(editedMessage, 11)).toEqual({ accepted: false, ignoredReason: "pending_update" });
    expect(current.queue.findItemById(1)?.editorialFrozenAt).toBeUndefined();
    expect(current.queue.getCurrentSnapshotSet(1)[0]?.text).toBe("before");
    expect(current.events.markEditRequestAccepted(eventId, 10_001, incoming.editDate)).toEqual({ kind: "generated" });
    expect(current.queue.findItemById(1)?.editorialFrozenAt).toBeUndefined();
    expect(current.database.raw.query("SELECT state, request_state FROM queue_generated_events WHERE id = ?").get(eventId)).toEqual({ state: "matched", request_state: "accepted" });
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
      copyMessage: async () => {
        const replacementId = asMessageId(902);
        current!.pending.upsert(snapshotFixture({ chatId: asChatId(-100), messageId: replacementId, telegramDate: current!.clock.now() }), current!.clock.now());
        current!.advance(2_000);
        expect(current!.service.finalizePendingUpdates()).toEqual([]);
        expect(current!.pending.find(-100, replacementId)).toMatchObject({ state: "quarantined_renewal_candidate", candidateOperationId: "earlier-uncertain-renewal" });
        return replacementId;
      },
      forwardMessage: async () => { throw new Error("unused"); },
      editText: async ({ messageId }) => ({ messageId }),
      editCaption: async ({ messageId }) => ({ messageId }),
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

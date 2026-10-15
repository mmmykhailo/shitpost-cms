import { afterEach, describe, expect, test } from "bun:test";
import { createPreparationRepository } from "../src/db/preparation-repository";
import { createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createPreparationService } from "../src/services/preparation";
import { createTelegramCooldownRepository } from "../src/db/telegram-cooldown-repository";
import { createTelegramCooldown } from "../src/telegram-cooldown";
import type { TelegramCooldown } from "../src/telegram-cooldown";
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

const serviceFor = (h: ReturnType<typeof open>, gateway: TelegramGateway, cooldown?: TelegramCooldown) => createPreparationService({
  queue: h.queue,
  preparation: h.preparation,
  policy: h.policy,
  gateway,
  queueChannelId: asChatId(-100),
  bootId: "boot-test",
  clock: createFakeClock(NOW),
  logger: createLoggerSpy().logger,
  ...(cooldown === undefined ? {} : { cooldown }),
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

  test("copies an album as one grouped transfer and edits its existing caption with the generated credit", async () => {
    const h = open();
    const origin = { kind: "user", userId: asUserId(77), displayName: "Album Author" } as const;
    h.policy.observeAuthor(origin, NOW);
    const first = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(140), mediaGroupId: "album-prep", ordinal: 0, contentType: "photo", caption: "first", origin });
    const second = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(141), mediaGroupId: "album-prep", ordinal: 1, contentType: "photo", origin });
    const item = h.queue.observeQueueSnapshot(first, NOW, "copy", NOW).item;
    h.queue.addAlbumMember(item.id, second, NOW + 1);
    h.queue.finalizeAlbums(NOW + 3_000);
    const fake = makeGateway();
    const albumCalls: number[][] = [];
    fake.gateway.copyMessages = async ({ messageIds }) => { albumCalls.push(messageIds.map(Number)); return messageIds.map((_, index) => asMessageId(600 + index)); };

    expect((await serviceFor(h, fake.gateway).prepareNext()).kind).toBe("prepared");
    expect(albumCalls).toEqual([[140, 141]]);
    expect(fake.edits).toEqual([{ messageId: 600, caption: "first\n\nby Album Author" }]);
    expect(h.queue.getCurrentMembers(1).map((member) => member.albumKey)).toEqual(["album-prep", "album-prep"]);
  });

  test("prepares direct posts in place and holds legacy-policy or unsupported rows for review", async () => {
    const direct = open();
    direct.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(150), origin: { kind: "absent" } }), NOW, "copy", NOW);
    const directGateway = makeGateway();
    const directService = serviceFor(direct, directGateway.gateway);
    expect((await directService.prepareNext()).kind).toBe("prepared");
    direct.preparation.markPreparationNeeded(1, "refresh", NOW + 1);
    expect((await directService.prepareNext()).kind).toBe("prepared");
    expect(directGateway.copied).toEqual([]);
    expect(directGateway.deleted).toEqual([]);

    const legacy = open();
    legacy.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(151) }), NOW);
    expect(await serviceFor(legacy, makeGateway().gateway).prepareNext()).toMatchObject({ kind: "blocked", status: "needs_review", reason: "missing_captured_policy" });

    const unsupported = open();
    unsupported.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(152), contentType: "service", origin: USER }), NOW, "copy", NOW);
    const unsupportedGateway = makeGateway();
    expect(await serviceFor(unsupported, unsupportedGateway.gateway).prepareNext()).toMatchObject({ kind: "blocked", status: "blocked", reason: "unsupported_content" });
    expect(unsupportedGateway.copied).toEqual([]);
  });

  test("blocks oversized generated credits and multiple caption albums before transfer", async () => {
    const longText = open();
    longText.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(160), text: "x".repeat(4_090), origin: USER }), NOW, "copy", NOW);
    const longGateway = makeGateway();
    expect(await serviceFor(longText, longGateway.gateway).prepareNext()).toMatchObject({ kind: "blocked", status: "needs_edit", reason: "byline_preflight_failed" });
    expect(longGateway.copied).toEqual([]);

    const album = open();
    const first = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(161), mediaGroupId: "two-captions", contentType: "photo", caption: "one", origin: USER });
    const second = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(162), mediaGroupId: "two-captions", ordinal: 1, contentType: "photo", caption: "two", origin: USER });
    const item = album.queue.observeQueueSnapshot(first, NOW, "copy", NOW).item;
    album.queue.addAlbumMember(item.id, second, NOW + 1);
    album.queue.finalizeAlbums(NOW + 3_000);
    expect(await serviceFor(album, makeGateway().gateway).prepareNext()).toMatchObject({ kind: "blocked", status: "needs_review", reason: "multiple_album_captions" });
  });

  test("removes a confirmed missing singleton and marks a shortened album uncertain", async () => {
    const missing = open();
    missing.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(170), origin: USER }), NOW, "copy", NOW);
    const missingGateway = makeGateway();
    missingGateway.gateway.copyMessage = async () => { throw { kind: "source_missing", method: "copyMessage", description: "source gone" }; };
    expect((await serviceFor(missing, missingGateway.gateway).prepareNext()).kind).toBe("deleted_external");
    expect(missing.queue.findItemById(1)?.status).toBe("deleted_external");

    const short = open();
    const first = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(171), mediaGroupId: "short-preparation", contentType: "photo", origin: USER });
    const second = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(172), mediaGroupId: "short-preparation", ordinal: 1, contentType: "photo", origin: USER });
    const item = short.queue.observeQueueSnapshot(first, NOW, "copy", NOW).item;
    short.queue.addAlbumMember(item.id, second, NOW + 1);
    short.queue.finalizeAlbums(NOW + 3_000);
    const shortGateway = makeGateway();
    shortGateway.gateway.copyMessages = async () => [asMessageId(700)];
    expect((await serviceFor(short, shortGateway.gateway).prepareNext()).kind).toBe("uncertain");
    expect(short.preparation.operationEvidence(1)[0]?.outputs).toHaveLength(1);
    expect(short.queue.currentSourceIds(1)).toEqual([asMessageId(171), asMessageId(172)]);
  });

  test("retries preparation after a shared flood wait and cleans a known output", async () => {
    const h = open();
    const sticker = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(180), contentType: "sticker", origin: USER });
    delete sticker.text;
    h.queue.observeQueueSnapshot(sticker, NOW, "copy", NOW);
    const fake = makeGateway();
    fake.gateway.sendText = async () => { throw { kind: "rate_limited", description: "slow down", retryAfterSeconds: 120 }; };
    const clock = createFakeClock(NOW);
    const cooldown = createTelegramCooldown({ repository: createTelegramCooldownRepository(h.database), clock });

    const outcome = await serviceFor(h, fake.gateway, cooldown).prepareNext();

    expect(outcome).toMatchObject({ kind: "retry_scheduled", retryAt: NOW + 120_000 });
    expect(fake.deleted).toEqual([[500]]);
    expect(cooldown.notBefore()).toBe(NOW + 120_000);
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(180)]);
  });

  test("keeps a definite preparation failure actionable without deleting its source", async () => {
    const h = open();
    h.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(190), origin: USER }), NOW, "copy", NOW);
    const fake = makeGateway();
    fake.gateway.copyMessage = async () => { throw { kind: "permission_denied", description: "cannot copy" }; };

    expect(await serviceFor(h, fake.gateway).prepareNext()).toMatchObject({ kind: "blocked", status: "needs_review", reason: "permission_denied" });
    expect(fake.deleted).toEqual([]);
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(190)]);
  });

  test("keeps surviving members when a recovered bundle has one definitely missing source", async () => {
    const h = open();
    const origin = { kind: "chat", chatId: asChatId(-300), title: "Group" } as const;
    const first = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(260), ordinal: 0, contentType: "photo", origin });
    const second = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(261), ordinal: 1, contentType: "video", origin });
    const item = h.queue.insertRecoveredSnapshots([first, second], NOW);
    h.queue.reprocessRecoveredItem(item.id, "copy", NOW, NOW + 1);
    const fake = makeGateway();
    let copyCount = 0;
    fake.gateway.copyMessage = async ({ messageId }) => {
      copyCount += 1;
      if (Number(messageId) === 260) throw { kind: "source_missing", description: "first bundle member is gone" };
      return asMessageId(700);
    };

    expect((await serviceFor(h, fake.gateway).prepareNext()).kind).toBe("prepared");
    expect(copyCount).toBe(2);
    expect(h.queue.currentSourceIds(item.id)).toEqual([asMessageId(700)]);
    expect(h.queue.getCurrentMembers(item.id).map((member) => member.memberKey)).toEqual(["legacy:261"]);
  });

  test("handles separate-credit permission failures and ambiguous sends without losing source evidence", async () => {
    const blocked = open();
    const sticker = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(270), contentType: "sticker", origin: USER });
    delete sticker.text;
    blocked.queue.observeQueueSnapshot(sticker, NOW, "copy", NOW);
    const blockedGateway = makeGateway();
    blockedGateway.gateway.sendText = async () => { throw { kind: "permission_denied", description: "cannot create credit" }; };
    expect(await serviceFor(blocked, blockedGateway.gateway).prepareNext()).toMatchObject({ kind: "blocked", status: "blocked" });
    expect(blockedGateway.deleted).toEqual([[500]]);
    expect(blocked.queue.currentSourceIds(1)).toEqual([asMessageId(270)]);

    const uncertain = open();
    const uncertainSticker = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(271), contentType: "sticker", origin: USER });
    delete uncertainSticker.text;
    uncertain.queue.observeQueueSnapshot(uncertainSticker, NOW, "copy", NOW);
    const uncertainGateway = makeGateway();
    uncertainGateway.gateway.sendText = async () => { throw new TypeError("credit response lost"); };
    expect((await serviceFor(uncertain, uncertainGateway.gateway).prepareNext()).kind).toBe("uncertain");
    expect(uncertain.preparation.operationEvidence(1)[0]?.outputs).toHaveLength(1);
    expect(uncertain.queue.currentSourceIds(1)).toEqual([asMessageId(271)]);
  });

  test("retains uncertainty when a rate-limited credit cannot be cleaned up", async () => {
    const h = open();
    const sticker = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(272), contentType: "sticker", origin: USER });
    delete sticker.text;
    h.queue.observeQueueSnapshot(sticker, NOW, "copy", NOW);
    const fake = makeGateway();
    fake.gateway.sendText = async () => { throw { kind: "rate_limited", description: "slow down", retryAfterSeconds: 1 }; };
    fake.gateway.deleteMessages = async () => { throw new TypeError("cannot confirm output cleanup"); };

    expect((await serviceFor(h, fake.gateway).prepareNext()).kind).toBe("uncertain");
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(272)]);
    expect(h.preparation.operationEvidence(1)[0]?.outputs).toHaveLength(1);
  });

  test("marks an uncertain inline credit edit for review and never deletes the raw source", async () => {
    const h = open();
    h.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(273), text: "hello", origin: USER }), NOW, "copy", NOW);
    const fake = makeGateway();
    fake.gateway.editText = async () => { throw new TypeError("queue edit response lost"); };

    expect((await serviceFor(h, fake.gateway).prepareNext()).kind).toBe("uncertain");
    expect(fake.deleted).toEqual([]);
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(273)]);
    expect(h.preparation.operationEvidence(1)[0]?.outputs).toHaveLength(1);
  });

  test("refreshes inline caption and separate generated credits when a nickname changes", async () => {
    const caption = open();
    const origin = { kind: "hidden_user", senderUserName: "Captain" } as const;
    caption.policy.observeAuthor(origin, NOW);
    const hidden = caption.policy.listHiddenAuthors()[0]!;
    caption.policy.setHiddenAlias(hidden.hiddenAuthorId, "Pilot", 1, NOW + 1);
    caption.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(200), contentType: "photo", caption: "image", origin }), NOW, "copy", NOW);
    const captionGateway = makeGateway();
    const captionService = serviceFor(caption, captionGateway.gateway);
    expect((await captionService.prepareNext()).kind).toBe("prepared");
    caption.policy.setHiddenAlias(hidden.hiddenAuthorId, "Captain C", 1, NOW + 2);
    expect((await captionService.prepareNext()).kind).toBe("prepared");
    expect(captionGateway.edits.filter((edit) => edit.caption !== undefined).map((edit) => edit.caption)).toEqual(["image\n\nby Pilot", "image\n\nby Captain C"]);

    const separate = open();
    separate.policy.observeAuthor(USER, NOW);
    const sticker = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(201), contentType: "sticker", origin: USER });
    delete sticker.text;
    separate.queue.observeQueueSnapshot(sticker, NOW, "copy", NOW);
    const separateGateway = makeGateway();
    const separateService = serviceFor(separate, separateGateway.gateway);
    expect((await separateService.prepareNext()).kind).toBe("prepared");
    separate.policy.setAlias(55, "A. Example", 1, NOW + 3);
    expect((await separateService.prepareNext()).kind).toBe("prepared");
    expect(separateGateway.edits.at(-1)).toEqual({ messageId: 501, text: "by A. Example" });
    expect(separate.queue.getCurrentMembers(1).map((member) => member.role)).toEqual(["content", "credit"]);
  });

  test("refreshes one caption in a prepared album while keeping the stored album group", async () => {
    const h = open();
    const origin = { kind: "user", userId: asUserId(88), displayName: "Album Writer" } as const;
    h.policy.observeAuthor(origin, NOW);
    const first = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(230), mediaGroupId: "refresh-album", contentType: "photo", caption: "cover", origin });
    const second = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(231), mediaGroupId: "refresh-album", ordinal: 1, contentType: "photo", origin });
    const item = h.queue.observeQueueSnapshot(first, NOW, "copy", NOW).item;
    h.queue.addAlbumMember(item.id, second, NOW + 1);
    h.queue.finalizeAlbums(NOW + 3_000);
    const fake = makeGateway();
    const service = serviceFor(h, fake.gateway);
    expect((await service.prepareNext()).kind).toBe("prepared");
    h.policy.setAlias(88, "Album Editor", 1, NOW + 4);

    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(fake.edits.filter((edit) => edit.caption !== undefined).map((edit) => edit.caption)).toEqual(["cover\n\nby Album Writer", "cover\n\nby Album Editor"]);
    expect(h.queue.getCurrentMembers(1).map((member) => member.albumKey)).toEqual(["refresh-album", "refresh-album"]);
  });

  test("marks refresh edit rate limits for retry and ambiguous edit results for review", async () => {
    const retry = open();
    retry.policy.observeAuthor(USER, NOW);
    retry.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(240), text: "hello", origin: USER }), NOW, "copy", NOW);
    const retryGateway = makeGateway();
    const retryService = serviceFor(retry, retryGateway.gateway);
    expect((await retryService.prepareNext()).kind).toBe("prepared");
    retry.policy.setAlias(55, "Another Name", 1, NOW + 1);
    retryGateway.gateway.editText = async () => { throw { kind: "rate_limited", description: "slow down", retryAfterSeconds: 3 }; };
    expect((await retryService.prepareNext()).kind).toBe("retry_scheduled");
    expect(retry.queue.findItemById(1)?.preparationState).toBe("refresh_pending");

    const uncertain = open();
    uncertain.policy.observeAuthor(USER, NOW);
    uncertain.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(241), text: "hello", origin: USER }), NOW, "copy", NOW);
    const uncertainGateway = makeGateway();
    const uncertainService = serviceFor(uncertain, uncertainGateway.gateway);
    expect((await uncertainService.prepareNext()).kind).toBe("prepared");
    uncertain.policy.setAlias(55, "Other Name", 1, NOW + 1);
    uncertainGateway.gateway.editText = async () => { throw new TypeError("edit response lost"); };
    expect((await uncertainService.prepareNext()).kind).toBe("uncertain");
    expect(uncertain.queue.findItemById(1)).toMatchObject({ status: "needs_review", preparationState: "uncertain" });
  });

  test("clears a refreshed inline credit when Telegram confirms its source is missing", async () => {
    const h = open();
    h.policy.observeAuthor(USER, NOW);
    h.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(250), text: "hello", origin: USER }), NOW, "copy", NOW);
    const fake = makeGateway();
    const service = serviceFor(h, fake.gateway);
    expect((await service.prepareNext()).kind).toBe("prepared");
    h.policy.setAlias(55, "New Name", 1, NOW + 1);
    fake.gateway.editText = async () => { throw { kind: "source_missing", description: "prepared queue message was removed" }; };

    expect((await service.prepareNext()).kind).toBe("deleted_external");
    expect(h.queue.findItemById(1)?.status).toBe("deleted_external");
  });

  test("preserves an admin-owned credit when a later nickname update arrives", async () => {
    const h = open();
    h.policy.observeAuthor(USER, NOW);
    h.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(210), text: "hello", origin: USER }), NOW, "copy", NOW);
    const fake = makeGateway();
    const service = serviceFor(h, fake.gateway);
    expect((await service.prepareNext()).kind).toBe("prepared");
    const member = h.queue.getCurrentMembers(1)[0]!;
    h.queue.updateSnapshot(asChatId(-100), member.messageId, { ...member.snapshot, text: "my edited text" });
    h.policy.setAlias(55, "New Alias", 1, NOW + 2);
    h.preparation.markPreparationNeeded(1, "refresh", NOW + 3);

    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(h.queue.getCurrentMembers(1)[0]?.snapshot.text).toBe("my edited text");
    expect(h.queue.findItemById(1)?.attribution).toMatchObject({ ownership: "admin" });
    expect(fake.edits).toHaveLength(1);
  });

  test("reports cleanup work after source deletion fails and retries cleanup only", async () => {
    const h = open();
    h.queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(220), origin: USER }), NOW, "copy", NOW);
    const fake = makeGateway();
    let deleteCalls = 0;
    fake.gateway.deleteMessages = async () => {
      deleteCalls += 1;
      if (deleteCalls === 1) throw { kind: "permission_denied", description: "cannot delete old source" };
      if (deleteCalls === 2) throw { kind: "transient_network", description: "cleanup still unavailable" };
      if (deleteCalls === 3) throw { kind: "source_missing", description: "old source already absent" };
    };
    const service = serviceFor(h, fake.gateway);

    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(h.preparation.listCleanupPending()).toHaveLength(1);
    expect(await service.cleanupPending()).toBe(1);
    expect(h.preparation.listCleanupPending()).toHaveLength(1);
    expect(await service.cleanupPending()).toBe(1);
    expect(deleteCalls).toBe(3);
    expect(h.preparation.listCleanupPending()).toEqual([]);
  });
});

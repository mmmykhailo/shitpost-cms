import { afterEach, describe, expect, test } from "bun:test";
import { createTelegramCooldownRepository } from "../src/db/telegram-cooldown-repository";
import { createTelegramCooldown, type TelegramCooldown } from "../src/telegram-cooldown";
import { createFakeClock } from "../src/clock";
import { createPreparationRepository } from "../src/db/preparation-repository";
import { createPreparationRequestRepository } from "../src/db/preparation-request-repository";
import { createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createPreparationService } from "../src/services/preparation";
import type { InstagramProgress } from "../src/services/instagram-feedback";
import { InstagramDownloadError, type InstagramDownloader } from "../src/services/instagram-downloader";
import type { TelegramGateway } from "../src/telegram";
import { asChatId, asMessageId, asUserId, type MessageEntity, type StoredMessageSnapshot } from "../src/types";
import { snapshotFixture } from "./fixtures";
import { createLoggerSpy, createTestDatabase } from "./support";

const NOW = Date.parse("2026-10-15T08:00:00Z");
const REEL = "https://www.instagram.com/reel/ABC123/?igsh=tracking";
const USER = { kind: "user", userId: asUserId(55), displayName: "Alice Example" } as const;
const resources: Array<{ close(): void }> = [];
afterEach(() => { while (resources.length) resources.pop()!.close(); });

const open = () => {
  const resource = createTestDatabase("instagram-preparation");
  resources.push(resource);
  return {
    ...resource,
    queue: createQueueRepository(resource.database),
    policy: createPolicyRepository(resource.database),
    preparation: createPreparationRepository(resource.database, { operationId: (() => { let id = 0; return () => `reel-prep-${++id}`; })() }),
    requestEvidence: createPreparationRequestRepository(resource.database),
  };
};

const reelSnapshot = (overrides: Partial<StoredMessageSnapshot> = {}) => snapshotFixture({
  chatId: asChatId(-100), messageId: asMessageId(100), origin: USER,
  text: `My Telegram description\n${REEL}`, instagramReel: true, ...overrides,
});

type VideoInput = { chatId: number; path: string; caption?: string; captionEntities?: readonly MessageEntity[]; supportsStreaming?: boolean; disableNotification?: boolean };
const makeGateway = () => {
  const uploads: VideoInput[] = [];
  const copied: number[] = [];
  const deleted: number[][] = [];
  const captions: string[] = [];
  const gateway = {
    sendVideo: async (request: VideoInput) => {
      uploads.push(request);
      return { message_id: 500, date: NOW / 1_000, chat: { id: -100, type: "channel", title: "Queue" }, video: { file_id: "uploaded-video", file_unique_id: "unique-video", width: 720, height: 1280, duration: 20 }, caption: request.caption };
    },
    copyMessage: async ({ messageId }: { messageId: number }) => { copied.push(messageId); return asMessageId(501); },
    deleteMessages: async (_chatId: number, ids: readonly number[]) => { deleted.push([...ids]); },
    editCaption: async ({ messageId, caption }: { messageId: number; caption: string }) => { captions.push(caption); return { messageId: asMessageId(messageId), editDate: NOW }; },
    editText: async ({ messageId }: { messageId: number }) => ({ messageId: asMessageId(messageId), editDate: NOW }),
  };
  return { gateway: gateway as unknown as TelegramGateway, uploads, copied, deleted, captions };
};

const makeDownloader = () => {
  const calls: unknown[] = [];
  let cleanups = 0;
  const download = async (...args: unknown[]) => {
    calls.push(args[0]);
    return { path: "/tmp/instagram-test.mp4", supportsStreaming: true, cleanup: async () => { cleanups += 1; } };
  };
  return { download, calls, get cleanups() { return cleanups; } };
};

const serviceFor = (h: ReturnType<typeof open>, gateway: TelegramGateway, download: InstagramDownloader, options: { clock?: ReturnType<typeof createFakeClock>; cooldown?: TelegramCooldown; onInstagramProgress?: (progress: InstagramProgress) => void } = {}) => createPreparationService({
  queue: h.queue, policy: h.policy, preparation: h.preparation, requestEvidence: h.requestEvidence,
  gateway, queueChannelId: asChatId(-100), bootId: "reels-test", clock: createFakeClock(NOW),
  logger: createLoggerSpy().logger, instagramDownloader: download, ...options,
});

const enqueue = (h: ReturnType<typeof open>, snapshot = reelSnapshot(), mode: "copy" | "forward" = "copy") => {
  h.policy.observeAuthor(snapshot.origin, NOW);
  return h.queue.observeQueueSnapshot(snapshot, NOW, mode, NOW).item;
};

describe("Instagram Reel preparation", () => {
  test("reports download, upload and prepared stages in order without claiming publication", async () => {
    const h = open(); enqueue(h);
    const progress: InstagramProgress[] = [];
    expect((await serviceFor(h, makeGateway().gateway, makeDownloader().download, { onInstagramProgress: (event) => progress.push(event) }).prepareNext()).kind).toBe("prepared");
    expect(progress.map((event) => event.phase)).toEqual(["downloading", "uploading", "ready"]);
    expect(progress.every((event) => event.itemId === 1 && event.operationId === "reel-prep-1")).toBe(true);
  });

  test("reports retries and terminal failures while retaining the original source", async () => {
    const h = open(); enqueue(h);
    const progress: InstagramProgress[] = [];
    const download: InstagramDownloader = async () => { throw new InstagramDownloadError("limited", "Instagram is temporarily unavailable", true); };
    const outcome = await serviceFor(h, makeGateway().gateway, download, { onInstagramProgress: (event) => progress.push(event) }).prepareNext();
    expect(outcome.kind).toBe("retry_scheduled");
    expect(progress.map((event) => event.phase)).toEqual(["downloading", "retry"]);
    expect(progress[1]?.retryAt).toBe(NOW + 60_000);
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(100)]);
    const failed = open(); enqueue(failed);
    const events: InstagramProgress[] = [];
    const permanent: InstagramDownloader = async () => { throw new InstagramDownloadError("inaccessible", "This video is inaccessible"); };
    expect((await serviceFor(failed, makeGateway().gateway, permanent, { onInstagramProgress: (event) => events.push(event) }).prepareNext()).kind).toBe("blocked");
    expect(events.map((event) => event.phase)).toEqual(["downloading", "failed"]);
    expect(events[1]?.reason).toBe("This video is inaccessible");
  });

  test("reports ambiguous uploads as uncertain and isolates notification failures", async () => {
    const h = open(); enqueue(h);
    const progress: InstagramProgress[] = [];
    const fake = makeGateway();
    fake.gateway.sendVideo = async () => { throw { kind: "transient_network", description: "Upload response lost" }; };
    expect((await serviceFor(h, fake.gateway, makeDownloader().download, { onInstagramProgress: (event) => progress.push(event) }).prepareNext()).kind).toBe("uncertain");
    expect(progress.map((event) => event.phase)).toEqual(["downloading", "uploading", "uncertain"]);
    const second = open(); enqueue(second);
    expect((await serviceFor(second, makeGateway().gateway, makeDownloader().download, { onInstagramProgress: () => { throw new Error("outbox unavailable"); } }).prepareNext()).kind).toBe("prepared");
    expect(second.queue.findItemById(1)?.preparationState).toBe("ready");
  });

  test("reports invalid input before downloading", async () => {
    const h = open(); enqueue(h, reelSnapshot({ text: `${REEL} https://www.instagram.com/reel/OTHER/` }));
    const progress: InstagramProgress[] = [];
    const downloader = makeDownloader();
    expect((await serviceFor(h, makeGateway().gateway, downloader.download, { onInstagramProgress: (event) => progress.push(event) }).prepareNext()).kind).toBe("blocked");
    expect(progress.map((event) => event.phase)).toEqual(["failed"]);
    expect(downloader.calls).toHaveLength(0);
  });

  test("uploads the video with Telegram description and formatting, strips the URL, and installs a copy with user credit", async () => {
    const h = open();
    enqueue(h, reelSnapshot({ text: `😀 Description\n${REEL}`, entities: [{ type: "bold", offset: 3, length: 11 }, { type: "url", offset: 15, length: REEL.length }] }));
    const fake = makeGateway();
    const downloader = makeDownloader();
    const service = serviceFor(h, fake.gateway, downloader.download);

    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]).toMatchObject({ chatId: -100, path: "/tmp/instagram-test.mp4", caption: "😀 Description\n\nby Alice Example", captionEntities: [{ type: "bold", offset: 3, length: 11 }] });
    expect(fake.copied).toEqual([]);
    expect(fake.deleted).toEqual([[100]]);
    expect(downloader.calls).toHaveLength(1);
    expect(downloader.cleanups).toBe(1);
    expect(h.queue.findItemById(1)).toMatchObject({ preparationState: "ready", representationKind: "prepared", contentType: "video", deliveryMode: "copy" });
    expect(h.queue.getCurrentMembers(1)[0]).toMatchObject({ messageId: asMessageId(500), deliveryMode: "copy", snapshot: { contentType: "video", caption: "😀 Description\n\nby Alice Example", origin: USER, nativeOrigin: { kind: "absent" } } });
    expect(h.queue.getCurrentMembers(1)[0]?.snapshot.text).toBeUndefined();
    expect(h.requestEvidence.listForOperation("reel-prep-1").map((attempt) => [attempt.method, attempt.state])).toEqual([["sendVideo", "accepted"], ["deleteMessages", "accepted"]]);
    expect((await service.prepareNext()).kind).toBe("empty");
  });

  test("uses the current user alias and refreshes it by editing the imported caption without another download", async () => {
    const h = open();
    enqueue(h);
    h.policy.setAlias(55, "First Alias", 1, NOW + 1);
    const fake = makeGateway();
    const downloader = makeDownloader();
    const service = serviceFor(h, fake.gateway, downloader.download);
    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(fake.uploads[0]?.caption).toBe("My Telegram description\n\nby First Alias");

    h.policy.setAlias(55, "New Alias", 1, NOW + 2);
    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(fake.captions).toEqual(["My Telegram description\n\nby New Alias"]);
    expect(fake.uploads).toHaveLength(1);
    expect(downloader.calls).toHaveLength(1);
  });

  test("uses the exact hidden sender alias for a link-only post", async () => {
    const h = open();
    const origin = { kind: "hidden_user", senderUserName: "Hidden Name" } as const;
    enqueue(h, reelSnapshot({ origin, text: REEL }));
    h.policy.setHiddenAlias(h.policy.listHiddenAuthors()[0]!.hiddenAuthorId, "Alias", 1, NOW + 1);
    const fake = makeGateway();
    expect((await serviceFor(h, fake.gateway, makeDownloader().download).prepareNext()).kind).toBe("prepared");
    expect(fake.uploads[0]?.caption).toBe("\n\nby Alias");
  });

  test("keeps a direct link-only submission captionless", async () => {
    const h = open();
    enqueue(h, reelSnapshot({ origin: { kind: "absent" }, text: REEL }));
    const fake = makeGateway();
    expect((await serviceFor(h, fake.gateway, makeDownloader().download).prepareNext()).kind).toBe("prepared");
    expect(fake.uploads[0]?.caption ?? "").toBe("");
    expect(h.queue.findItemById(1)?.attribution).toEqual({ ownership: "none" });
  });

  test("imports a whitelisted channel Reel as copied video without forwarding its text or adding credit", async () => {
    const h = open();
    const origin = { kind: "channel", chatId: asChatId(-200), title: "Trusted" } as const;
    h.policy.upsertChannel(origin.chatId, undefined, origin.title, 1, NOW);
    enqueue(h, reelSnapshot({ origin, nativeOrigin: origin }), "forward");
    const fake = makeGateway();
    expect((await serviceFor(h, fake.gateway, makeDownloader().download).prepareNext()).kind).toBe("prepared");
    expect(fake.uploads[0]?.caption).toBe("My Telegram description");
    expect(h.queue.getCurrentMembers(1)[0]).toMatchObject({ deliveryMode: "copy", snapshot: { nativeOrigin: { kind: "absent" }, origin } });
    expect(h.queue.findItemById(1)?.deliveryMode).toBe("copy");
  });

  test("blocks a permanent download failure and retains the raw Telegram submission", async () => {
    const h = open();
    enqueue(h);
    const fake = makeGateway();
    const service = serviceFor(h, fake.gateway, async () => { throw new InstagramDownloadError("login_required", "Instagram requires login"); });
    expect((await service.prepareNext()).kind).toBe("blocked");
    expect(fake.uploads).toEqual([]);
    expect(fake.deleted).toEqual([]);
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(100)]);
    expect(h.queue.findItemById(1)).toMatchObject({ status: "blocked" });
    expect(h.queue.findItemById(1)?.preparationState).not.toBe("ready");
  });

  test("never replays an upload with an unknown Telegram outcome and still removes the temporary file", async () => {
    const h = open();
    enqueue(h);
    const fake = makeGateway();
    let uploads = 0;
    fake.gateway.sendVideo = async () => { uploads += 1; throw new TypeError("upload response lost"); };
    const downloader = makeDownloader();
    const service = serviceFor(h, fake.gateway, downloader.download);
    expect((await service.prepareNext()).kind).toBe("uncertain");
    expect((await service.prepareNext()).kind).toBe("empty");
    expect(uploads).toBe(1);
    expect(downloader.cleanups).toBe(1);
    expect(fake.deleted).toEqual([]);
    expect(h.queue.findItemById(1)).toMatchObject({ preparationState: "uncertain", status: "needs_review" });
    expect(h.requestEvidence.listForOperation("reel-prep-1")[0]).toMatchObject({ method: "sendVideo", state: "unknown" });
  });

  test("preserves an accepted upload as known output when an admin edits the raw source during the send", async () => {
    const h = open();
    const source = reelSnapshot();
    enqueue(h, source);
    const fake = makeGateway();
    const acceptedSend = fake.gateway.sendVideo!;
    fake.gateway.sendVideo = async (request) => {
      h.queue.acceptAdminQueueEdit({ chatId: -100, messageId: 100, snapshot: { ...source, text: `Changed while uploading\n${REEL}`, editDate: NOW + 1_000, telegramUpdateId: 12 }, receivedAt: NOW + 1_000, updateId: 12 });
      return acceptedSend(request);
    };
    const downloader = makeDownloader();
    const service = serviceFor(h, fake.gateway, downloader.download);
    expect((await service.prepareNext()).kind).toBe("uncertain");
    expect(h.queue.findItemById(1)).toMatchObject({ status: "needs_review", preparationState: "uncertain" });
    expect(h.preparation.operationEvidence(1)[0]?.outputs).toHaveLength(1);
    expect(h.preparation.operationEvidence(1)[0]?.outputs[0]).toMatchObject({ telegram_message_id: 500 });
    expect(h.requestEvidence.listForOperation("reel-prep-1")[0]).toMatchObject({ method: "sendVideo", state: "accepted", knownOutputIds: [500] });
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(100)]);
    expect(fake.deleted).toEqual([]);
    expect((await service.prepareNext()).kind).toBe("empty");
    expect(fake.uploads).toHaveLength(1);
    expect(downloader.cleanups).toBe(1);
    expect(() => h.preparation.releaseForResolution("reel-prep-1", "retry", NOW + 2_000)).toThrow();
  });

  test("restart materializes an accepted upload ID recorded before output persistence and never reuploads it", async () => {
    const h = open();
    const source = reelSnapshot();
    enqueue(h, source);
    const claim = h.preparation.claimNextPreparation(NOW, "old-process")!;
    h.preparation.persistContract(claim.operationId, {
      version: 1, kind: "prepare", itemId: claim.itemId,
      capturedContentVersion: claim.guard.capturedContentVersion, capturedSourceGeneration: claim.guard.capturedSourceGeneration,
      originalOrigin: source.origin, deliveryMode: "copy", capturedMembers: h.queue.getCurrentMembers(1), steps: [],
      targetNicknameRevision: 0, attribution: { ownership: "none" },
      importVideo: { version: 1, kind: "instagram_reel", url: "https://www.instagram.com/reel/ABC123/", caption: "My Telegram description", captionEntities: [] },
    }, NOW);
    h.preparation.setPhase(claim.operationId, "transfer_pending", NOW);
    const requestId = h.requestEvidence.begin({ operationId: claim.operationId, method: "sendVideo", targetChatId: -100, stepKey: "instagram-video", now: NOW });
    h.requestEvidence.finish(requestId, { state: "accepted", knownOutputIds: [500] }, NOW + 100);
    expect(h.preparation.operationEvidence(1)[0]?.outputs).toEqual([]);

    expect(h.preparation.recoverExpiredOperations(NOW + 1_000, "new-process")).toMatchObject({ uncertain: 1, requeued: 0 });
    expect(h.preparation.operationEvidence(1)[0]?.outputs).toHaveLength(1);
    expect(h.preparation.operationEvidence(1)[0]?.outputs[0]).toMatchObject({ telegram_message_id: 500 });
    expect(h.queue.findItemById(1)).toMatchObject({ status: "needs_review", preparationState: "uncertain" });
    const fake = makeGateway();
    const downloader = makeDownloader();
    expect((await serviceFor(h, fake.gateway, downloader.download).prepareNext()).kind).toBe("empty");
    expect(fake.uploads).toEqual([]);
    expect(downloader.calls).toEqual([]);
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(100)]);
    expect(() => h.preparation.releaseForResolution(claim.operationId, "retry", NOW + 2_000)).toThrow();
  });

  test("checks the final caption limit before downloading", async () => {
    const h = open();
    enqueue(h, reelSnapshot({ text: `${"x".repeat(1_020)}\n${REEL}` }));
    const fake = makeGateway();
    const downloader = makeDownloader();
    expect(await serviceFor(h, fake.gateway, downloader.download).prepareNext()).toMatchObject({ kind: "blocked", status: "needs_edit" });
    expect(downloader.calls).toEqual([]);
    expect(fake.uploads).toEqual([]);
    expect(fake.deleted).toEqual([]);
  });

  test("a raw admin-edited Reel remains nonready for review instead of adopting its link as the post", async () => {
    const h = open();
    const source = reelSnapshot();
    enqueue(h, source);
    h.queue.acceptAdminQueueEdit({ chatId: -100, messageId: 100, snapshot: { ...source, text: `Edited description\n${REEL}`, editDate: NOW + 1_000, telegramUpdateId: 10 }, receivedAt: NOW + 1_000, updateId: 10 });
    const fake = makeGateway();
    const downloader = makeDownloader();
    expect(await serviceFor(h, fake.gateway, downloader.download).prepareNext()).toMatchObject({ kind: "blocked", status: "needs_review" });
    expect(downloader.calls).toEqual([]);
    expect(fake.uploads).toEqual([]);
    expect(h.queue.findItemById(1)?.preparationState).not.toBe("ready");
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(100)]);
  });

  test("an admin edit during download prevents dispatch and cleans the temporary file", async () => {
    const h = open();
    const source = reelSnapshot();
    enqueue(h, source);
    const fake = makeGateway();
    const downloader = makeDownloader();
    const service = serviceFor(h, fake.gateway, async (...args) => {
      const file = await downloader.download(...args);
      h.queue.acceptAdminQueueEdit({ chatId: -100, messageId: 100, snapshot: { ...source, text: `Changed\n${REEL}`, editDate: NOW + 1_000, telegramUpdateId: 11 }, receivedAt: NOW + 1_000, updateId: 11 });
      return file;
    });
    await service.prepareNext();
    expect(fake.uploads).toEqual([]);
    expect(fake.deleted).toEqual([]);
    expect(downloader.cleanups).toBe(1);
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(100)]);
    expect(h.queue.findItemById(1)?.preparationState).not.toBe("ready");
  });

  test("source cleanup failure retries deletion without downloading or uploading again", async () => {
    const h = open();
    enqueue(h);
    const fake = makeGateway();
    let deletions = 0;
    fake.gateway.deleteMessages = async () => { if (++deletions === 1) throw { kind: "permission_denied", description: "cannot delete raw source" }; };
    const downloader = makeDownloader();
    const service = serviceFor(h, fake.gateway, downloader.download);
    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(h.preparation.listCleanupPending()).toHaveLength(1);
    expect(await service.cleanupPending()).toBe(1);
    expect(h.preparation.listCleanupPending()).toEqual([]);
    expect((await service.prepareNext()).kind).toBe("empty");
    expect(downloader.calls).toHaveLength(1);
    expect(fake.uploads).toHaveLength(1);
  });

  test("a temporary-file cleanup failure does not turn an accepted video into a replayable submission", async () => {
    const h = open();
    enqueue(h);
    const fake = makeGateway();
    const service = serviceFor(h, fake.gateway, async () => ({ path: "/tmp/instagram-test.mp4", supportsStreaming: true, cleanup: async () => { throw new Error("cannot unlink temporary file"); } }));
    expect((await service.prepareNext()).kind).toBe("prepared");
    expect((await service.prepareNext()).kind).toBe("empty");
    expect(fake.uploads).toHaveLength(1);
    expect(h.queue.findItemById(1)).toMatchObject({ preparationState: "ready", representationKind: "prepared" });
  });

  test("retries Instagram failures with a bounded backoff without affecting the Telegram cooldown", async () => {
    const h = open();
    enqueue(h);
    const fake = makeGateway();
    const clock = createFakeClock(NOW);
    const cooldown = createTelegramCooldown({ repository: createTelegramCooldownRepository(h.database), clock });
    let attempts = 0;
    const service = serviceFor(h, fake.gateway, async () => { attempts += 1; throw new InstagramDownloadError("instagram_rate_limited", "Instagram is busy", true, 90_000); }, { clock, cooldown });
    expect(await service.prepareNext()).toMatchObject({ kind: "retry_scheduled", retryAt: NOW + 90_000 });
    expect(cooldown.notBefore()).toBe(0);
    expect((await service.prepareNext()).kind).toBe("empty");
    clock.advance(90_000);
    expect(await service.prepareNext()).toMatchObject({ kind: "retry_scheduled", retryAt: NOW + 390_000 });
    clock.advance(300_000);
    expect(await service.prepareNext()).toMatchObject({ kind: "blocked", status: "blocked" });
    expect(attempts).toBe(3);
    expect(fake.uploads).toEqual([]);
    expect(fake.deleted).toEqual([]);
    expect(cooldown.notBefore()).toBe(0);
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(100)]);
  });

  test("a definite Telegram upload flood wait updates its cooldown and safely retries", async () => {
    const h = open();
    enqueue(h);
    const fake = makeGateway();
    const acceptedSend = fake.gateway.sendVideo!;
    let attempts = 0;
    fake.gateway.sendVideo = async (request) => {
      if (++attempts === 1) throw { kind: "rate_limited", description: "Telegram flood wait", retryAfterSeconds: 120 };
      return acceptedSend(request);
    };
    const clock = createFakeClock(NOW);
    const cooldown = createTelegramCooldown({ repository: createTelegramCooldownRepository(h.database), clock });
    const downloader = makeDownloader();
    const service = serviceFor(h, fake.gateway, downloader.download, { clock, cooldown });
    expect(await service.prepareNext()).toMatchObject({ kind: "retry_scheduled", retryAt: NOW + 120_000 });
    expect(cooldown.notBefore()).toBe(NOW + 120_000);
    expect(downloader.cleanups).toBe(1);
    expect(fake.deleted).toEqual([]);
    clock.advance(120_000);
    expect((await service.prepareNext()).kind).toBe("prepared");
    expect(attempts).toBe(2);
    expect(downloader.calls).toHaveLength(2);
    expect(downloader.cleanups).toBe(2);
    expect(fake.uploads).toHaveLength(1);
  });

  test("restart before upload requeues the raw submission and can complete an import", async () => {
    const h = open();
    enqueue(h);
    const claim = h.preparation.claimNextPreparation(NOW, "old-process")!;
    h.preparation.setPhase(claim.operationId, "contract_persisted", NOW);
    expect(h.preparation.recoverExpiredOperations(NOW + 1, "new-process")).toMatchObject({ requeued: 1, uncertain: 0 });
    const fake = makeGateway();
    const downloader = makeDownloader();
    expect((await serviceFor(h, fake.gateway, downloader.download).prepareNext()).kind).toBe("prepared");
    expect(fake.uploads).toHaveLength(1);
    expect(downloader.calls).toHaveLength(1);
  });

  test("restart during an upload with no response holds for inspection without a replay", async () => {
    const h = open();
    enqueue(h);
    const claim = h.preparation.claimNextPreparation(NOW, "old-process")!;
    h.preparation.setPhase(claim.operationId, "transfer_pending", NOW);
    h.requestEvidence.begin({ operationId: claim.operationId, method: "sendVideo", targetChatId: -100, stepKey: "instagram-video", now: NOW });
    expect(h.preparation.recoverExpiredOperations(NOW + 1, "new-process")).toMatchObject({ requeued: 0, uncertain: 1 });
    const fake = makeGateway();
    const downloader = makeDownloader();
    expect((await serviceFor(h, fake.gateway, downloader.download).prepareNext()).kind).toBe("empty");
    expect(fake.uploads).toEqual([]);
    expect(downloader.calls).toEqual([]);
    expect(h.queue.currentSourceIds(1)).toEqual([asMessageId(100)]);
    expect(h.queue.findItemById(1)).toMatchObject({ status: "needs_review", preparationState: "uncertain" });
  });

  test("does not reinterpret old unmarked queue text as an Instagram import", async () => {
    const h = open();
    const source = reelSnapshot();
    delete source.instagramReel;
    enqueue(h, source);
    const fake = makeGateway();
    const downloader = makeDownloader();
    expect((await serviceFor(h, fake.gateway, downloader.download).prepareNext()).kind).toBe("prepared");
    expect(downloader.calls).toEqual([]);
    expect(fake.uploads).toEqual([]);
    expect(fake.copied).toEqual([100]);
  });
});

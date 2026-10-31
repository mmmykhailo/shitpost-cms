import { afterEach, describe, expect, test } from "bun:test";
import { createGeneratedEventRepository } from "../src/db/generated-event-repository";
import { createPendingUpdateRepository } from "../src/db/pending-update-repository";
import { createPreparationRepository } from "../src/db/preparation-repository";
import { createPreparationRequestRepository } from "../src/db/preparation-request-repository";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createIngestionService } from "../src/services/ingestion";
import { asChatId, asMessageId } from "../src/types";
import { createFakeClock } from "../src/clock";
import { snapshotFixture } from "./fixtures";
import { createLoggerSpy, createTestDatabase } from "./support";

const NOW = Date.parse("2026-10-15T08:00:00Z");
const CAPTION = "Telegram description";
const resources: Array<{ close(): void }> = [];
afterEach(() => { while (resources.length) resources.pop()!.close(); });
const open = () => {
  const resource = createTestDatabase("instagram-echo-ingestion");
  resources.push(resource);
  const queue = createQueueRepository(resource.database);
  const preparation = createPreparationRepository(resource.database);
  const requests = createPreparationRequestRepository(resource.database);
  const pending = createPendingUpdateRepository(resource.database);
  const clock = createFakeClock(NOW);
  const ingestion = createIngestionService({ queueChannelId: asChatId(-100), queue, policy: createPolicyRepository(resource.database), generated: createGeneratedMessageRepository(resource.database), events: createGeneratedEventRepository(resource.database), pending, logger: createLoggerSpy().logger, now: clock.now });
  const source = snapshotFixture({ messageId: asMessageId(100), text: "https://www.instagram.com/reel/ABC/", instagramReel: true });
  queue.observeQueueSnapshot(source, NOW, "copy", NOW);
  const claim = preparation.claimNextPreparation(NOW, "old-boot")!;
  preparation.persistContract(claim.operationId, { version: 1, kind: "prepare", itemId: claim.itemId, capturedContentVersion: claim.guard.capturedContentVersion, capturedSourceGeneration: claim.guard.capturedSourceGeneration, originalOrigin: source.origin, deliveryMode: "copy", capturedMembers: queue.getCurrentMembers(claim.itemId), steps: [], targetNicknameRevision: 0, attribution: { ownership: "none" }, importVideo: { version: 1, kind: "instagram_reel", url: "https://www.instagram.com/reel/ABC/", caption: CAPTION, captionEntities: [] } }, NOW);
  preparation.setPhase(claim.operationId, "transfer_pending", NOW);
  const requestId = requests.begin({ operationId: claim.operationId, method: "sendVideo", targetChatId: -100, stepKey: "instagram-video", now: NOW });
  const loseResponse = () => {
    requests.finish(requestId, { state: "unknown", errorKind: "transient_network" }, NOW + 100);
    preparation.markUncertain(claim.operationId, "transient_network", "response lost", NOW + 100);
  };
  return { ...resource, queue, preparation, requests, pending, clock, ingestion, claim, loseResponse };
};

const video = (id = 500, date = NOW / 1000, caption = CAPTION) => ({ message_id: id, date, chat: { id: -100, type: "channel", title: "Queue" }, video: { file_id: "file", file_unique_id: "unique", width: 720, height: 1280, duration: 1 }, caption }) as const;

describe("uncertain Instagram upload echo ingestion", () => {
  test("quarantines an early buffered echo when the response is lost before finalization", () => {
    const h = open();
    h.ingestion.handleChannelPost(video());
    h.loseResponse();
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
    expect(h.queue.findBySource(-100, 500)).toBeUndefined();
    expect(h.pending.find(-100, 500)).toMatchObject({ state: "quarantined_renewal_candidate", candidateOperationId: h.claim.operationId });
  });

  test("quarantines an echo delivered late using its Telegram creation time", () => {
    const h = open();
    h.loseResponse();
    h.clock.advance(60_000);
    h.ingestion.handleChannelPost(video());
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
    expect(h.queue.findBySource(-100, 500)).toBeUndefined();
  });

  test("quarantines a buffered echo after startup recovers an in-flight upload as uncertain", () => {
    const h = open();
    h.ingestion.handleChannelPost(video());
    expect(h.preparation.recoverExpiredOperations(NOW + 1_000, "new-boot")).toMatchObject({ uncertain: 1 });
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
    expect(h.queue.findBySource(-100, 500)).toBeUndefined();
  });

  test("restart after long downtime quarantines the original echo but accepts a recent same-caption video", () => {
    const h = open();
    h.clock.advance(2 * 86_400_000);
    expect(h.preparation.recoverExpiredOperations(h.clock.now(), "new-boot")).toMatchObject({ uncertain: 1 });
    h.ingestion.handleChannelPost(video(500, NOW / 1000));
    h.ingestion.handleChannelPost(video(501, h.clock.now() / 1000));
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([2]);
    expect(h.queue.findBySource(-100, 500)).toBeUndefined();
    expect(h.pending.find(-100, 500)).toMatchObject({ state: "quarantined_renewal_candidate", candidateOperationId: h.claim.operationId });
    expect(h.queue.findBySource(-100, 501)?.id).toBe(2);
    expect(h.pending.find(-100, 501)?.state).toBe("ingested");
  });

  test("does not hold a later unrelated video with the same caption", () => {
    const h = open();
    h.loseResponse();
    h.clock.advance(60_000);
    h.ingestion.handleChannelPost(video(501, (NOW + 60_000) / 1000));
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([2]);
    expect(h.queue.findBySource(-100, 501)?.id).toBe(2);
  });

  test("does not hold an unrelated same-time video with different caption", () => {
    const h = open();
    h.loseResponse();
    h.ingestion.handleChannelPost(video(501, NOW / 1000, "Another post"));
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([2]);
  });

  test("does not use a definite rejected request as evidence for quarantining a video", () => {
    const h = open();
    h.requests.finish(h.requests.listForOperation(h.claim.operationId)[0]!.id, { state: "rejected", errorKind: "rate_limited" }, NOW);
    h.preparation.markUncertain(h.claim.operationId, "test", "hold operation", NOW);
    h.ingestion.handleChannelPost(video());
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([2]);
  });

  test("matches a known accepted upload ID even after its caption changes or its time falls outside the uncertainty window", () => {
    const h = open();
    const attempt = h.requests.listForOperation(h.claim.operationId)[0]!;
    h.requests.finish(attempt.id, { state: "accepted", knownOutputIds: [500] }, NOW + 100);
    h.preparation.markUncertain(h.claim.operationId, "test", "output persistence failed", NOW + 100);
    h.clock.advance(60_000);
    h.ingestion.handleChannelPost(video(500, (NOW + 60_000) / 1000, "Edited caption"));
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
    expect(h.queue.findBySource(-100, 500)).toBeUndefined();
    expect(h.pending.find(-100, 500)?.candidateOperationId).toBe(h.claim.operationId);
  });

  test("retains an import association when its echo was quarantined while upload was still active", () => {
    const h = open();
    h.ingestion.handleChannelPost(video());
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
    h.loseResponse();
    expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
    h.preparation.releaseForResolution(h.claim.operationId, "retry", h.clock.now());
    expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
    expect(h.pending.find(-100, 500)?.state).toBe("discarded");
  });

  test("preserves unrelated concurrent submissions quarantined by an active preparation", () => {
    const h = open();
    h.ingestion.handleChannelPost(video(501, NOW / 1000, "Unrelated video"));
    h.ingestion.handleChannelPost({ message_id: 502, date: NOW / 1000, chat: { id: -100, type: "channel", title: "Queue" }, text: "Unrelated text" });
    h.clock.advance(3_000);
    expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
    expect(h.pending.find(-100, 501)?.state).toBe("quarantined_renewal_candidate");
    expect(h.pending.find(-100, 502)?.state).toBe("quarantined_renewal_candidate");
    h.loseResponse();
    h.preparation.releaseForResolution(h.claim.operationId, "discard", h.clock.now());
    expect(h.ingestion.finalizePendingUpdates()).toHaveLength(2);
    expect(h.queue.findBySource(-100, 501)).toBeDefined();
    expect(h.queue.findBySource(-100, 502)).toBeDefined();
  });

  for (const action of ["retry", "discard"] as const) {
    test(`an admin ${action} resolution discards the quarantined echo without creating another item`, () => {
      const h = open();
      h.loseResponse();
      h.ingestion.handleChannelPost(video());
      h.clock.advance(3_000);
      expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
      h.preparation.releaseForResolution(h.claim.operationId, action, h.clock.now());
      expect(h.ingestion.finalizePendingUpdates()).toEqual([]);
      expect(h.pending.find(-100, 500)?.state).toBe("discarded");
      expect(h.queue.findBySource(-100, 500)).toBeUndefined();
    });
  }
});

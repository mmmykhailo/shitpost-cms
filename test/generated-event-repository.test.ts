import { afterEach, describe, expect, test } from "bun:test";
import { createGeneratedEventRepository } from "../src/db/generated-event-repository";
import { createPreparationRepository } from "../src/db/preparation-repository";
import { createQueueRepository } from "../src/db/repositories";
import { asChatId, asMessageId } from "../src/types";
import { createTestDatabase } from "./support";
import { snapshotFixture } from "./fixtures";

const resources: Array<{ close(): void }> = [];
const open = () => {
  const resource = createTestDatabase("generated-events");
  resources.push(resource);
  return resource;
};

afterEach(() => { while (resources.length) resources.pop()!.close(); });

describe("generated event repository", () => {
  test("validates event identity and stores a validated optional snapshot", () => {
    const { database } = open();
    const repository = createGeneratedEventRepository(database, () => "event-1");
    expect(() => repository.expect({ family: "renewal", operationId: "", chatId: -100, messageId: 1, kind: "post", now: 1 })).toThrow("identity is invalid");
    expect(() => repository.expect({ family: "renewal", operationId: "op", chatId: -100, messageId: 0, kind: "post", now: 1 })).toThrow("identity is invalid");
    const snapshot = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(55) });
    expect(repository.expect({ family: "preparation", operationId: "prep-1", chatId: -100, messageId: 55, kind: "edit", fingerprint: "fp", snapshot, now: 10 })).toBe("event-1");
    expect(repository.expect({ family: "preparation", operationId: "prep-1", chatId: -100, messageId: 55, kind: "edit", fingerprint: "fp", snapshot, now: 11 })).toBe("event-1");
    const stored = database.raw.query("SELECT state, request_state, expected_fingerprint, expected_snapshot_json FROM queue_generated_events WHERE id = 'event-1'").get() as { state: string; request_state: string; expected_fingerprint: string; expected_snapshot_json: string };
    expect(stored).toMatchObject({ state: "pending", request_state: "queued", expected_fingerprint: "fp" });
    expect(JSON.parse(stored.expected_snapshot_json)).toMatchObject({ chatId: -100, messageId: 55, text: "hello" });
  });

  test("matches expected fingerprints once and leaves mismatches pending", () => {
    const { database } = open();
    const repository = createGeneratedEventRepository(database, (() => { let id = 0; return () => `event-${++id}`; })());
    const expected = "a".repeat(64);
    const eventId = repository.expect({ family: "preparation", operationId: "prep-1", chatId: -100, messageId: 60, kind: "edit", fingerprint: expected, now: 1 });
    repository.markEditRequestStarted(eventId, 2, 7);
    repository.markEditRequestAccepted(eventId, 3, 8_000);
    expect(repository.consume(-100, 60, "edit", "other", 2)).toBeUndefined();
    const echo = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(60), contentFingerprint: expected, editDate: 8_000, telegramUpdateId: 8 });
    expect(repository.consume(-100, 60, "edit", expected, 3, echo)).toEqual({ eventId: "event-1", operationId: "prep-1", family: "preparation" });
    expect(repository.consume(-100, 60, "edit", expected, 4, echo)).toEqual({ eventId: "event-1", operationId: "prep-1", family: "preparation" });
    expect(database.raw.query("SELECT state, matched_at FROM queue_generated_events WHERE id = 'event-1'").get()).toEqual({ state: "matched", matched_at: 3 });
  });

  test("stores an in-flight echo provisionally and reconciles it against the returned receipt", () => {
    const { database } = open();
    const repository = createGeneratedEventRepository(database, () => "event-provisional");
    const expected = "a".repeat(64);
    const eventId = repository.expect({ family: "preparation", operationId: "prep-provisional", chatId: -100, messageId: 61, kind: "edit", fingerprint: expected, now: 1 });
    repository.markEditRequestStarted(eventId, 2, 10);
    const echo = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(61), contentFingerprint: expected, editDate: 8_000, telegramUpdateId: 11 });
    expect(repository.consume(-100, 61, "edit", expected, 3, echo)).toMatchObject({ eventId, provisional: true });
    expect(repository.markEditRequestAccepted(eventId, 4, 8_000)).toEqual({ kind: "generated" });
    expect(database.raw.query("SELECT state, request_state, provisional_update_id FROM queue_generated_events WHERE id = ?").get(eventId)).toEqual({ state: "matched", request_state: "accepted", provisional_update_id: 11 });
  });

  test("turns a differing in-flight echo into preserved collision evidence", () => {
    const { database } = open();
    const repository = createGeneratedEventRepository(database, () => "event-collision");
    const eventId = repository.expect({ family: "preparation", operationId: "prep-collision", chatId: -100, messageId: 62, kind: "edit", fingerprint: "a".repeat(64), now: 1 });
    repository.markEditRequestStarted(eventId, 2, 10);
    const humanFingerprint = "b".repeat(64);
    const humanEdit = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(62), text: "human version", contentFingerprint: humanFingerprint, editDate: 9_000, telegramUpdateId: 12 });
    expect(repository.consume(-100, 62, "edit", humanFingerprint, 3, humanEdit)).toMatchObject({ eventId, provisional: true });
    expect(repository.markEditRequestAccepted(eventId, 4, 8_000)).toMatchObject({ kind: "collision", snapshot: { text: "human version", telegramUpdateId: 12 } });
    expect(database.raw.query("SELECT state, request_state, provisional_update_id FROM queue_generated_events WHERE id = ?").get(eventId)).toEqual({ state: "pending", request_state: "accepted", provisional_update_id: 12 });
  });

  test("retires a definite failed edit so a later matching restoration is not swallowed", () => {
    const { database } = open();
    const repository = createGeneratedEventRepository(database, () => "event-rejected");
    const expected = "a".repeat(64);
    const eventId = repository.expect({ family: "preparation", operationId: "prep-rejected", chatId: -100, messageId: 63, kind: "edit", fingerprint: expected, now: 1 });
    repository.markEditRequestStarted(eventId, 2, 10);
    repository.markEditRequestRejected(eventId, 3);
    const restoration = snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(63), contentFingerprint: expected, editDate: 8_000, telegramUpdateId: 11 });
    expect(repository.consume(-100, 63, "edit", expected, 4, restoration)).toBeUndefined();
    expect(database.raw.query("SELECT state, request_state FROM queue_generated_events WHERE id = ?").get(eventId)).toEqual({ state: "obsolete", request_state: "rejected" });
  });

  test("matches wildcard expectations, obsoletes pending events, and retains events owned by live operations", () => {
    const { database } = open();
    const events = createGeneratedEventRepository(database, (() => { let id = 0; return () => `event-${++id}`; })());
    events.expect({ family: "recovery", operationId: "recovery-1", chatId: -100, messageId: 70, kind: "post", now: 1 });
    expect(events.consume(-100, 70, "post", "any-fingerprint", 2)).toEqual({ eventId: "event-1", operationId: "recovery-1", family: "recovery" });

    const queue = createQueueRepository(database);
    queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(80), telegramDate: 0 }), 0);
    queue.claimRenewal("live-renewal", 1, 1);
    events.expect({ family: "renewal", operationId: "live-renewal", chatId: -100, messageId: 81, kind: "post", now: 2 });
    expect(events.obsoleteForOperation("renewal", "live-renewal", 3)).toBe(1);
    expect(events.purge(10)).toBe(1);
    expect(database.raw.query("SELECT state FROM queue_generated_events WHERE id = 'event-2'").get()).toEqual({ state: "obsolete" });
    queue.setOperationState("live-renewal", "failed", 4, "test_complete");
    expect(events.purge(10)).toBe(1);
  });

  test("retains events while preparation owns them and purges after the operation ends", () => {
    const { database } = open();
    const queue = createQueueRepository(database);
    queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(90), telegramDate: 0 }), 0, "copy", 0);
    const preparation = createPreparationRepository(database, { operationId: () => "prep-live" });
    const claim = preparation.claimNextPreparation(1, "boot-a");
    expect(claim?.operationId).toBe("prep-live");
    const events = createGeneratedEventRepository(database, () => "event-live");
    events.expect({ family: "preparation", operationId: "prep-live", chatId: -100, messageId: 91, kind: "post", now: 2 });
    expect(events.obsoleteForOperation("preparation", "prep-live", 3)).toBe(1);
    expect(events.purge(10)).toBe(0);
    database.raw.query("UPDATE queue_preparation_operations SET state = 'failed', phase = 'failed' WHERE id = 'prep-live'").run();
    expect(events.purge(10)).toBe(1);
  });
});

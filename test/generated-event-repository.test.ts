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
    const stored = database.raw.query("SELECT state, expected_fingerprint, expected_snapshot_json FROM queue_generated_events WHERE id = 'event-1'").get() as { state: string; expected_fingerprint: string; expected_snapshot_json: string };
    expect(stored).toMatchObject({ state: "pending", expected_fingerprint: "fp" });
    expect(JSON.parse(stored.expected_snapshot_json)).toMatchObject({ chatId: -100, messageId: 55, text: "hello" });
  });

  test("matches expected fingerprints once and leaves mismatches pending", () => {
    const { database } = open();
    const repository = createGeneratedEventRepository(database, (() => { let id = 0; return () => `event-${++id}`; })());
    repository.expect({ family: "preparation", operationId: "prep-1", chatId: -100, messageId: 60, kind: "edit", fingerprint: "expected", now: 1 });
    expect(repository.consume(-100, 60, "edit", "other", 2)).toBeUndefined();
    expect(repository.consume(-100, 60, "edit", "expected", 3)).toEqual({ eventId: "event-1", operationId: "prep-1", family: "preparation" });
    expect(repository.consume(-100, 60, "edit", "expected", 4)).toBeUndefined();
    expect(database.raw.query("SELECT state, matched_at FROM queue_generated_events WHERE id = 'event-1'").get()).toEqual({ state: "matched", matched_at: 3 });
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

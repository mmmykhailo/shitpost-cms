import { test, expect } from "bun:test";
import { createQueueRepository } from "../src/db/repositories";
import { asMessageId } from "../src/types";
import { createTestDatabase } from "./support";
import { snapshotFixture } from "./fixtures";

test("front and back movement preserve identity, age, errors, and non-target order", () => {
  const resource = createTestDatabase();
  try {
    const q = createQueueRepository(resource.database);
    for (let id = 1; id <= 4; id++) q.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(id) }), id * 1000);
    q.transition(1, "queued", "deleted", 5000);
    q.transition(4, "queued", "blocked", 5001, "original_issue", "keep evidence");
    const before = q.findItemById(4)!;
    expect(q.moveToFirst(4, 6000, before.logicalSequence, 42)).toBe("moved");
    expect(q.listActive().map(i => i.id)).toEqual([4, 2, 3]);
    expect(q.findItemById(4)).toEqual({ ...before, logicalSequence: 0 });
    expect(q.moveToFirst(4, 6001, 0, 42)).toBe("already_first");
    expect(q.moveToEnd(4, 6002, before.logicalSequence, 42)).toBe("position_changed");
    expect(q.moveToEnd(4, 6003, 0, 42)).toBe("moved");
    expect(q.listActive().map(i => i.id)).toEqual([2, 3, 4]);
    const inserted = q.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(5) }), 7000).item;
    expect(q.listActive().at(-1)?.id).toBe(inserted.id);
    expect(q.moveToFirst(1, 7001)).toBe("terminal");
    expect(q.moveToFirst(999, 7001)).toBe("missing");
    expect(resource.database.raw.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type LIKE 'queue_moved_to_%'").get()).toEqual({ count: 2 });
  } finally { resource.close(); }
});

test("movement refuses owned items and fails atomically at the integer boundary", () => {
  const resource = createTestDatabase();
  try {
    const q = createQueueRepository(resource.database);
    q.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(1), mediaGroupId: "album" }), 1000);
    q.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(2) }), 1001);
    expect(q.moveToFirst(1, 1002)).toBe("busy");
    resource.database.raw.query("UPDATE queue_items SET preparation_operation_id = 'claimed' WHERE id = 2").run();
    expect(q.moveToFirst(2, 1002)).toBe("busy");
    resource.database.raw.query("UPDATE queue_items SET preparation_operation_id = NULL WHERE id = 2").run();
    resource.database.raw.query("UPDATE queue_items SET logical_sequence = ? WHERE id = 1").run(Number.MIN_SAFE_INTEGER);
    expect(() => q.moveToFirst(2, 1002)).toThrow("Queue position limit");
    expect(q.findItemById(2)?.logicalSequence).toBe(2);
  } finally { resource.close(); }
});

import { afterEach, describe, expect, test } from "bun:test";
import { createAdminResponseRepository } from "../src/db/admin-response-repository";
import { createQueueRepository } from "../src/db/repositories";
import { createInstagramFeedback, type InstagramProgress } from "../src/services/instagram-feedback";
import { asChatId, asMessageId } from "../src/types";
import { snapshotFixture } from "./fixtures";
import { createTestDatabase } from "./support";

const resources: Array<{ close(): void }> = [];
afterEach(() => { while (resources.length) resources.pop()!.close(); });
const open = () => {
  const resource = createTestDatabase("instagram-feedback"); resources.push(resource);
  const responses = createAdminResponseRepository(resource.database);
  const queue = createQueueRepository(resource.database);
  queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-1001234567890), messageId: asMessageId(100) }), 1_000, "copy", 1_000);
  const report = createInstagramFeedback({ responses, queue, adminUserId: 42, queueChannelId: asChatId(-1001234567890), now: () => 2_000 });
  const rows = () => resource.database.raw.query("SELECT admin_chat_id, dedupe_key, descriptor_json FROM admin_response_outbox ORDER BY created_at, rowid").all() as Array<{ admin_chat_id: number; dedupe_key: string; descriptor_json: string }>;
  return { ...resource, responses, queue, report, rows };
};
const progress = (phase: InstagramProgress["phase"], extra: Partial<InstagramProgress> = {}): InstagramProgress => ({ itemId: 1, operationId: "prep-1", phase, ...extra });

describe("Instagram private progress feedback", () => {
  test("sends only to admin, coalesces pending stages and links the current queue source", () => {
    const h = open();
    h.report(progress("downloading")); h.report(progress("uploading")); h.report(progress("ready")); h.report(progress("ready"));
    expect(h.rows()).toHaveLength(1);
    const row = h.rows()[0]!;
    expect(row.admin_chat_id).toBe(42);
    const descriptor = JSON.parse(row.descriptor_json);
    expect(descriptor.text).toContain("waiting for publication");
    expect(descriptor.text).toContain("https://t.me/c/1234567890/100");
    expect(descriptor.disableLinkPreview).toBe(true);
    expect(descriptor.replyMarkup.rows[0].map((button: { action: string }) => button.action)).toEqual(["queue_item", "logs"]);
  });

  test("retains delivered progress and queues later stages independently", () => {
    const h = open(); h.report(progress("downloading"));
    const claimed = h.responses.claimDue(2_000, "boot")!;
    h.responses.markSentWithAcknowledgement(claimed.id, claimed.claimToken!, 700, 2_000, () => {});
    h.report(progress("uploading"));
    expect(h.rows()).toHaveLength(2);
    h.report(progress("downloading"));
    expect(h.rows()).toHaveLength(2);
  });

  test.each(["failed", "uncertain", "cancelled"] as const)("explains %s with review controls and sanitized diagnostics", (phase) => {
    const h = open(); h.report(progress(phase, { reason: "Upload failed https://cdn.example/video?secret=hidden 123456789:abcdefghijklmnopqrstuvwxyz_0123456789" }));
    const descriptor = JSON.parse(h.rows()[0]!.descriptor_json);
    expect(descriptor.text).toContain("/queue");
    expect(descriptor.text).toContain("[redacted]");
    expect(descriptor.text).not.toContain("hidden");
    expect(descriptor.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    if (phase === "uncertain") expect(descriptor.text).toContain("before retrying");
  });

  test("shows retry time and bounds long errors without losing stage or buttons", () => {
    const h = open(); h.report(progress("retry", { retryAt: 60_000, reason: "x".repeat(20_000) }));
    const descriptor = JSON.parse(h.rows()[0]!.descriptor_json);
    expect(descriptor.text).toContain("1970-01-01T00:01:00.000Z");
    expect(descriptor.text.length).toBeLessThan(3500);
    expect(descriptor.replyMarkup.rows[0]).toHaveLength(2);
  });

  test("handles removed items without a stale queue-item callback", () => {
    const h = open(); h.report(progress("cancelled", { itemId: 999 }));
    const descriptor = JSON.parse(h.rows()[0]!.descriptor_json);
    expect(descriptor.replyMarkup.rows[0]).toEqual([{ text: "Logs", action: "logs", payload: {} }]);
    expect(descriptor.text).not.toContain("Queue source:");
  });
});

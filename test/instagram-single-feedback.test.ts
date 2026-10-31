import { afterEach, describe, expect, test } from "bun:test";
import { createInstagramFeedbackRepository } from "../src/db/instagram-feedback-repository";
import { createQueueRepository } from "../src/db/repositories";
import { createInstagramFeedback, type InstagramProgress } from "../src/services/instagram-feedback";
import { asChatId, asMessageId } from "../src/types";
import { snapshotFixture } from "./fixtures";
import { createTestDatabase } from "./support";

const resources: Array<{ close(): void }> = [];
afterEach(() => { while (resources.length) resources.pop()!.close(); });
const open = () => {
  const resource = createTestDatabase("instagram-feedback"); resources.push(resource);
  const feedback = createInstagramFeedbackRepository(resource.database);
  const queue = createQueueRepository(resource.database);
  queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-1001234567890), messageId: asMessageId(100) }), 1_000, "copy", 1_000);
  const report = createInstagramFeedback({ feedback, queue, adminUserId: 42, queueChannelId: asChatId(-1001234567890), now: () => 2_000 });
  const claim = () => feedback.claim(2_000, "boot");
  return { ...resource, feedback, queue, report, claim };
};
const progress = (phase: InstagramProgress["phase"], extra: Partial<InstagramProgress> = {}): InstagramProgress => ({ itemId: 1, operationId: "prep-1", phase, ...extra });

describe("Instagram private progress feedback", () => {
  test("sends latest pending stage to admin with current queue link and review buttons", () => {
    const h = open(); h.report(progress("downloading")); h.report(progress("uploading"));
    const claim = h.claim()!;
    expect(claim.action).toBe("send"); expect(claim.adminChatId).toBe(42);
    expect(claim.text).toContain("Uploading");
    expect(claim.text).toContain("https://t.me/c/1234567890/100");
    expect(claim.replyMarkup).toMatchObject({ kind: "inline_keyboard", rows: [[{ action: "queue_item" }, { action: "logs" }]] });
    expect(h.claim()).toBeUndefined();
  });

  test("edits the initial message for later stages and deletes it on success", () => {
    const h = open(); h.report(progress("downloading"));
    const send = h.claim()!; expect(h.feedback.begin(send, 2_000)).toBe(true); h.feedback.complete(send, 700, 2_000);
    h.report(progress("uploading"));
    const edit = h.claim()!;
    expect(edit).toMatchObject({ action: "edit", messageId: 700 });
    h.feedback.begin(edit, 2_000); h.feedback.complete(edit, 700, 2_000);
    h.report(progress("ready"));
    const deletion = h.claim()!;
    expect(deletion).toMatchObject({ action: "delete", messageId: 700 });
    h.feedback.begin(deletion, 2_000); h.feedback.complete(deletion, undefined, 2_000);
    h.report(progress("ready")); expect(h.claim()).toBeUndefined();
    expect((h.database.raw.query("SELECT COUNT(*) AS count FROM admin_response_outbox").get() as { count: number }).count).toBe(0);
  });

  test("success before delivery produces no status message", () => {
    const h = open(); h.report(progress("downloading")); h.report(progress("ready"));
    expect(h.claim()).toBeUndefined();
  });

  test.each(["failed", "uncertain", "cancelled"] as const)("keeps %s visible with sanitized diagnostics", (phase) => {
    const h = open(); h.report(progress(phase, { reason: "Upload failed https://cdn.example/video?secret=hidden 123456789:abcdefghijklmnopqrstuvwxyz_0123456789" }));
    const claim = h.claim()!;
    expect(claim.text).toContain("/queue"); expect(claim.text).toContain("[redacted]");
    expect(claim.text).not.toContain("hidden"); expect(claim.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    if (phase === "uncertain") expect(claim.text).toContain("before retrying");
    h.feedback.begin(claim, 2_000); h.feedback.complete(claim, 700, 2_000);
    expect(h.claim()).toBeUndefined();
  });

  test("shows retry time and bounds long errors without losing buttons", () => {
    const h = open(); h.report(progress("retry", { retryAt: 60_000, reason: "x".repeat(20_000) }));
    const claim = h.claim()!;
    expect(claim.text).toContain("1970-01-01T00:01:00.000Z"); expect(claim.text.length).toBeLessThan(3500);
    expect(claim.replyMarkup).toMatchObject({ kind: "inline_keyboard", rows: [[{ action: "queue_item" }, { action: "logs" }]] });
  });

  test("handles removed items without a stale queue-item callback", () => {
    const h = open(); h.report(progress("cancelled", { itemId: 999 }));
    const claim = h.claim()!;
    expect(claim.replyMarkup).toEqual({ kind: "inline_keyboard", rows: [[{ text: "Logs", action: "logs", payload: {} }]] });
    expect(claim.text).not.toContain("Queue source:");
  });
});

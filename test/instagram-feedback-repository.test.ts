import { afterEach, describe, expect, test } from "bun:test";
import { createDatabase } from "../src/db/database";
import { createInstagramFeedbackRepository } from "../src/db/instagram-feedback-repository";
import { createPreparationRepository } from "../src/db/preparation-repository";
import { createQueueRepository } from "../src/db/repositories";
import type { InstagramProgress } from "../src/services/instagram-feedback";
import { createTestDatabase, type TestDatabase } from "./support";
import { snapshotFixture } from "./fixtures";

const resources: TestDatabase[] = [];
afterEach(() => { for (const fixture of resources.splice(0)) fixture.close(); });
const open = () => {
  const fixture = createTestDatabase("instagram-feedback-");
  resources.push(fixture);
  const repo = createInstagramFeedbackRepository(fixture.database);
  const update = (phase: InstagramProgress["phase"], operationId = "op1", text = phase) => repo.update({ itemId: 1, adminChatId: 123, operationId, phase, text, now: 1_000 });
  return { fixture, repo, update };
};

describe("durable Instagram progress message", () => {
  test("sends once, edits same ID, deletes on success, retains terminal tombstone", () => {
    const { repo, update } = open();
    update("downloading");
    const initial = repo.claim(1_000, "boot")!;
    expect(initial.action).toBe("send");
    expect(repo.claim(1_000, "other")).toBeUndefined();
    expect(repo.begin(initial, 1_001)).toBe(true);
    expect(repo.begin(initial, 1_001)).toBe(false);
    repo.complete(initial, 22, 1_002);
    update("uploading");
    const edit = repo.claim(1_003, "boot")!;
    expect(edit).toMatchObject({ action: "edit", messageId: 22 });
    repo.begin(edit, 1_004);
    repo.complete(edit, undefined, 1_005);
    update("ready");
    const deletion = repo.claim(1_006, "boot")!;
    expect(deletion).toMatchObject({ action: "delete", messageId: 22 });
    repo.begin(deletion, 1_007);
    repo.complete(deletion, undefined, 1_008);
    update("ready");
    update("uploading");
    expect(repo.claim(1_009, "boot")).toBeUndefined();
  });

  test("coalesces duplicate updates and preserves claim snapshot when desired status changes", () => {
    const { repo, update } = open();
    update("downloading");
    update("downloading");
    const initial = repo.claim(1_000, "boot")!;
    expect(initial.revision).toBe(1);
    repo.begin(initial, 1_001);
    update("uploading");
    expect(initial.phase).toBe("downloading");
    repo.complete(initial, 24, 1_002);
    const next = repo.claim(1_003, "boot")!;
    expect(next).toMatchObject({ action: "edit", messageId: 24, revision: 2, phase: "uploading" });
    // A delayed stale completion must not erase the new claim.
    repo.complete(initial, 99, 1_004);
    expect(repo.begin(next, 1_005)).toBe(true);
  });

  test("success before send requires no PM, including an already claimed unsent snapshot", () => {
    const { repo, update } = open();
    update("ready");
    expect(repo.claim(1_000, "boot")).toBeUndefined();
    update("downloading", "op2");
    const unsent = repo.claim(1_000, "boot")!;
    update("ready", "op2");
    expect(repo.begin(unsent, 1_001)).toBe(false);
    expect(repo.claim(1_001, "boot")).toBeUndefined();
  });

  test("success racing initial send schedules deletion after the accepted message ID is recorded", () => {
    const { repo, update } = open();
    update("downloading");
    const initial = repo.claim(1_000, "boot")!;
    repo.begin(initial, 1_001);
    update("ready");
    repo.complete(initial, 25, 1_002);
    expect(repo.claim(1_003, "boot")).toMatchObject({ action: "delete", messageId: 25 });
  });

  test("persists known message ID across restart and replays interrupted edits idempotently", () => {
    const { repo, update, fixture } = open();
    update("downloading");
    const initial = repo.claim(1_000, "old")!;
    repo.begin(initial, 1_001);
    repo.complete(initial, 26, 1_002);
    update("uploading");
    const edit = repo.claim(1_003, "old")!;
    repo.begin(edit, 1_004);
    const restartedDatabase = createDatabase(fixture.path);
    try {
      const restarted = createInstagramFeedbackRepository(restartedDatabase);
      restarted.recover(1_005, "new");
      const replay = restarted.claim(1_005, "new")!;
      expect(replay).toMatchObject({ action: "edit", messageId: 26 });
      expect(replay.token).not.toBe(edit.token);
      expect(restarted.begin(edit, 1_006)).toBe(false);
      restarted.begin(replay, 1_006);
      restarted.complete(replay, undefined, 1_007);
      expect(restarted.claim(1_008, "new")).toBeUndefined();
    } finally { restartedDatabase.close(); }
  });

  test("unknown initial send stays uncertain across new updates, new operations and restarts", () => {
    const { repo, update } = open();
    update("downloading");
    const initial = repo.claim(1_000, "old")!;
    repo.begin(initial, 1_001);
    repo.recover(1_002, "new");
    update("uploading");
    update("ready");
    update("downloading", "op2");
    repo.recover(100_000, "third");
    expect(repo.claim(100_000, "third")).toBeUndefined();
    repo.complete(initial, 30, 100_001);
    expect(repo.claim(100_001, "third")).toBeUndefined();
  });

  test("new operations reuse status ID while delayed previous operation updates are ignored", () => {
    const { repo, update } = open();
    update("failed");
    const initial = repo.claim(1_000, "boot")!;
    repo.begin(initial, 1_001);
    repo.complete(initial, 27, 1_002);
    update("downloading", "op2");
    update("ready", "op1");
    expect(repo.claim(1_003, "boot")).toMatchObject({ operationId: "op2", phase: "downloading", action: "edit", messageId: 27 });
  });

  test("retry defers safe rejections, crash before begin is safe, and failed send remains uncertain", () => {
    const { repo, update } = open();
    update("downloading");
    const abandoned = repo.claim(1_000, "old")!;
    repo.recover(1_001, "new");
    expect(repo.begin(abandoned, 1_002)).toBe(false);
    const retryable = repo.claim(1_002, "new")!;
    repo.begin(retryable, 1_003);
    repo.retry(retryable, 2_000, "flood_wait", 1_004);
    expect(repo.claim(1_999, "new")).toBeUndefined();
    const failed = repo.claim(2_000, "new")!;
    repo.begin(failed, 2_001);
    repo.fail(failed, "network", 2_002);
    update("uploading");
    expect(repo.claim(2_003, "new")).toBeUndefined();
  });

  test("validates and snapshots optional keyboard, rejects invalid input", () => {
    const { repo } = open();
    const markup = { kind: "inline_keyboard" as const, rows: [[{ text: "Logs", action: "logs", payload: {} }]] };
    const input = { itemId: 1, adminChatId: 123, operationId: "op", phase: "failed" as const, text: "Failed", now: 1_000, replyMarkup: markup };
    repo.update(input);
    markup.rows[0]![0]!.text = "Changed";
    expect(repo.claim(1_000, "boot")?.replyMarkup).toEqual({ kind: "inline_keyboard", rows: [[{ text: "Logs", action: "logs", payload: {} }]] });
    expect(() => repo.update({ ...input, itemId: -1 })).toThrow();
    expect(() => repo.update({ ...input, replyMarkup: { kind: "force_reply", placeholder: 4 } as never })).toThrow();
  });

  test("same-boot active leases remain owned and expired claims before send can be recovered", () => {
    const { repo, update } = open();
    update("downloading");
    const first = repo.claim(1_000, "boot")!;
    repo.recover(2_000, "boot");
    expect(repo.claim(2_000, "boot")).toBeUndefined();
    repo.recover(61_000, "boot");
    expect(repo.begin(first, 61_001)).toBe(false);
    expect(repo.claim(61_001, "boot")?.action).toBe("send");
  });

  test("new desired success survives failed edit and interrupted delete", () => {
    const { repo, update } = open();
    update("downloading");
    const initial = repo.claim(1_000, "boot")!;
    repo.begin(initial, 1_001);
    repo.complete(initial, 29, 1_002);
    update("uploading");
    const edit = repo.claim(1_003, "boot")!;
    repo.begin(edit, 1_004);
    update("ready");
    repo.fail(edit, "edit_failed", 1_005);
    const deletion = repo.claim(1_006, "boot")!;
    expect(deletion.action).toBe("delete");
    repo.begin(deletion, 1_007);
    repo.recover(1_008, "new");
    const replay = repo.claim(1_009, "new")!;
    expect(replay).toMatchObject({ action: "delete", messageId: 29 });
    repo.begin(replay, 1_010);
    repo.complete(replay, undefined, 1_011);
    expect(repo.claim(1_012, "new")).toBeUndefined();
  });

  test("handles issue alerts only for a viable error notice from the matching content revision", () => {
    const { repo, update, fixture } = open();
    const queue = createQueueRepository(fixture.database);
    queue.observeQueueSnapshot(snapshotFixture(), 1_000, "copy", 900);
    const preparation = createPreparationRepository(fixture.database, { operationId: () => "op1" });
    const preparationClaim = preparation.claimNextPreparation(1_001, "boot")!;
    expect(preparationClaim.guard.capturedContentVersion).toBe(1);
    expect(repo.handlesIssue(1, 1)).toBe(false);
    update("downloading");
    expect(repo.handlesIssue(1, 1)).toBe(false);
    update("uploading");
    expect(repo.handlesIssue(1, 1)).toBe(false);
    update("failed");
    expect(repo.handlesIssue(1, 1)).toBe(true);
    expect(repo.handlesIssue(1, 2)).toBe(false);
    expect(repo.handlesIssue(2, 1)).toBe(false);
    const notice = repo.claim(1_002, "boot")!;
    expect(repo.handlesIssue(1, 1)).toBe(true);
    repo.begin(notice, 1_003);
    repo.complete(notice, 55, 1_004);
    expect(repo.handlesIssue(1, 1)).toBe(true);
    update("uncertain");
    expect(repo.handlesIssue(1, 1)).toBe(true);
    const edit = repo.claim(1_005, "boot")!;
    repo.begin(edit, 1_006);
    repo.fail(edit, "permission_denied", 1_007);
    expect(repo.handlesIssue(1, 1)).toBe(false);
    update("cancelled");
    expect(repo.handlesIssue(1, 1)).toBe(true);
    update("ready");
    expect(repo.handlesIssue(1, 1)).toBe(false);
  });

  test("unknown initial delivery and unassociated operation retain ordinary issue alerts", () => {
    const { repo, update, fixture } = open();
    createQueueRepository(fixture.database).observeQueueSnapshot(snapshotFixture(), 1_000, "copy", 900);
    createPreparationRepository(fixture.database, { operationId: () => "op1" }).claimNextPreparation(1_001, "boot");
    update("failed", "unassociated-operation");
    expect(repo.handlesIssue(1, 1)).toBe(false);
    update("failed", "op1");
    expect(repo.handlesIssue(1, 1)).toBe(true);
    const notice = repo.claim(1_002, "boot")!;
    repo.begin(notice, 1_003);
    repo.fail(notice, "network", 1_004);
    expect(repo.handlesIssue(1, 1)).toBe(false);
  });
});

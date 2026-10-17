import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createOrphanRepository } from "../src/db/orphan-repository";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository, createScheduleRepository } from "../src/db/repositories";
import { createPendingUpdateRepository } from "../src/db/pending-update-repository";
import { createIngestionService } from "../src/services/ingestion";
import { createAlertService, resolutionTextForDedupeKey } from "../src/services/alerts";
import { createSchedulerService } from "../src/services/scheduler";
import { abortableSleep, createOperationTracker, createTaskSupervisor } from "../src/services/task-supervisor";
import { createFakeClock } from "../src/clock";
import type { Logger } from "../src/logger";
import type { TelegramGateway } from "../src/telegram";
import type { PublicationOutcome } from "../src/services/publisher";
import { asChatId, asMessageId, asUserId, type MessageId } from "../src/types";
import { snapshotFixture } from "./fixtures";

const resources: Array<{ directory: string; close(): void }> = [];

const loggerSpy = (): { logger: Logger; events: string[] } => {
  const events: string[] = [];
  const logger: Logger = {
    debug: (event) => events.push(`debug:${event}`),
    info: (event) => events.push(`info:${event}`),
    warn: (event) => events.push(`warn:${event}`),
    error: (event) => events.push(`error:${event}`),
  };
  return { logger, events };
};

const openDatabase = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), `queuebot-${prefix}-`));
  const database = createDatabase(join(directory, "bot.sqlite"));
  resources.push({ directory, close: database.close });
  return { database, directory };
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("alert service failure matrix", () => {
  test("renders every dynamic resolution key", () => {
    const expectedKeys = [
      "uncertain_publish:4", "uncertain_renewal:4", "blocked_head:4", "needs_edit:4", "needs_review:4",
      "renewal_warning:4", "renewal_critical:4", "deleted_external:4", "orphan_manual:4:2", "permissions:-100", "renewal_capacity", "other",
    ];
    for (const key of expectedKeys) expect(resolutionTextForDedupeKey(key)).toContain("cleared");
    expect(resolutionTextForDedupeKey("uncertain_publish")).toContain("uncertainty");
  });

  test("does not mark failed deliveries sent and survives mark-sent failures", async () => {
    const { logger, events } = loggerSpy();
    const sent: string[] = [];
    let mode: "delivery" | "mark" | "ok" = "delivery";
    const alert = {
      raise: () => ({ alert: {}, shouldSend: true }),
      markSent: () => { if (mode === "mark") throw new Error("database write failed"); },
      resolve: () => true,
      active: () => [],
      counts: () => ({ active: 0, critical: 0, immediate: 0, normal: 0 }),
    };
    const gateway = { sendAdminMessage: async ({ text }: { text: string }) => { sent.push(text); if (mode === "delivery") throw new Error("network"); return asMessageId(1); } } as unknown as TelegramGateway;
    const service = createAlertService({ alert: alert as never, gateway, adminChatId: asChatId(42), logger });
    await service.raise("key", "immediate", "text", 1);
    expect(sent).toEqual(["[immediate] text"]);
    expect(events).toContain("error:admin_alert_send_failed");
    mode = "mark";
    await service.raise("key", "immediate", "text", 2);
    expect(events).toContain("error:admin_alert_mark_sent_failed");
    mode = "ok";
    await service.resolve("key", "resolved", 3);
    expect(sent.at(-1)).toBe("Resolved: resolved");
  });

  test("skips duplicate raises and unresolved conditions", async () => {
    let raises = 0;
    let resolves = 0;
    const alert = {
      raise: () => { raises += 1; return { alert: {}, shouldSend: false }; },
      markSent: () => {},
      resolve: () => { resolves += 1; return false; },
      active: () => [],
      counts: () => ({ active: 0, critical: 0, immediate: 0, normal: 0 }),
    };
    const gateway = { sendAdminMessage: async () => asMessageId(1) } as unknown as TelegramGateway;
    const service = createAlertService({ alert: alert as never, gateway, adminChatId: asChatId(42), logger: loggerSpy().logger });
    await service.raise("key", "normal", "text", 1);
    await service.resolve("key", "resolved", 2);
    expect(raises).toBe(1);
    expect(resolves).toBe(1);
  });
});

describe("scheduler outcome and loop matrix", () => {
  const outcomes: Array<[PublicationOutcome, string]> = [
    [{ kind: "published", itemId: 1, destinationMessageIds: [asMessageId(2)], operationId: "op" }, "published"],
    [{ kind: "empty" }, "empty"],
    [{ kind: "blocked", itemId: 1, status: "blocked", reason: "manual", operationId: "op" }, "blocked"],
    [{ kind: "cleanup_pending", itemId: 1, operationId: "op" }, "published"],
    [{ kind: "deleted_external", itemId: 1, operationId: "op" }, "failed"],
    [{ kind: "retry_scheduled", itemId: 1, retryAt: Date.parse("2026-10-04T02:00:00Z"), operationId: "op" }, "failed"],
    [{ kind: "uncertain", itemId: 1, operationId: "op" }, "failed"],
    [{ kind: "failed", itemId: 1, status: "queued", error: "error", operationId: "op" }, "failed"],
  ];

  test.each(outcomes)("records %s as %s", async (outcome, expectedStatus) => {
    const { database } = openDatabase("scheduler-matrix");
    const schedule = createScheduleRepository(database);
    const queue = createQueueRepository(database);
    const clock = createFakeClock(Date.parse("2026-10-04T01:02:00Z"));
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(1) }), clock.now());
    queue.claimPublication("op", "publish", clock.now());
    const scheduler = createSchedulerService({ schedule, publisher: { publishNext: async () => outcome }, clock, logger: loggerSpy().logger });
    schedule.addSlot(60, 1, clock.now() - 2 * 86_400_000);
    schedule.setEnabled(true, 1, clock.now());
    schedule.setLastScan(clock.now() - 86_400_000);
    const result = await scheduler.scanOnce();
    expect(result.ran).toBe(true);
    expect(schedule.run(Date.parse("2026-10-04T01:00:00Z"))?.status).toBe(expectedStatus);
  });

  test("handles disabled/no-op scans, manual publication, and concurrent scans", async () => {
    const { database } = openDatabase("scheduler-loop");
    const schedule = createScheduleRepository(database);
    const clock = createFakeClock(Date.parse("2026-10-04T01:02:00Z"));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = createSchedulerService({ schedule, publisher: { publishNext: async () => { await pending; return { kind: "empty" }; } }, clock, logger: loggerSpy().logger });
    expect(await scheduler.scanOnce()).toEqual({ ran: false });
    schedule.addSlot(60, 1, clock.now() - 2 * 86_400_000);
    schedule.setEnabled(true, 1, clock.now());
    schedule.setLastScan(clock.now() - 86_400_000);
    const first = scheduler.scanOnce();
    await Promise.resolve();
    expect(await scheduler.scanOnce()).toEqual({ ran: false });
    release();
    expect((await first).ran).toBe(true);
    expect(scheduler.nextAt()).toBeGreaterThan(clock.now());
    expect((await scheduler.manualPublish()).kind).toBe("empty");
    scheduler.stop();
    const aborted = new AbortController();
    aborted.abort();
    await scheduler.run(aborted.signal);
  });
});

describe("ingestion and orphan repository matrix", () => {
  test("handles channel update/edit branches, late albums, wrong chats, and no pending store", () => {
    const { database } = openDatabase("ingestion-matrix");
    const queue = createQueueRepository(database);
    const logger = loggerSpy();
    let now = 10_000;
    const service = createIngestionService({ queueChannelId: asChatId(-100), queue, policy: createPolicyRepository(database), generated: createGeneratedMessageRepository(database), logger: logger.logger, now: () => now });
    const post = (id: number, chatId = -100, mediaGroupId?: string): never => ({ message_id: id, date: 1, chat: { id: chatId, type: "channel", title: "Queue" }, text: "hello", ...(mediaGroupId === undefined ? {} : { media_group_id: mediaGroupId }) } as never);
    expect(service.handleChannelPost(post(1))).toEqual({ accepted: true, itemId: 1 });
    expect(service.handleChannelPost(post(1))).toMatchObject({ accepted: false, ignoredReason: "duplicate" });
    expect(service.handleChannelPost(post(2, -101))).toEqual({ accepted: false, ignoredReason: "wrong_chat" });
    expect(service.handleEditedChannelPost(post(99))).toEqual({ accepted: false, ignoredReason: "duplicate" });
    expect(service.handleEditedChannelPost(post(1))).toMatchObject({ accepted: true, itemId: 1 });
    expect(service.observe(snapshotFixture({ messageId: asMessageId(10), mediaGroupId: "album" }), now).accepted).toBe(true);
    now += 3_000;
    expect(service.finalizeAlbums()).toEqual([2]);
    expect(service.observe(snapshotFixture({ messageId: asMessageId(11), mediaGroupId: "album" }), now)).toMatchObject({ accepted: true, itemId: 2 });
    expect(logger.events).toContain("warn:late_album_member_requires_review");
  });

  test("maps orphan optional fields and state transitions", () => {
    const { database } = openDatabase("orphan-matrix");
    const queue = createQueueRepository(database);
    const item = queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(20) }), 1).item;
    const orphan = createOrphanRepository(database);
    database.raw.query("INSERT INTO orphaned_sources (item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, attempt_count, next_attempt_at, terminal_reason) VALUES (?, 0, -100, 20, 'network', 1, 2, 0, 10, NULL), (?, 0, -100, 21, 'age', 1, 2, 1, NULL, 'telegram_age_limit')").run(item.id, item.id);
    expect(orphan.due(9)).toHaveLength(0);
    const due = orphan.due(10);
    expect(due[0]).toMatchObject({ messageId: 20, nextAttemptAt: 10 });
    expect(orphan.terminal()[0]).toMatchObject({ messageId: 21, terminalReason: "telegram_age_limit" });
    expect(orphan.counts()).toMatchObject({ unresolved: 1, terminal: 1 });
    orphan.markAttempt(due[0]!, 10, 20);
    orphan.resolve(due[0]!, 21);
    orphan.markTerminal(orphan.terminal()[0]!, 22, "manual");
    expect(orphan.counts().unresolved).toBe(0);
  });
});

describe("task supervisor and operation tracker matrix", () => {
  test("handles abortable sleep and operation ownership boundaries", async () => {
    const clock = createFakeClock(0);
    const aborted = new AbortController();
    aborted.abort();
    await abortableSleep(clock, 100, aborted.signal);
    expect(clock.now()).toBe(0);
    const tracker = createOperationTracker();
    const finish = tracker.begin("op");
    finish();
    finish();
    expect(await tracker.waitForEmpty(20)).toBe(true);
    tracker.stopAccepting();
    expect(() => tracker.begin("late")).toThrow(/stopping/);
  });

  test("deduplicates task names, stops idempotently, and records task failures", async () => {
    const logger = loggerSpy();
    const supervisor = createTaskSupervisor({ logger: logger.logger });
    let runs = 0;
    supervisor.start("same", async () => { runs += 1; supervisor.requestStop(); });
    supervisor.start("same", async () => { runs += 100; });
    expect(await supervisor.stopAndDrain(100)).toBe(true);
    expect(await supervisor.stopAndDrain(100)).toBe(true);
    expect(runs).toBe(1);
    expect(supervisor.names()).toEqual([]);
    expect(() => supervisor.start("late", async () => {})).not.toThrow();
    expect(logger.events).toEqual([]);
  });

  test("restarts a rejected task once and aborts its backoff without blocking shutdown", async () => {
    const logger = loggerSpy();
    const supervisor = createTaskSupervisor({ logger: logger.logger });
    let attempts = 0;
    supervisor.start("flaky", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("first failure");
      supervisor.requestStop();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await supervisor.stopAndDrain(100)).toBe(true);
    expect(attempts).toBe(1);
    expect(logger.events).toContain("error:supervised_task_failed");
  });
});

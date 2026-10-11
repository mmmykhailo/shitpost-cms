import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createAlertRepository } from "../src/db/alert-repository";
import { createDatabase, type AppDatabase } from "../src/db/database";
import { createOrphanRepository } from "../src/db/orphan-repository";
import { createPendingUpdateRepository } from "../src/db/pending-update-repository";
import { createPolicyRepository, createQueueRepository, createScheduleRepository } from "../src/db/repositories";
import { createHealthService } from "../src/services/health";
import { asChatId, asMessageId } from "../src/types";
import { snapshotFixture } from "./fixtures";

describe("health service", () => {
  test("reports durable queue, lease, schedule, operation, orphan, and alert state", () => {
    const directory = mkdtempSync(join(tmpdir(), "shitpost-cms-health-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    try {
      const now = 1_800_000_000_000;
      const queue = createQueueRepository(database, { bootId: "health-boot" });
      const policy = createPolicyRepository(database);
      const schedule = createScheduleRepository(database);
      const pending = createPendingUpdateRepository(database);
      const orphan = createOrphanRepository(database);
      const alerts = createAlertRepository(database);
      const item = queue.observeQueueSnapshot(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(10), telegramDate: now - 10_000 }), now - 9_000).item;
      policy.observeAuthor({ kind: "user", userId: 7 as never, displayName: "Ada", username: "ada" }, now);
      schedule.addSlot(60, 42, now - 1_000);
      schedule.setEnabled(true, 42, now - 500);
      schedule.setLastScan(now - 100);
      pending.upsert(snapshotFixture({ chatId: asChatId(-100), messageId: asMessageId(11) }), now - 100, now - 50);
      pending.markState(-100, 11, "ingested", now);
      database.raw.query("UPDATE queue_items SET maintenance_retry_not_before = ? WHERE id = ?").run(now + 5_000, item.id);
      database.raw.query("INSERT INTO operations (id, type, item_id, state, captured_content_version, captured_source_generation, created_at, updated_at, phase) VALUES (?, 'publish', ?, 'done', 1, 0, ?, ?, 'completed')").run("health-operation", item.id, now - 2_000, now - 1_000);
      database.raw.query("INSERT INTO orphaned_sources (item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, attempt_count, next_attempt_at, terminal_reason) VALUES (?, 0, -100, 99, 'age_limit', ?, ?, 1, NULL, 'telegram_age_limit')").run(item.id, now - 20_000, now - 10_000);
      alerts.raise("health-alert", "critical", now - 500);

      const service = createHealthService({
        database,
        queue,
        schedule,
        pending,
        orphan,
        alerts,
        now: () => now,
        ownsLease: () => true,
        bootStartedAt: now - 20_000,
        lastRightsCheckAt: () => now - 100,
        lastBackupAt: () => now - 200,
        rights: () => ({ queue: { status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: false }, target: { status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true } }),
      });
      const snapshot = service.snapshot();
      expect(snapshot).toMatchObject({ databaseOk: true, leaseOwned: true, bootId: null, uptimeMs: 20_000, queueHead: item.id, lastSchedulerScanAt: now - 100, activeOperations: 0, uncertainOperations: 0, lastOperation: { type: "publish", phase: "completed", updatedAt: now - 1_000 } });
      expect(snapshot.queueCounts.queued).toBe(1);
      expect(snapshot.pendingUpdates.ingested).toBe(1);
      expect(snapshot.orphanCounts.terminal).toBe(1);
      expect(snapshot.alerts.critical).toBe(1);
      expect(snapshot.nextSlotAt).toBeDefined();
      expect(snapshot.renewalCapacity.totalMessages).toBe(1);
      expect(snapshot.rights?.target.canEditMessages).toBe(true);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when the database quick check throws and handles empty optional state", () => {
    const database = {
      raw: { query: (sql: string) => { if (sql === "PRAGMA quick_check") throw new Error("closed"); return { get: () => ({ retry_at: null, current_boot_id: null, created_at: 1, last_clean_shutdown_at: null, last_scheduler_scan_at: null, last_successful_update_at: null, active: null, uncertain: null }), all: () => [] }; } },
    } as unknown as AppDatabase;
    const empty = {
      listActive: () => [], listRenewalAges: () => [], statusCounts: () => ({}), getHead: () => undefined,
    } as never;
    const service = createHealthService({ database, queue: empty, schedule: { enabled: () => false } as never, pending: { countByState: () => ({}) } as never, orphan: { counts: () => ({ unresolved: 0, terminal: 0 }) } as never, alerts: { counts: () => ({ active: 0, critical: 0, immediate: 0, normal: 0 }) } as never, now: () => 1000 });
    const snapshot = service.snapshot();
    expect(snapshot.databaseOk).toBe(false);
    expect(snapshot.nextSlotAt).toBeUndefined();
    expect(snapshot.queueHead).toBeUndefined();
  });
});

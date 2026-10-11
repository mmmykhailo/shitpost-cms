import type { AppDatabase } from "../db/database";
import type { AlertRepository } from "../db/alert-repository";
import type { OrphanRepository } from "../db/orphan-repository";
import type { PendingUpdateRepository } from "../db/pending-update-repository";
import type { QueueRepository, ScheduleRepository } from "../db/repositories";
import { nextOccurrence } from "../domain/schedule";
import { calculateRenewalCapacity, type RenewalCapacity } from "./capacity";

export type HealthService = ReturnType<typeof createHealthService>;

export const createHealthService = (input: {
  database: AppDatabase;
  queue: QueueRepository;
  schedule: ScheduleRepository;
  pending: PendingUpdateRepository;
  orphan: OrphanRepository;
  alerts: AlertRepository;
  now: () => number;
  ownsLease?: () => boolean;
}) => {
  const snapshot = () => {
    const now = input.now();
    let databaseOk = false;
    try {
      const row = input.database.raw.query("PRAGMA quick_check").get() as { quick_check: string } | null;
      databaseOk = row?.quick_check === "ok";
    } catch {
      databaseOk = false;
    }
    const active = input.queue.listActive(10_000);
    const physicalAges = input.queue.listRenewalAges(now);
    const oldestLogical = active.reduce<number | undefined>((oldest, item) => oldest === undefined ? now - item.enqueuedAt : Math.max(oldest, now - item.enqueuedAt), undefined);
    const oldestPhysical = physicalAges.reduce<number | undefined>((oldest, item) => oldest === undefined ? item.ageMs : Math.max(oldest, item.ageMs), undefined);
    const sources = physicalAges.map((entry) => ({ itemId: entry.item.id, physicalCreatedAt: entry.item.physicalCreatedAt, memberCount: entry.sourceIds.length }));
    const capacity: RenewalCapacity = calculateRenewalCapacity({ now, sources });
    const app = input.database.raw.query("SELECT current_boot_id, created_at, last_clean_shutdown_at, last_scheduler_scan_at, last_successful_update_at FROM app_state WHERE id = 1").get() as { current_boot_id: string | null; created_at: number; last_clean_shutdown_at: number | null; last_scheduler_scan_at: number | null; last_successful_update_at: number | null };
    const operations = input.database.raw.query("SELECT COUNT(*) AS active, SUM(CASE WHEN phase = 'uncertain' THEN 1 ELSE 0 END) AS uncertain FROM operations WHERE state NOT IN ('done','failed')").get() as { active: number | null; uncertain: number | null };
    const lastOperation = input.database.raw.query("SELECT type, phase, updated_at FROM operations WHERE state IN ('done','failed') ORDER BY updated_at DESC LIMIT 1").get() as { type: string; phase: string; updated_at: number } | null;
    return {
      bootId: app.current_boot_id,
      uptimeMs: Math.max(0, now - app.created_at),
      leaseOwned: input.ownsLease?.() ?? false,
      databaseOk,
      lastCleanShutdownAt: app.last_clean_shutdown_at,
      lastSuccessfulUpdateAt: app.last_successful_update_at,
      queueCounts: input.queue.statusCounts(),
      queueHead: input.queue.getHead()?.id,
      oldestLogicalAgeMs: oldestLogical,
      oldestPhysicalAgeMs: oldestPhysical,
      nextSlotAt: input.schedule.enabled() ? nextOccurrence(now, input.schedule.slots()) : undefined,
      lastSchedulerScanAt: app.last_scheduler_scan_at,
      activeOperations: operations.active ?? 0,
      uncertainOperations: operations.uncertain ?? 0,
      pendingUpdates: input.pending.countByState(),
      orphanCounts: input.orphan.counts(),
      renewalCapacity: capacity,
      lastOperation: lastOperation ? { type: lastOperation.type, phase: lastOperation.phase, updatedAt: lastOperation.updated_at } : undefined,
      alerts: input.alerts.counts(),
    };
  };

  return { snapshot };
};

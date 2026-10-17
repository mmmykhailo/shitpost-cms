import type { AppDatabase } from "../db/database";
import type { AlertRepository } from "../db/alert-repository";
import type { OrphanRepository } from "../db/orphan-repository";
import type { PendingUpdateRepository } from "../db/pending-update-repository";
import type { QueueRepository, ScheduleRepository } from "../db/repositories";
import { nextOccurrence } from "../domain/schedule";
import { calculateRenewalCapacity, type RenewalCapacity } from "./capacity";
import type { BotMembership } from "../telegram";
import type { TelegramCooldown } from "../telegram-cooldown";
import type { AdminResponseRepository } from "../db/admin-response-repository";
import type { AdminUpdateRepository } from "../db/admin-update-repository";
import type { TelegramIncidentRepository } from "../db/telegram-incident-repository";

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
  bootStartedAt?: number;
  lastRightsCheckAt?: () => number | undefined;
  lastBackupAt?: () => number | undefined;
  rights?: () => { queue: BotMembership; target: BotMembership } | undefined;
  cooldown?: Pick<TelegramCooldown, "notBefore">;
  responses?: AdminResponseRepository;
  adminUpdates?: AdminUpdateRepository;
  incidents?: TelegramIncidentRepository;
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
    const sources = physicalAges.map((entry) => ({
      itemId: entry.item.id,
      logicalSequence: entry.item.logicalSequence,
      physicalCreatedAt: entry.item.physicalCreatedAt,
      memberCount: entry.sourceIds.length,
      maintenanceStatus: entry.item.maintenanceStatus,
      queueStatus: entry.item.status,
      ...(entry.item.maintenanceRetryNotBefore === undefined ? {} : { maintenanceRetryNotBefore: entry.item.maintenanceRetryNotBefore }),
    }));
    const cooldownUntil = input.cooldown?.notBefore();
    const capacity: RenewalCapacity = calculateRenewalCapacity({ now, sources, ...(cooldownUntil === undefined ? {} : { cooldownUntil }) });
    const app = input.database.raw.query("SELECT current_boot_id, created_at, last_clean_shutdown_at, last_scheduler_scan_at, last_successful_update_at FROM app_state WHERE id = 1").get() as { current_boot_id: string | null; created_at: number; last_clean_shutdown_at: number | null; last_scheduler_scan_at: number | null; last_successful_update_at: number | null };
    const operations = input.database.raw.query("SELECT COUNT(*) AS active, SUM(CASE WHEN phase = 'uncertain' THEN 1 ELSE 0 END) AS uncertain FROM operations WHERE state NOT IN ('done','failed')").get() as { active: number | null; uncertain: number | null };
    const preparations = input.database.raw.query("SELECT COUNT(*) AS active, SUM(CASE WHEN state = 'uncertain' THEN 1 ELSE 0 END) AS uncertain FROM queue_preparation_operations WHERE state NOT IN ('done','failed')").get() as { active: number | null; uncertain: number | null };
    const lastOperation = input.database.raw.query("SELECT type, phase, updated_at FROM operations WHERE state IN ('done','failed') ORDER BY updated_at DESC LIMIT 1").get() as { type: string; phase: string; updated_at: number } | null;
    const frozen = input.database.raw.query("SELECT editorial_freeze_reason AS reason, COUNT(*) AS count FROM queue_items WHERE editorial_frozen_at IS NOT NULL AND status NOT IN ('deleted','published') GROUP BY editorial_freeze_reason").all() as Array<{ reason: string | null; count: number }>;
    const retry = input.database.raw.query("SELECT occurrence_at, retry_not_before, retry_deadline_at, attempt_count FROM schedule_runs WHERE status = 'pending' AND cancelled_at IS NULL AND retry_deadline_at > ? ORDER BY COALESCE(retry_not_before, occurrence_at), occurrence_at LIMIT 1").get(now) as { occurrence_at: number; retry_not_before: number | null; retry_deadline_at: number | null; attempt_count: number } | null;
    const editCollisions = input.database.raw.query("SELECT COUNT(*) AS count FROM queue_items WHERE last_error_code = 'admin_edit_collision' AND status = 'needs_review'").get() as { count: number };
    const currentIncident = input.incidents?.snapshot();
    return {
      bootId: app.current_boot_id,
      uptimeMs: Math.max(0, now - (input.bootStartedAt ?? app.created_at)),
      leaseOwned: input.ownsLease?.() ?? false,
      databaseOk,
      lastCleanShutdownAt: app.last_clean_shutdown_at,
      lastSuccessfulUpdateAt: app.last_successful_update_at,
      lastRightsCheckAt: input.lastRightsCheckAt?.(),
      rights: input.rights?.(),
      lastBackupAt: input.lastBackupAt?.(),
      queueCounts: input.queue.statusCounts(),
      queueHead: input.queue.getHead()?.id,
      oldestLogicalAgeMs: oldestLogical,
      oldestPhysicalAgeMs: oldestPhysical,
      nextSlotAt: input.schedule.enabled() ? nextOccurrence(now, input.schedule.slots()) : undefined,
      lastSchedulerScanAt: app.last_scheduler_scan_at,
      activeOperations: (operations.active ?? 0) + (preparations.active ?? 0),
      uncertainOperations: (operations.uncertain ?? 0) + (preparations.uncertain ?? 0),
      pendingUpdates: input.pending.countByState(),
      orphanCounts: input.orphan.counts(),
      renewalCapacity: capacity,
      lastOperation: lastOperation ? { type: lastOperation.type, phase: lastOperation.phase, updatedAt: lastOperation.updated_at } : undefined,
      alerts: input.alerts.counts(),
      sharedCooldown: { notBefore: cooldownUntil ?? 0, remainingMs: Math.max(0, (cooldownUntil ?? 0) - now) },
      floodIncident: currentIncident,
      scheduledRetry: retry === null ? undefined : { occurrenceAt: retry.occurrence_at, retryNotBefore: retry.retry_not_before ?? undefined, deadlineAt: retry.retry_deadline_at ?? undefined, attemptCount: retry.attempt_count },
      adminResponses: input.responses?.counts() ?? { pending: 0, sending: 0, uncertain: 0, failed: 0 },
      adminUpdates: input.adminUpdates?.counts() ?? { active: 0, uncertain: 0 },
      editorialProtection: {
        adminEdit: frozen.find((entry) => entry.reason === "admin_edit")?.count ?? 0,
        adminDelete: frozen.find((entry) => entry.reason === "admin_delete")?.count ?? 0,
        legacyEditEvidence: frozen.find((entry) => entry.reason === "legacy_edit_evidence")?.count ?? 0,
        legacyUnverified: frozen.find((entry) => entry.reason === "legacy_unverified")?.count ?? 0,
        editCollisions: editCollisions.count,
      },
    };
  };

  return { snapshot };
};

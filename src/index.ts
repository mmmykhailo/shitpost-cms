import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Bot } from "grammy";
import { parseConfig } from "./config";
import { createLogger, safeErrorDescription } from "./logger";
import { createDatabase } from "./db/database";
import { createAdminRepository } from "./db/admin-repository";
import { createAlertRepository } from "./db/alert-repository";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository, createScheduleRepository } from "./db/repositories";
import { createPendingUpdateRepository } from "./db/pending-update-repository";
import { createRecoveryRepository } from "./db/recovery-repository";
import { createOrphanRepository } from "./db/orphan-repository";
import { createRuntimeLease } from "./db/runtime";
import { createTelegramGateway, type BotMembership } from "./telegram";
import { createIngestionService } from "./services/ingestion";
import { createPublicationService } from "./services/publisher";
import { createRenewalService } from "./services/renewal";
import { createSchedulerService } from "./services/scheduler";
import { createOrphanCleanupService } from "./services/orphan-cleanup";
import { createAlertService } from "./services/alerts";
import { createHealthService } from "./services/health";
import { createRetentionService } from "./services/retention";
import { createBackupService } from "./services/backup";
import { abortableSleep, createOperationTracker, createTaskSupervisor } from "./services/task-supervisor";
import { registerAdminHandlers } from "./handlers/admin";
import { registerQueueChannelHandlers } from "./handlers/queue-channel";
import { adminChatIdFromUserId, createRecoveryService } from "./services/recovery";
import { systemClock, type UserId } from "./types";

const RENEWAL_INTERVAL_MS = 15 * 60_000;
const RENEWAL_START_AGE_MS = 36 * 60 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

const main = async (): Promise<void> => {
  const config = parseConfig();
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.databasePath);
  const bootId = randomUUID();
  const bootStartedAt = Date.now();
  const queue = createQueueRepository(database, { bootId });
  const policy = createPolicyRepository(database);
  const schedule = createScheduleRepository(database);
  const admin = createAdminRepository(database);
  const generated = createGeneratedMessageRepository(database);
  const pending = createPendingUpdateRepository(database);
  const recoveryRepository = createRecoveryRepository(database);
  const orphanRepository = createOrphanRepository(database);
  const alertRepository = createAlertRepository(database);
  const runtime = createRuntimeLease(database, `${process.pid}-${bootId}`, systemClock);
  const supervisor = createTaskSupervisor({ logger });
  const operationTracker = createOperationTracker();
  if (!runtime.acquire()) {
    logger.error("singleton_conflict", { error: "Another healthy queue bot process owns the database" });
    database.close();
    return;
  }
  queue.setBootId(bootId);
  database.raw.query("UPDATE app_state SET current_boot_id = ? WHERE id = 1").run(bootId);
  const recoveredOperations = queue.recoverExpiredOperations(Date.now(), bootId);
  if (recoveredOperations.length > 0) logger.warn("prior_boot_operations_recovered", { count: recoveredOperations.length });
  const interruptedRuns = schedule.recoverInterruptedRuns(Date.now());
  if (interruptedRuns > 0) logger.warn("interrupted_schedule_runs_recovered", { count: interruptedRuns });

  const bot = new Bot(config.botToken);
  const adminChatId = adminChatIdFromUserId(config.adminUserId);
  const gateway = createTelegramGateway(bot.api, adminChatId);
  const alerts = createAlertService({ alert: alertRepository, gateway, adminChatId, logger });
  let validatedBotId: UserId | undefined;
  let lastRightsCheckAt = 0;
  let lastSuccessfulRightsCheckAt: number | undefined;
  let lastSuccessfulBackupAt: number | undefined;
  let currentRights: { queue: BotMembership; target: BotMembership } | undefined;
  let stopped = false;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      stopped = true;
      operationTracker.stopAccepting();
      supervisor.requestStop();
      logger.info("shutdown_started", { signal });
      try {
        await bot.stop();
      } catch (error) {
        logger.warn("bot_stop_failed", { error: safeErrorDescription(error) });
      }
      const shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
      const tasksDrained = await supervisor.stopAndDrain(Math.max(0, shutdownDeadline - Date.now()));
      const operationsDrained = await operationTracker.waitForEmpty(Math.max(0, shutdownDeadline - Date.now()));
      const clean = tasksDrained && operationsDrained;
      let checkpointed = false;
      try {
        if (!clean) logger.error("shutdown_drain_timeout", { tasks: supervisor.names().join(","), operations: operationTracker.names().join(",") });
        database.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        checkpointed = true;
        if (clean) database.raw.query("UPDATE app_state SET last_clean_shutdown_at = ? WHERE id = 1").run(Date.now());
        else database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('unclean_shutdown', 'runtime', ?, ?)").run(JSON.stringify({ signal, tasks: supervisor.names(), operations: operationTracker.names() }), Date.now());
      } catch (error) {
        logger.error("shutdown_checkpoint_failed", { error: safeErrorDescription(error) });
        process.exitCode = 1;
      } finally {
        if (!clean || !checkpointed) process.exitCode = 1;
        runtime.release();
        database.close();
      }
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

  try {
    const identity = await gateway.getBotIdentity();
    validatedBotId = identity.id;
    database.raw.query("UPDATE app_state SET bot_id = ?, bot_username = ? WHERE id = 1").run(identity.id, identity.username ?? null);
    const [queueChat, targetChat] = await Promise.all([gateway.getChat(config.queueChannelId), gateway.getChat(config.targetChannelId)]);
    if (queueChat.type !== "channel" || targetChat.type !== "channel") throw new Error("QUEUE_CHANNEL_ID and TARGET_CHANNEL_ID must both resolve to channels");
    const [queueMembership, targetMembership] = await Promise.all([gateway.getBotMembership(config.queueChannelId, identity.id), gateway.getBotMembership(config.targetChannelId, identity.id)]);
    if (!queueMembership.canPostMessages || !queueMembership.canDeleteMessages) throw new Error("Bot needs can_post_messages and can_delete_messages in the queue channel");
    if (!targetMembership.canPostMessages || !targetMembership.canEditMessages || !targetMembership.canDeleteMessages) throw new Error("Bot needs post, edit, and delete rights in the destination channel");
    lastSuccessfulRightsCheckAt = Date.now();
    currentRights = { queue: queueMembership, target: targetMembership };
    logger.info("telegram_rights_validated", { botId: identity.id, queueChatId: config.queueChannelId, targetChatId: config.targetChannelId });
  } catch (error) {
    logger.error("startup_rights_check_failed", { error: safeErrorDescription(error) });
    try { await gateway.sendAdminMessage({ chatId: adminChatId, text: `Queue bot cannot start: ${safeErrorDescription(error)}` }); }
    catch (alertError) { logger.error("startup_admin_alert_failed", { error: safeErrorDescription(alertError) }); }
    await shutdown("startup_failure");
    return;
  }

  const ingestion = createIngestionService({ queueChannelId: config.queueChannelId, queue, policy, generated, pending, logger, now: systemClock.now });
  const publisher = createPublicationService({ queue, policy, gateway, queueChannelId: config.queueChannelId, targetChannelId: config.targetChannelId, clock: systemClock, logger, operationTracker });
  const renewal = createRenewalService({ queue, policy, generated, gateway, queueChannelId: config.queueChannelId, clock: systemClock, logger, operationTracker });
  const scheduler = createSchedulerService({ schedule, publisher, clock: systemClock, logger });
  const recovery = createRecoveryService({ queue, policy, recovery: recoveryRepository, gateway, queueChannelId: config.queueChannelId, adminChatId, clock: systemClock, logger, bootId, operationTracker });
  const recoveredSessions = await recovery.reconcileExpiredSessions();
  if (recoveredSessions.completed > 0 || recoveredSessions.blocked > 0) logger.info("recovery_sessions_reconciled", recoveredSessions);
  const orphanCleanup = createOrphanCleanupService({
    orphan: orphanRepository,
    gateway,
    clock: systemClock,
    logger,
    onPermissionAlert: async (orphan) => alerts.raise(`permissions:${orphan.chatId}`, "immediate", `Telegram refused cleanup rights for queue chat ${orphan.chatId}; orphan ${orphan.messageId} still needs attention.`, systemClock.now()),
  });
  const health = createHealthService({ database, queue, schedule, pending, orphan: orphanRepository, alerts: alertRepository, now: systemClock.now, ownsLease: runtime.owns, bootStartedAt, lastRightsCheckAt: () => lastSuccessfulRightsCheckAt, lastBackupAt: () => lastSuccessfulBackupAt, rights: () => currentRights });
  const retention = createRetentionService({ queue, generated, admin, alerts: alertRepository, clock: systemClock, logger });
  const backup = createBackupService({ database, directory: join(config.dataDirectory, "backups"), logger, now: systemClock.now });
  registerQueueChannelHandlers(bot, ingestion, () => database.raw.query("UPDATE app_state SET last_successful_update_at = ? WHERE id = 1").run(systemClock.now()));
  registerAdminHandlers(bot, {
    config,
    queue,
    policy,
    schedule,
    admin,
    pending,
    orphan: orphanRepository,
    gateway,
    publisher,
    scheduler,
    recovery,
    health,
    logger,
    operationTracker,
    now: systemClock.now,
  });
  bot.catch((error) => {
    logger.error("polling_error", { error: safeErrorDescription(error.error) });
  });

  supervisor.start("renewal", async (signal) => {
    while (!signal.aborted && !stopped) {
      try {
        await renewal.renewNext(RENEWAL_START_AGE_MS);
      } catch (error) {
        logger.error("renewal_worker_failed", { error: safeErrorDescription(error) });
      }
      await abortableSleep(systemClock, RENEWAL_INTERVAL_MS, signal);
    }
  });
  supervisor.start("pending_updates", async (signal) => {
    while (!signal.aborted && !stopped) {
      try { ingestion.finalizeAlbums(); }
      catch (error) { logger.error("pending_update_finalizer_failed", { error: safeErrorDescription(error) }); }
      await abortableSleep(systemClock, 1_000, signal);
    }
  });
  supervisor.start("orphan_cleanup", async (signal) => {
    while (!signal.aborted && !stopped) {
      try { await orphanCleanup.runOnce(); }
      catch (error) { logger.error("orphan_cleanup_worker_failed", { error: safeErrorDescription(error) }); }
      await abortableSleep(systemClock, 15 * 60_000, signal);
    }
  });
  supervisor.start("alerts", async (signal) => {
    while (!signal.aborted && !stopped) {
      try {
        const now = systemClock.now();
        const activeConditions = new Set<string>();
        const raise = async (key: string, severity: "normal" | "immediate" | "critical", text: string): Promise<void> => {
          activeConditions.add(key);
          await alerts.raise(key, severity, text, now);
        };
        if (validatedBotId !== undefined && now - lastRightsCheckAt >= 6 * 60 * 60_000) {
          lastRightsCheckAt = now;
          const [queueRights, targetRights] = await Promise.all([gateway.getBotMembership(config.queueChannelId, validatedBotId), gateway.getBotMembership(config.targetChannelId, validatedBotId)]);
          currentRights = { queue: queueRights, target: targetRights };
          const rightsOkay = queueRights.canPostMessages && queueRights.canDeleteMessages && targetRights.canPostMessages && targetRights.canEditMessages && targetRights.canDeleteMessages;
          if (rightsOkay) {
            lastSuccessfulRightsCheckAt = now;
            await alerts.resolve(`permissions:${config.queueChannelId}`, "Telegram permissions restored.", now);
          }
        }
        if (currentRights !== undefined) {
          const rightsOkay = currentRights.queue.canPostMessages && currentRights.queue.canDeleteMessages && currentRights.target.canPostMessages && currentRights.target.canEditMessages && currentRights.target.canDeleteMessages;
          if (!rightsOkay) await raise(`permissions:${config.queueChannelId}`, "immediate", "Telegram permissions no longer satisfy queue/destination cleanup requirements.");
        }
        for (const entry of queue.listRenewalAges(now)) {
          if (entry.ageMs >= 47 * 60 * 60_000) await raise(`renewal_critical:${entry.item.id}`, "critical", `Physical queue source for item #${entry.item.id} is at least 47 hours old. IDs: ${entry.sourceIds.join(", ")}`);
          else if (entry.ageMs >= 46 * 60 * 60_000) await raise(`renewal_warning:${entry.item.id}`, "immediate", `Physical queue source for item #${entry.item.id} is at least 46 hours old.`);
          else if (entry.ageMs >= 42 * 60 * 60_000) await raise(`renewal_warning:${entry.item.id}`, "normal", `Physical queue source for item #${entry.item.id} is at least 42 hours old.`);
        }
        const head = queue.getHead();
        if (head?.status === "blocked") await raise(`blocked_head:${head.id}`, "normal", `Queue head #${head.id} is blocked and needs admin review.`);
        if (head?.status === "needs_edit") await raise(`needs_edit:${head.id}`, "normal", `Queue head #${head.id} needs an edit before publication.`);
        if (head?.status === "needs_review") await raise(`needs_review:${head.id}`, "normal", `Queue head #${head.id} needs admin review.`);
        for (const item of queue.listActive(10_000)) {
          if (item.status === "uncertain_publish") await raise(`uncertain_publish:${item.id}`, "immediate", `Publication for queue item #${item.id} is uncertain and requires admin resolution.`);
          if (item.maintenanceStatus === "uncertain_renewal") await raise(`uncertain_renewal:${item.id}`, "immediate", `Renewal for queue item #${item.id} is uncertain and requires admin resolution.`);
        }
        for (const item of queue.listRecentlyDeletedExternal(now - 24 * 60 * 60_000)) await raise(`deleted_external:${item.id}`, "normal", `Queue source for item #${item.id} disappeared from Telegram before publication.`);
        for (const orphan of orphanRepository.terminal()) await raise(`orphan_manual:${orphan.itemId}:${orphan.sourceGeneration}`, "immediate", `Orphaned source ${orphan.messageId} for queue item #${orphan.itemId} is past Telegram's deletion age limit and requires manual cleanup.`);
        const capacity = health.snapshot().renewalCapacity;
        if (!capacity.safe) await raise("renewal_capacity", "critical", `Renewal capacity is unsafe; projected first deadline miss is item #${capacity.projectedFirstMiss?.itemId ?? "unknown"}.`);
        for (const existing of alertRepository.active()) {
          const dynamic = /^(?:renewal_warning|renewal_critical|blocked_head|needs_edit|needs_review|uncertain_publish|uncertain_renewal|deleted_external|orphan_manual|renewal_capacity|permissions):/.test(existing.dedupeKey) || existing.dedupeKey === "renewal_capacity";
          if (dynamic && !activeConditions.has(existing.dedupeKey)) await alerts.resolve(existing.dedupeKey, "Condition cleared.", now);
        }
      } catch (error) {
        logger.error("alert_worker_failed", { error: safeErrorDescription(error) });
      }
      await abortableSleep(systemClock, 60_000, signal);
    }
  });
  supervisor.start("retention", async (signal) => {
    while (!signal.aborted && !stopped) {
      try { retention.runOnce(); }
      catch (error) { logger.error("retention_worker_failed", { error: safeErrorDescription(error) }); }
      await abortableSleep(systemClock, 24 * 60 * 60_000, signal);
    }
  });
  supervisor.start("backup", async (signal) => {
    while (!signal.aborted && !stopped) {
      try { backup.runOnce(); lastSuccessfulBackupAt = systemClock.now(); }
      catch (error) { logger.error("backup_worker_failed", { error: safeErrorDescription(error) }); }
      await abortableSleep(systemClock, 24 * 60 * 60_000, signal);
    }
  });
  supervisor.start("scheduler", async (signal) => scheduler.run(signal));
  supervisor.start("lease_heartbeat", async (signal) => {
    while (!signal.aborted && !stopped) {
      await abortableSleep(systemClock, 20_000, signal);
      if (signal.aborted || stopped) return;
      if (!runtime.heartbeat()) {
        logger.error("singleton_lease_lost", {});
        void shutdown("lease_lost");
        return;
      }
    }
  });

  try {
    await bot.start({ allowed_updates: ["message", "callback_query", "channel_post", "edited_channel_post"] });
  } catch (error) {
    if (!stopped) logger.error("polling_stopped", { error: safeErrorDescription(error) });
  } finally {
    if (!stopped) await shutdown("polling_exit");
  }
};

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "fatal", error: safeErrorDescription(error) }));
  process.exitCode = 1;
});

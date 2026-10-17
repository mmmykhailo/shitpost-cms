import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Bot } from "grammy";
import { parseConfig, type AppConfig } from "./config";
import { classifyTelegramError } from "./errors";
import { buildQueueMessageLink } from "./domain/telegram-message-link";
import { fingerprintSnapshotContent } from "./domain/message";
import { createLogger, safeErrorDescription, type Logger } from "./logger";
import { createDatabase, type AppDatabase } from "./db/database";
import { createAdminRepository } from "./db/admin-repository";
import { createAlertRepository } from "./db/alert-repository";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository, createScheduleRepository } from "./db/repositories";
import { createPendingUpdateRepository } from "./db/pending-update-repository";
import { createPreparationRepository } from "./db/preparation-repository";
import { createGeneratedEventRepository } from "./db/generated-event-repository";
import { createRecoveryRepository } from "./db/recovery-repository";
import { createOrphanRepository } from "./db/orphan-repository";
import { createTelegramCooldownRepository } from "./db/telegram-cooldown-repository";
import { createTelegramAdmissionRepository } from "./db/telegram-admission-repository";
import { createOperationRequestRepository } from "./db/operation-request-repository";
import { createPreparationRequestRepository } from "./db/preparation-request-repository";
import { createRuntimeLease } from "./db/runtime";
import { createTelegramGateway, type BotMembership, type TelegramGateway } from "./telegram";
import { createIngestionService } from "./services/ingestion";
import { createPublicationService } from "./services/publisher";
import { createPublicationCoordinator } from "./services/publication-coordinator";
import { createRenewalService } from "./services/renewal";
import { createRenewalWorker } from "./services/renewal-worker";
import { createPreparationService } from "./services/preparation";
import { createPreparationWorker } from "./services/preparation-worker";
import { createSchedulerService } from "./services/scheduler";
import { createOrphanCleanupService } from "./services/orphan-cleanup";
import { createAlertService, resolutionTextForDedupeKey } from "./services/alerts";
import { createHealthService } from "./services/health";
import { createRetentionService } from "./services/retention";
import { createBackupService } from "./services/backup";
import { abortableSleep, createOperationTracker, createTaskSupervisor } from "./services/task-supervisor";
import { registerAdminHandlers } from "./handlers/admin";
import { registerQueueChannelHandlers } from "./handlers/queue-channel";
import { adminChatIdFromUserId, createRecoveryService } from "./services/recovery";
import { createRuntimeStatusWriter } from "./runtime-status";
import { createTelegramCooldown } from "./telegram-cooldown";
import { createTelegramAdmission } from "./services/telegram-admission";
import { systemClock, type Clock, type UserId } from "./types";

const SHUTDOWN_TIMEOUT_MS = 30_000;
const STARTUP_CHECK_ATTEMPTS = 3;
const STARTUP_CHECK_RETRYABLE_KINDS = new Set(["rate_limited", "transient_network", "transient_server"]);

type ApplicationProcess = {
  pid: number;
  exitCode: number;
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

type RuntimeStatusWriter = ReturnType<typeof createRuntimeStatusWriter>;

export type ApplicationOptions = {
  config?: AppConfig;
  logger?: Logger;
  database?: AppDatabase;
  databaseFactory?: (path: string) => AppDatabase;
  bot?: Bot;
  gateway?: TelegramGateway;
  clock?: Clock;
  bootId?: string;
  process?: ApplicationProcess;
  runtimeStatus?: RuntimeStatusWriter;
  installSignalHandlers?: boolean;
};

export const waitForShutdownStage = async (
  name: string,
  operation: () => Promise<unknown>,
  timeoutMs: number,
  logger: Logger,
): Promise<boolean> => {
  if (timeoutMs <= 0) {
    logger.error("shutdown_stage_timeout", { stage: name });
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    Promise.resolve().then(operation).then(
      () => ({ completed: true as const }),
      (error: unknown) => ({ completed: true as const, error }),
    ),
    new Promise<{ completed: false; timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ completed: false, timedOut: true }), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!result.completed) {
    logger.error("shutdown_stage_timeout", { stage: name });
    return false;
  }
  if ("error" in result) {
    logger.warn("shutdown_stage_failed", { stage: name, error: safeErrorDescription(result.error) });
    return false;
  }
  return true;
};

export const main = async (options: ApplicationOptions = {}): Promise<void> => {
  const processLike = options.process ?? process;
  const config = options.config ?? parseConfig();
  const logger = options.logger ?? createLogger(config.logLevel);
  const database = options.database ?? (options.databaseFactory ?? createDatabase)(config.databasePath);
  const clock = options.clock ?? systemClock;
  const bootId = options.bootId ?? randomUUID();
  const bootStartedAt = clock.now();
  const queue = createQueueRepository(database, { bootId });
  const policy = createPolicyRepository(database);
  const schedule = createScheduleRepository(database);
  const admin = createAdminRepository(database);
  const generated = createGeneratedMessageRepository(database);
  const generatedEvents = createGeneratedEventRepository(database);
  const preparationRepository = createPreparationRepository(database);
  const pending = createPendingUpdateRepository(database);
  const recoveryRepository = createRecoveryRepository(database);
  const orphanRepository = createOrphanRepository(database);
  const alertRepository = createAlertRepository(database);
  const runtime = createRuntimeLease(database, `${processLike.pid}-${bootId}`, clock);
  const supervisor = createTaskSupervisor({ logger });
  const operationTracker = createOperationTracker();
  const runtimeStatus = options.runtimeStatus ?? createRuntimeStatusWriter({
    releaseSha: config.releaseSha,
    pid: processLike.pid,
    processStartedAt: new Date(bootStartedAt).toISOString(),
    now: () => new Date(clock.now()),
    ...(config.runtimeStatusPath === undefined ? {} : { path: config.runtimeStatusPath }),
  });
  if (!runtime.acquire()) {
    logger.error("singleton_conflict", { error: "Another healthy queue bot process owns the database" });
    database.close();
    return;
  }
  try {
    runtimeStatus.writeStarting();
  } catch (error) {
    runtime.release();
    database.close();
    throw error;
  }
  queue.setBootId(bootId);
  database.raw.query("UPDATE app_state SET current_boot_id = ? WHERE id = 1").run(bootId);
  const recoveredOperations = queue.recoverExpiredOperations(clock.now(), bootId);
  if (recoveredOperations.length > 0) logger.warn("prior_boot_operations_recovered", { count: recoveredOperations.length });
  const recoveredPreparations = preparationRepository.recoverExpiredOperations(clock.now(), bootId);
  if (recoveredPreparations.requeued + recoveredPreparations.uncertain + recoveredPreparations.cleanupPending > 0) logger.warn("prior_boot_preparations_recovered", recoveredPreparations);
  const interruptedRuns = schedule.recoverInterruptedRuns(clock.now());
  if (interruptedRuns > 0) logger.warn("interrupted_schedule_runs_recovered", { count: interruptedRuns });

  const bot = options.bot ?? new Bot(config.botToken);
  const telegramCooldown = createTelegramCooldown({ repository: createTelegramCooldownRepository(database), clock });
  const telegramAdmission = createTelegramAdmission({
    repository: createTelegramAdmissionRepository(database),
    cooldown: telegramCooldown,
    clock,
    logger,
    queueChatId: Number(config.queueChannelId),
    targetChatId: Number(config.targetChannelId),
  });
  telegramAdmission.install(bot.api);
  const operationRequest = createOperationRequestRepository(database);
  const preparationRequest = createPreparationRequestRepository(database);
  const adminChatId = adminChatIdFromUserId(config.adminUserId);
  const gateway = options.gateway ?? createTelegramGateway(bot.api, adminChatId);
  const alerts = createAlertService({
    alert: alertRepository,
    gateway,
    adminChatId,
    logger,
    createCallbackToken: (action, payload, now, itemVersion) => admin.createCallbackToken(config.adminUserId, action, payload, now, itemVersion),
  });
  let validatedBotId: UserId | undefined;
  let lastRightsCheckAt = 0;
  let lastSuccessfulRightsCheckAt: number | undefined;
  let lastSuccessfulBackupAt: number | undefined;
  let currentRights: { queue: BotMembership; target: BotMembership } | undefined;
  let stopped = false;
  let shutdownPromise: Promise<void> | undefined;
  let pollingPromise: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      stopped = true;
      telegramAdmission.stop();
      operationTracker.stopAccepting();
      supervisor.requestStop();
      logger.info("shutdown_started", { signal });
      const shutdownDeadline = clock.now() + SHUTDOWN_TIMEOUT_MS;
      try {
        runtimeStatus.writeStopping();
      } catch (error) {
        logger.error("runtime_status_write_failed", { state: "stopping", error: safeErrorDescription(error) });
      }
      const botStopped = await waitForShutdownStage("bot_stop", () => bot.stop(), Math.max(0, shutdownDeadline - clock.now()), logger);
      const pollingStopped = pollingPromise === undefined
        ? true
        : await waitForShutdownStage("polling_drain", () => pollingPromise as Promise<unknown>, Math.max(0, shutdownDeadline - clock.now()), logger);
      const operationsDrained = await operationTracker.waitForEmpty(Math.max(0, shutdownDeadline - clock.now()));
      const tasksDrained = await supervisor.stopAndDrain(Math.max(0, shutdownDeadline - clock.now()));
      const clean = botStopped && pollingStopped && tasksDrained && operationsDrained;
      let checkpointed = false;
      try {
        if (!clean) logger.error("shutdown_drain_timeout", { tasks: supervisor.names().join(","), operations: operationTracker.names().join(",") });
        database.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        checkpointed = true;
        if (clean) database.raw.query("UPDATE app_state SET last_clean_shutdown_at = ? WHERE id = 1").run(clock.now());
        else database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('unclean_shutdown', 'runtime', ?, ?)").run(JSON.stringify({ signal, tasks: supervisor.names(), operations: operationTracker.names() }), clock.now());
      } catch (error) {
        logger.error("shutdown_checkpoint_failed", { error: safeErrorDescription(error) });
        processLike.exitCode = 1;
      } finally {
        if (!clean || !checkpointed) processLike.exitCode = 1;
        runtime.release();
        database.close();
        try {
          runtimeStatus.remove();
        } catch (error) {
          logger.error("runtime_status_remove_failed", { error: safeErrorDescription(error) });
          processLike.exitCode = 1;
        }
      }
    })();
    return shutdownPromise;
  };

  if (options.installSignalHandlers !== false) {
    processLike.once("SIGINT", () => { void shutdown("SIGINT"); });
    processLike.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  }

  const validateTelegramStartup = async (): Promise<void> => {
    const identity = await gateway.getBotIdentity();
    validatedBotId = identity.id;
    database.raw.query("UPDATE app_state SET bot_id = ?, bot_username = ? WHERE id = 1").run(identity.id, identity.username ?? null);
    const [queueChat, targetChat] = await Promise.all([gateway.getChat(config.queueChannelId), gateway.getChat(config.targetChannelId)]);
    if (queueChat.type !== "channel" || targetChat.type !== "channel") throw new Error("QUEUE_CHANNEL_ID and TARGET_CHANNEL_ID must both resolve to channels");
    const [queueMembership, targetMembership] = await Promise.all([gateway.getBotMembership(config.queueChannelId, identity.id), gateway.getBotMembership(config.targetChannelId, identity.id)]);
    if (!queueMembership.canPostMessages || !queueMembership.canDeleteMessages) throw new Error("Bot needs can_post_messages and can_delete_messages in the queue channel");
    if (!targetMembership.canPostMessages || !targetMembership.canEditMessages || !targetMembership.canDeleteMessages) throw new Error("Bot needs post, edit, and delete rights in the destination channel");
    lastSuccessfulRightsCheckAt = clock.now();
    currentRights = { queue: queueMembership, target: targetMembership };
    logger.info("telegram_rights_validated", { botId: identity.id, queueChatId: config.queueChannelId, targetChatId: config.targetChannelId });
  };

  try {
    for (let attempt = 1; attempt <= STARTUP_CHECK_ATTEMPTS; attempt += 1) {
      try {
        await validateTelegramStartup();
        break;
      } catch (error) {
        const normalized = classifyTelegramError(error);
        const retryable = STARTUP_CHECK_RETRYABLE_KINDS.has(normalized.kind);
        if (!retryable || attempt === STARTUP_CHECK_ATTEMPTS) throw error;
        const delay = Math.min(10_000, Math.max(1_000 * (2 ** (attempt - 1)), (normalized.retryAfterSeconds ?? 0) * 1_000));
        logger.warn("startup_rights_check_retry", { attempt, delayMs: delay, kind: normalized.kind, method: normalized.method, error: safeErrorDescription(error) });
        await clock.sleep(delay);
      }
    }
  } catch (error) {
    const normalized = classifyTelegramError(error);
    logger.error("startup_rights_check_failed", { kind: normalized.kind, method: normalized.method, error: safeErrorDescription(error) });
    try { await gateway.sendAdminMessage({ chatId: adminChatId, text: `Queue bot cannot start: ${safeErrorDescription(error)}` }); }
    catch (alertError) { logger.error("startup_admin_alert_failed", { error: safeErrorDescription(alertError) }); }
    await shutdown("startup_failure");
    return;
  }

  const ingestion = createIngestionService({ queueChannelId: config.queueChannelId, queue, policy, generated, events: generatedEvents, pending, logger, now: clock.now });
  const preparation = createPreparationService({ queue, preparation: preparationRepository, requestEvidence: preparationRequest, policy, gateway, queueChannelId: config.queueChannelId, bootId, clock, logger, operationTracker, cooldown: telegramCooldown });
  const preparationWorker = createPreparationWorker({ preparation, cooldown: telegramCooldown, clock, logger });
  const publicationCoordinator = createPublicationCoordinator();
  const publisher = createPublicationService({
    queue, gateway, queueChannelId: config.queueChannelId, targetChannelId: config.targetChannelId, clock, logger, operationTracker, cooldown: telegramCooldown,
    coordinator: publicationCoordinator,
    schedule,
    requestEvidence: operationRequest,
    onSharedFailure: async (error, context) => {
      const key = error.kind === "rate_limited" ? "shared_issue:flood_wait" : `shared_issue:${error.kind}`;
      const fingerprint = createHash("sha256").update(JSON.stringify({ kind: error.kind })).digest("hex");
      const retry = context?.retryAt === undefined ? "" : ` Retry is scheduled for ${new Date(context.retryAt).toISOString()}.`;
      const operation = context === undefined ? {} : { itemId: context.itemId, operationId: context.operationId, retryAt: context.retryAt };
      await alerts.raiseOnChange(key, "immediate", fingerprint, {
        text: `Prepared publication stopped by a shared Telegram ${error.kind} condition.${retry} ${safeErrorDescription(error.description)}`,
        ...operation,
        actions: [{ text: "Open queue", action: "queue", payload: {} }],
      }, clock.now());
    },
    onSharedRecovery: async () => {
      for (const existing of alertRepository.active().filter((entry) => entry.dedupeKey.startsWith("shared_issue:"))) {
        await alerts.resolve(existing.dedupeKey, "A prepared publication succeeded; the shared Telegram issue cleared.", clock.now());
      }
    },
  });
  const renewal = createRenewalService({ queue, policy, generated, events: generatedEvents, gateway, queueChannelId: config.queueChannelId, clock, logger, operationTracker, cooldown: telegramCooldown, requestEvidence: operationRequest });
  const renewalWorker = createRenewalWorker({ queue, renewal, cooldown: telegramCooldown, clock, logger });
  const scheduler = createSchedulerService({ schedule, publisher, clock, logger, bootId });
  const recovery = createRecoveryService({ queue, policy, recovery: recoveryRepository, gateway, queueChannelId: config.queueChannelId, adminChatId, clock, logger, bootId, operationTracker });
  const recoveredSessions = await recovery.reconcileExpiredSessions();
  if (recoveredSessions.completed > 0 || recoveredSessions.blocked > 0) logger.info("recovery_sessions_reconciled", recoveredSessions);
  const orphanCleanup = createOrphanCleanupService({
    orphan: orphanRepository,
    gateway,
    clock,
    logger,
    cooldown: telegramCooldown,
    onPermissionAlert: async (orphan) => alerts.raise(`permissions:${orphan.chatId}`, "immediate", `Telegram refused cleanup rights for queue chat ${orphan.chatId}; orphan ${orphan.messageId} still needs attention.`, clock.now()),
  });
  const health = createHealthService({ database, queue, schedule, pending, orphan: orphanRepository, alerts: alertRepository, now: clock.now, ownsLease: runtime.owns, bootStartedAt, lastRightsCheckAt: () => lastSuccessfulRightsCheckAt, lastBackupAt: () => lastSuccessfulBackupAt, rights: () => currentRights, cooldown: telegramCooldown });
  const retention = createRetentionService({ queue, generated, generatedEvents, pending, admin, alerts: alertRepository, clock, logger });
  const backup = createBackupService({ database, directory: join(config.dataDirectory, "backups"), logger, now: clock.now });
  registerQueueChannelHandlers(bot, ingestion, () => database.raw.query("UPDATE app_state SET last_successful_update_at = ? WHERE id = 1").run(clock.now()));
  registerAdminHandlers(bot, {
    config,
    queue,
    policy,
    schedule,
    admin,
    pending,
    preparation: preparationRepository,
    orphan: orphanRepository,
    gateway,
    publisher,
    scheduler,
    recovery,
    health,
    logger,
    operationTracker,
    now: clock.now,
  });
  bot.catch((error) => {
    logger.error("polling_error", { error: safeErrorDescription(error.error) });
  });

  const startBackgroundWork = (): void => {
    supervisor.start("renewal", (signal) => renewalWorker.run(signal));
    supervisor.start("preparation", (signal) => preparationWorker.run(signal));
    supervisor.start("pending_updates", async (signal) => {
    while (!signal.aborted && !stopped) {
      try { ingestion.finalizeAlbums(); }
      catch (error) { logger.error("pending_update_finalizer_failed", { error: safeErrorDescription(error) }); }
      await abortableSleep(clock, 1_000, signal);
    }
    });
    supervisor.start("publication_cleanup", async (signal) => {
    while (!signal.aborted && !stopped) {
      try {
        for (const item of queue.listActive(10_000).filter((entry) => entry.status === "published_cleanup_pending")) await publisher.cleanupPending(item.id);
      } catch (error) {
        logger.error("publication_cleanup_worker_failed", { error: safeErrorDescription(error) });
      }
      await abortableSleep(clock, 60_000, signal);
    }
    });
    supervisor.start("operation_recovery", async (signal) => {
    while (!signal.aborted && !stopped) {
      try {
        const now = clock.now();
        queue.heartbeatOperations(now, bootId);
        const recovered = queue.recoverExpiredOperations(now, bootId);
        if (recovered.length > 0) logger.warn("expired_operations_recovered", { count: recovered.length });
        preparationRepository.heartbeatOperations(now, bootId);
        const recoveredPreparations = preparationRepository.recoverExpiredOperations(now, bootId);
        if (recoveredPreparations.requeued + recoveredPreparations.uncertain + recoveredPreparations.cleanupPending > 0) logger.warn("expired_preparations_recovered", recoveredPreparations);
      } catch (error) {
        logger.error("operation_recovery_worker_failed", { error: safeErrorDescription(error) });
      }
      await abortableSleep(clock, 60_000, signal);
    }
    });
    supervisor.start("orphan_cleanup", async (signal) => {
    while (!signal.aborted && !stopped) {
      try { await orphanCleanup.runOnce(); }
      catch (error) { logger.error("orphan_cleanup_worker_failed", { error: safeErrorDescription(error) }); }
      await abortableSleep(clock, 15 * 60_000, signal);
    }
    });
    supervisor.start("alerts", async (signal) => {
    while (!signal.aborted && !stopped) {
      try {
        const now = clock.now();
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
          if (!rightsOkay) {
            await raise(`permissions:${config.queueChannelId}`, "immediate", "Telegram permissions no longer satisfy queue/destination cleanup requirements.");
            const fingerprint = createHash("sha256").update(JSON.stringify({ kind: "permission_denied" })).digest("hex");
            await alerts.raiseOnChange("shared_issue:permission_denied", "immediate", fingerprint, {
              text: "Telegram permissions block queue publication or cleanup.",
              actions: [{ text: "Open queue", action: "queue", payload: {} }],
            }, now);
          } else if (alertRepository.find("shared_issue:permission_denied")?.resolvedAt === undefined) {
            await alerts.resolve("shared_issue:permission_denied", "Telegram permissions were restored.", now);
          }
        }
        for (const entry of queue.listRenewalAges(now)) {
          if (entry.ageMs >= 47 * 60 * 60_000) await raise(`renewal_critical:${entry.item.id}`, "critical", `Physical queue source for item #${entry.item.id} is at least 47 hours old. IDs: ${entry.sourceIds.join(", ")}`);
          else if (entry.ageMs >= 46 * 60 * 60_000) await raise(`renewal_warning:${entry.item.id}`, "immediate", `Physical queue source for item #${entry.item.id} is at least 46 hours old.`);
          else if (entry.ageMs >= 42 * 60 * 60_000) await raise(`renewal_warning:${entry.item.id}`, "normal", `Physical queue source for item #${entry.item.id} is at least 42 hours old.`);
        }
        for (const item of queue.listActive(10_000)) {
          const category = item.preparationState === "uncertain" ? "uncertain_preparation"
            : item.status === "uncertain_publish" ? "uncertain_publish"
              : item.maintenanceStatus === "uncertain_renewal" ? "uncertain_renewal"
                : ["blocked", "needs_edit", "needs_review", "delete_blocked"].includes(item.status) ? item.status : undefined;
          if (category === undefined) continue;
          const key = `item_issue:${item.id}`;
          activeConditions.add(key);
          const rawReason = item.lastError ?? item.lastErrorCode ?? category;
          const reason = rawReason.replace(/[\u0000-\u001F\u007F]/gu, " ").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "<operation>").replace(/\s+/gu, " ").trim().slice(0, 700);
          const normalizedReason = reason.toLowerCase().replace(/\b\d{10,}\b/gu, "<id>").replace(/\b(?:operation|op)(?:\s+id)?\s*[:=]?\s*[^ ]+/giu, "operation <id>");
          let snapshots: ReturnType<typeof queue.getCurrentSnapshotSet> = [];
          try { snapshots = queue.getCurrentSnapshotSet(item.id); } catch { /* Evidence may be unavailable after an external deletion. */ }
          const contentFingerprints = snapshots.map((snapshot) => snapshot.contentFingerprint ?? fingerprintSnapshotContent(snapshot));
          const attribution = item.attribution;
          const attributionMaterial = attribution === undefined ? { ownership: "none" } : {
            ownership: attribution.ownership,
            placement: "placement" in attribution ? attribution.placement : undefined,
            generatedText: "generatedText" in attribution ? attribution.generatedText : undefined,
          };
          const material = { itemId: item.id, category, errorCode: item.lastErrorCode ?? category, reason: normalizedReason, contentFingerprints, attribution: attributionMaterial };
          const fingerprint = createHash("sha256").update(JSON.stringify(material)).digest("hex");
          const sourceId = queue.currentSourceIds(item.id)[0];
          const sourceLink = sourceId === undefined ? undefined : buildQueueMessageLink(config.queueChannelId, sourceId);
          let evidenceSummary: Record<string, unknown> | undefined;
          if (category === "uncertain_preparation") {
            const evidence = preparationRepository.operationEvidence(item.id).find((entry) => entry.state === "uncertain");
            if (evidence) evidenceSummary = {
              operationId: evidence.operationId,
              phase: evidence.phase,
              outputs: (evidence.outputs as Array<{ chat_id: number; telegram_message_id: number }>).map((output) => ({ chatId: output.chat_id, messageId: output.telegram_message_id })),
            };
          } else if (category === "uncertain_publish" || category === "uncertain_renewal") {
            const evidence = queue.operationEvidence(item.id);
            if (evidence) evidenceSummary = {
              operationId: evidence.operationId,
              phase: evidence.phase,
              outputs: category === "uncertain_publish" ? evidence.knownDestinationIds : evidence.knownReplacementIds,
              sourceIds: evidence.sourceIds,
            };
          }
          const actions = category === "uncertain_preparation"
            ? [{ text: "Resolve preparation", action: "preparation_uncertain", payload: { itemId: item.id }, itemVersion: item.contentVersion }]
            : category === "uncertain_publish"
              ? [{ text: "Resolve publication", action: "queue_uncertain", payload: { itemId: item.id }, itemVersion: item.contentVersion }]
              : category === "uncertain_renewal"
                ? [{ text: "Resolve renewal", action: "renewal_uncertain", payload: { itemId: item.id }, itemVersion: item.contentVersion }]
                : [{ text: "Review queue item", action: "queue_item", payload: { itemId: item.id }, itemVersion: item.contentVersion }];
          const severity = category.startsWith("uncertain_") ? "immediate" : "normal";
          await alerts.raiseOnChange(key, severity, fingerprint, {
            text: `Queue item #${item.id} needs attention (${category}): ${reason}${sourceLink ? `\nQueue source: ${sourceLink}` : "\nNo current queue source link is available."}${evidenceSummary ? `\nOperation evidence: ${JSON.stringify(evidenceSummary).slice(0, 1_200)}` : ""}`,
            itemId: item.id,
            category,
            reason,
            sourceLink,
            evidence: evidenceSummary,
            actions,
          }, now);
        }
        const sharedIssueFingerprint = createHash("sha256").update("shared_flood_wait").digest("hex");
        if (telegramCooldown.isActive()) {
          activeConditions.add("shared_issue:flood_wait");
          await alerts.raiseOnChange("shared_issue:flood_wait", "immediate", sharedIssueFingerprint, {
            text: `Telegram mutations are paused by the shared flood wait until ${new Date(telegramCooldown.notBefore()).toISOString()}.`,
            retryAt: telegramCooldown.notBefore(),
            actions: [{ text: "Open queue", action: "queue", payload: {} }],
          }, now);
        } else if (alertRepository.find("shared_issue:flood_wait")?.resolvedAt === undefined) {
          await alerts.resolve("shared_issue:flood_wait", "The shared Telegram flood wait ended.", now);
        }
        const manualOrphanGroups = new Map<string, { itemId: number; sourceGeneration: number; messageIds: Set<number> }>();
        for (const orphan of orphanRepository.terminal()) {
          const key = `orphan_manual:${orphan.itemId}:${orphan.sourceGeneration}`;
          const group = manualOrphanGroups.get(key) ?? { itemId: orphan.itemId, sourceGeneration: orphan.sourceGeneration, messageIds: new Set<number>() };
          group.messageIds.add(orphan.messageId);
          manualOrphanGroups.set(key, group);
        }
        for (const [key, group] of manualOrphanGroups) {
          const item = queue.findItemById(group.itemId);
          const currentIds = item ? queue.currentSourceIds(item.id) : [];
          const currentGeneration = item?.sourceGeneration === undefined ? "unknown" : String(item.sourceGeneration);
          await raise(key, "immediate", `Orphaned sources for queue item #${group.itemId}, generation ${group.sourceGeneration}, are past Telegram's deletion age limit and require manual cleanup. Old source IDs: ${[...group.messageIds].sort((left, right) => left - right).join(", ")}. Current generation ${currentGeneration} source IDs: ${currentIds.join(", ") || "unavailable"}.`);
        }
        const capacity = health.snapshot().renewalCapacity;
        if (!capacity.safe) {
          const reasons = [
            ...(capacity.blockedItemIds?.length ? [`due uncertain renewals require admin resolution for item(s) #${capacity.blockedItemIds.join(", #")}`] : []),
            ...(capacity.projectedFirstMiss ? [`projected deadline miss for item #${capacity.projectedFirstMiss.itemId}`] : []),
          ];
          await raise("renewal_capacity", "critical", `Renewal capacity is unsafe: ${reasons.join("; ")}.`);
        }
        for (const existing of alertRepository.active()) {
          const dynamic = /^(?:renewal_warning|renewal_critical|blocked_head|needs_edit|needs_review|uncertain_publish|uncertain_renewal|deleted_external|orphan_manual|renewal_capacity|permissions):/.test(existing.dedupeKey) || existing.dedupeKey === "renewal_capacity";
          if (dynamic && !activeConditions.has(existing.dedupeKey)) await alerts.resolve(existing.dedupeKey, resolutionTextForDedupeKey(existing.dedupeKey), now);
          if (existing.notificationMode === "on_change" && existing.dedupeKey.startsWith("item_issue:") && !activeConditions.has(existing.dedupeKey)) await alerts.resolve(existing.dedupeKey, resolutionTextForDedupeKey(existing.dedupeKey), now);
        }
        await alerts.retryPendingOnChange(now);
      } catch (error) {
        logger.error("alert_worker_failed", { error: safeErrorDescription(error) });
      }
      await abortableSleep(clock, 60_000, signal);
    }
    });
    supervisor.start("retention", async (signal) => {
    while (!signal.aborted && !stopped) {
      try { retention.runOnce(); }
      catch (error) { logger.error("retention_worker_failed", { error: safeErrorDescription(error) }); }
      await abortableSleep(clock, 24 * 60 * 60_000, signal);
    }
    });
    supervisor.start("backup", async (signal) => {
    while (!signal.aborted && !stopped) {
      try { backup.runOnce(); lastSuccessfulBackupAt = clock.now(); }
      catch (error) { logger.error("backup_worker_failed", { error: safeErrorDescription(error) }); }
      await abortableSleep(clock, 24 * 60 * 60_000, signal);
    }
    });
    supervisor.start("scheduler", async (signal) => scheduler.run(signal));
    supervisor.start("lease_heartbeat", async (signal) => {
    while (!signal.aborted && !stopped) {
      await abortableSleep(clock, 20_000, signal);
      if (signal.aborted || stopped) return;
      if (!runtime.heartbeat()) {
        logger.error("singleton_lease_lost", {});
        void shutdown("lease_lost");
        try {
          // Keep this supervised task alive until alert bookkeeping finishes; shutdown
          // drains the task before closing SQLite.
          await alerts.raise("runtime_lease", "immediate", "The queue bot lost its singleton database lease and is shutting down.", clock.now());
        } catch (error) {
          logger.error("runtime_lease_alert_failed", { error: safeErrorDescription(error) });
        }
        return;
      }
    }
    });
  };

  try {
    pollingPromise = bot.start({
      allowed_updates: ["message", "callback_query", "channel_post", "edited_channel_post"],
      onStart: async (botInfo) => {
        startBackgroundWork();
        runtimeStatus.writeReady(botInfo.id);
      },
    });
    await pollingPromise;
  } catch (error) {
    if (!stopped) logger.error("polling_stopped", { error: safeErrorDescription(error) });
  } finally {
    if (!stopped) await shutdown("polling_exit");
  }
};

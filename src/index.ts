import { Bot } from "grammy";
import { parseConfig } from "./config";
import { createLogger, safeErrorDescription } from "./logger";
import { createDatabase } from "./db/database";
import { createAdminRepository } from "./db/admin-repository";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository, createScheduleRepository } from "./db/repositories";
import { createRuntimeLease } from "./db/runtime";
import { createTelegramGateway } from "./telegram";
import { createIngestionService } from "./services/ingestion";
import { createPublicationService } from "./services/publisher";
import { createRenewalService } from "./services/renewal";
import { createSchedulerService } from "./services/scheduler";
import { registerAdminHandlers } from "./handlers/admin";
import { registerQueueChannelHandlers } from "./handlers/queue-channel";
import { adminChatIdFromUserId, createRecoveryService } from "./services/recovery";
import { systemClock } from "./types";

const RENEWAL_INTERVAL_MS = 15 * 60_000;
const RENEWAL_START_AGE_MS = 36 * 60 * 60_000;

const main = async (): Promise<void> => {
  const config = parseConfig();
  const logger = createLogger(config.logLevel);
  const database = createDatabase(config.databasePath);
  const queue = createQueueRepository(database);
  const policy = createPolicyRepository(database);
  const schedule = createScheduleRepository(database);
  const admin = createAdminRepository(database);
  const generated = createGeneratedMessageRepository(database);
  const runtime = createRuntimeLease(database, `${process.pid}-${Date.now()}`, systemClock);
  if (!runtime.acquire()) {
    logger.error("singleton_conflict", { error: "Another healthy queue bot process owns the database" });
    database.close();
    return;
  }
  const bot = new Bot(config.botToken);
  const adminChatId = adminChatIdFromUserId(config.adminUserId);
  const gateway = createTelegramGateway(bot.api, adminChatId);
  let stopped = false;
  let stopBackground = (): void => {};

  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    logger.info("shutdown_started", { signal });
    stopBackground();
    bot.stop();
    try {
      database.raw.exec("PRAGMA wal_checkpoint(PASSIVE)");
      database.raw.query("UPDATE app_state SET last_clean_shutdown_at = ? WHERE id = 1").run(Date.now());
      runtime.release();
    } finally {
      database.close();
    }
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

  try {
    const identity = await gateway.getBotIdentity();
    database.raw.query("UPDATE app_state SET bot_id = ?, bot_username = ? WHERE id = 1").run(identity.id, identity.username ?? null);
    const [queueChat, targetChat] = await Promise.all([gateway.getChat(config.queueChannelId), gateway.getChat(config.targetChannelId)]);
    if (queueChat.type !== "channel" || targetChat.type !== "channel") throw new Error("QUEUE_CHANNEL_ID and TARGET_CHANNEL_ID must both resolve to channels");
    const [queueMembership, targetMembership] = await Promise.all([gateway.getBotMembership(config.queueChannelId, identity.id), gateway.getBotMembership(config.targetChannelId, identity.id)]);
    if (!queueMembership.canPostMessages || !queueMembership.canDeleteMessages) throw new Error("Bot needs can_post_messages and can_delete_messages in the queue channel");
    if (!targetMembership.canPostMessages || !targetMembership.canEditMessages || !targetMembership.canDeleteMessages) throw new Error("Bot needs post, edit, and delete rights in the destination channel");
    logger.info("telegram_rights_validated", { botId: identity.id, queueChatId: config.queueChannelId, targetChatId: config.targetChannelId });
  } catch (error) {
    logger.error("startup_rights_check_failed", { error: safeErrorDescription(error) });
    try { await gateway.sendAdminMessage({ chatId: adminChatId, text: `Queue bot cannot start: ${safeErrorDescription(error)}` }); }
    catch (alertError) { logger.error("startup_admin_alert_failed", { error: safeErrorDescription(alertError) }); }
    await shutdown("startup_failure");
    return;
  }

  const recoveredOperations = queue.recoverExpiredOperations(Date.now());
  if (recoveredOperations.length > 0) logger.warn("startup_operations_recovered", { count: recoveredOperations.length });

  const ingestion = createIngestionService({ queueChannelId: config.queueChannelId, queue, policy, generated, logger, now: systemClock.now });
  const publisher = createPublicationService({ queue, policy, gateway, queueChannelId: config.queueChannelId, targetChannelId: config.targetChannelId, clock: systemClock, logger });
  const renewal = createRenewalService({ queue, policy, generated, gateway, queueChannelId: config.queueChannelId, clock: systemClock, logger });
  const scheduler = createSchedulerService({ schedule, publisher, clock: systemClock, logger });
  const recovery = createRecoveryService({ queue, policy, gateway, queueChannelId: config.queueChannelId, adminChatId, clock: systemClock, logger });
  registerQueueChannelHandlers(bot, ingestion);
  registerAdminHandlers(bot, {
    config,
    queue,
    policy,
    schedule,
    admin,
    gateway,
    publisher,
    scheduler,
    recovery,
    logger,
    now: systemClock.now,
  });
  stopBackground = scheduler.stop;
  bot.catch((error) => {
    logger.error("polling_error", { error: safeErrorDescription(error.error) });
  });

  const renewalLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await renewal.renewNext(RENEWAL_START_AGE_MS);
      } catch (error) {
        logger.error("renewal_worker_failed", { error: safeErrorDescription(error) });
      }
      await systemClock.sleep(RENEWAL_INTERVAL_MS);
    }
  };
  const albumLoop = async (): Promise<void> => {
    while (!stopped) {
      try { ingestion.finalizeAlbums(); }
      catch (error) { logger.error("album_finalizer_failed", { error: safeErrorDescription(error) }); }
      await systemClock.sleep(1_000);
    }
  };
  const leaseLoop = async (): Promise<void> => {
    while (!stopped) {
      await systemClock.sleep(20_000);
      if (!runtime.heartbeat()) {
        logger.error("singleton_lease_lost", {});
        await shutdown("lease_lost");
        return;
      }
    }
  };
  void renewalLoop();
  void albumLoop();
  void leaseLoop();
  void scheduler.run();

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

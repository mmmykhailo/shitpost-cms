import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import type { Logger } from "../src/logger";
import { main as applicationMain, waitForShutdownStage, type ApplicationOptions } from "../src/application";
import { main, runEntrypoint } from "../src/index";
import { createDatabase } from "../src/db/database";
import { createRuntimeLease } from "../src/db/runtime";
import { createQueueRepository } from "../src/db/repositories";
import { asChatId, asMessageId, asUserId, type Clock } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";

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

const adminResponseRows = (databasePath: string): Array<{ state: string; text: string }> => {
  const database = createDatabase(databasePath);
  try {
    const rows = database.raw.query("SELECT state, descriptor_json FROM admin_response_outbox ORDER BY created_at, id").all() as Array<{ state: string; descriptor_json: string }>;
    return rows.map((row) => ({ state: row.state, text: (JSON.parse(row.descriptor_json) as { text: string }).text }));
  } finally {
    database.close();
  }
};

const makeApplicationHarness = () => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-application-"));
  const config = {
    botToken: "test-token",
    adminUserId: asUserId(42),
    queueChannelId: asChatId(-1001234567890),
    targetChannelId: asChatId(-1009876543210),
    databasePath: join(directory, "bot.sqlite"),
    dataDirectory: directory,
    logLevel: "error" as const,
    releaseSha: "development",
  };
  const { logger, events } = loggerSpy();
  const statusEvents: string[] = [];
  const runtimeStatus = {
    writeStarting: () => statusEvents.push("starting"),
    writeReady: (botId: number) => statusEvents.push(`ready:${botId}`),
    writeStopping: () => statusEvents.push("stopping"),
    remove: () => statusEvents.push("remove"),
  };
  const signalHandlers = new Map<string, () => void>();
  const adminAlerts: string[] = [];
  const processLike = {
    pid: 77,
    exitCode: 0,
    once: (signal: "SIGINT" | "SIGTERM", listener: () => void) => { signalHandlers.set(signal, listener); },
  };
  let startMode: "success" | "reject" = "success";
  const bot = new Bot(config.botToken, { botInfo: {
    id: 9001,
    is_bot: true,
    first_name: "Test Bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } });
  (bot as unknown as { start: (options: { onStart?: (botInfo: unknown) => Promise<void> }) => Promise<void> }).start = async (options) => {
    if (startMode === "reject") throw new Error("polling failed");
    await options.onStart?.({ id: 9001, is_bot: true, first_name: "Test Bot", username: "test_bot" });
  };
  (bot as unknown as { stop: () => Promise<void> }).stop = async () => { events.push("bot_stop"); };
  const gateway = {
    getBotIdentity: async () => ({ id: asUserId(9001), username: "test_bot" }),
    getChat: async (chatId: number) => ({ id: asChatId(Number(chatId)), type: "channel" as const }),
    getBotMembership: async () => ({ status: "administrator" as const, canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
    forwardMessages: async ({ messageIds }: { messageIds: readonly number[] }) => messageIds.map((id) => asMessageId(Number(id) + 1000)),
    copyMessages: async ({ messageIds }: { messageIds: readonly number[] }) => messageIds.map((id) => asMessageId(Number(id) + 1000)),
    forwardMessage: async () => ({ message_id: 1000 }),
    editText: async ({ messageId }: { messageId: number }) => ({ messageId: asMessageId(messageId) }),
    editCaption: async ({ messageId }: { messageId: number }) => ({ messageId: asMessageId(messageId) }),
    sendText: async () => asMessageId(1000),
    deleteMessages: async () => {},
    sendAdminMessage: async ({ text }: { text: string }) => { adminAlerts.push(text); return asMessageId(1001); },
    editAdminMessage: async () => {},
    answerCallbackQuery: async () => {},
  } as unknown as TelegramGateway;
  const clock: Clock = { now: () => 1_000_000, sleep: () => new Promise<void>(() => {}) };
  const options: ApplicationOptions = {
    config,
    logger,
    bot,
    gateway,
    clock,
    bootId: "test-boot",
    process: processLike,
    runtimeStatus,
    installSignalHandlers: true,
  };
  return {
    directory,
    config,
    logger,
    events,
    statusEvents,
    adminAlerts,
    signalHandlers,
    gateway,
    bot,
    options,
    setStartMode: (mode: "success" | "reject") => { startMode = mode; },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
};

describe("application composition", () => {
  test("exports an import-safe runner without starting polling", () => {
    expect(main).toBeFunction();
    expect(applicationMain).toBe(main);
    expect(runEntrypoint).toBeFunction();
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  test("converts a startup exception into the executable entrypoint exit status", async () => {
    const previousToken = process.env.BOT_TOKEN;
    const previousError = console.error;
    process.env.BOT_TOKEN = "";
    process.exitCode = 0;
    console.error = () => {};
    try {
      await runEntrypoint();
      expect(process.exitCode).toBe(1);
    } finally {
      if (previousToken === undefined) delete process.env.BOT_TOKEN;
      else process.env.BOT_TOKEN = previousToken;
      process.exitCode = 0;
      console.error = previousError;
    }
  });

  test("waits for a successful shutdown stage", async () => {
    const { logger, events } = loggerSpy();
    expect(await waitForShutdownStage("complete", async () => "done", 100, logger)).toBe(true);
    expect(events).toEqual([]);
  });

  test("records rejected, timed-out, and immediately expired shutdown stages", async () => {
    const { logger, events } = loggerSpy();
    expect(await waitForShutdownStage("rejected", async () => { throw new Error("boom"); }, 100, logger)).toBe(false);
    expect(await waitForShutdownStage("expired", async () => undefined, 0, logger)).toBe(false);
    expect(await waitForShutdownStage("timed_out", () => new Promise<void>(() => {}), 1, logger)).toBe(false);
    expect(events).toEqual(["warn:shutdown_stage_failed", "error:shutdown_stage_timeout", "error:shutdown_stage_timeout"]);
  });

  test("runs startup, validates rights, starts workers, and shuts down in order with injected resources", async () => {
    const harness = makeApplicationHarness();
    try {
      await applicationMain(harness.options);
      expect(harness.statusEvents).toEqual(["starting", "ready:9001", "stopping", "remove"]);
      expect(harness.events).toContain("bot_stop");
      expect(harness.signalHandlers.has("SIGINT")).toBe(true);
      expect(harness.signalHandlers.has("SIGTERM")).toBe(true);
      expect(harness.options.process?.exitCode).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  test("groups terminal orphan IDs by item and generation with current-source context", async () => {
    const harness = makeApplicationHarness();
    const database = createDatabase(harness.config.databasePath);
    const queue = createQueueRepository(database);
    const item = queue.observeQueueSnapshot(snapshotFixture({
      chatId: harness.config.queueChannelId,
      messageId: asMessageId(40),
      telegramDate: 1_000_000 - 36 * 60 * 60_000,
    }), 1_000_000).item;
    database.raw.query("UPDATE queue_items SET maintenance_status = 'uncertain_renewal' WHERE id = ?").run(item.id);
    const insert = database.raw.query("INSERT INTO orphaned_sources (item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, attempt_count, next_attempt_at, terminal_reason) VALUES (?, ?, ?, ?, 'age_limit', ?, ?, 1, NULL, 'telegram_age_limit')");
    insert.run(item.id, 0, Number(harness.config.queueChannelId), 5001, 900_000, 900_000);
    insert.run(item.id, 0, Number(harness.config.queueChannelId), 5002, 900_001, 900_001);
    insert.run(item.id, 1, Number(harness.config.queueChannelId), 5003, 900_002, 900_002);
    database.close();
    try {
      await applicationMain(harness.options);

      const responseRows = adminResponseRows(harness.config.databasePath);
      const responses = responseRows.map((row) => row.text);
      const orphanAlerts = responses.filter((message) => message.includes("Orphaned sources for queue item"));
      expect(orphanAlerts).toHaveLength(2);
      expect(orphanAlerts).toContain("[immediate] Orphaned sources for queue item #1, generation 0, are past Telegram's deletion age limit and require manual cleanup. Old source IDs: 5001, 5002. Current generation 0 source IDs: 40.");
      expect(orphanAlerts).toContain("[immediate] Orphaned sources for queue item #1, generation 1, are past Telegram's deletion age limit and require manual cleanup. Old source IDs: 5003. Current generation 0 source IDs: 40.");
      expect(responses).toContain("[critical] Renewal capacity is unsafe: due uncertain renewals require admin resolution for item(s) #1.");
      expect(responseRows.filter((row) => row.text.includes("Orphaned sources for queue item")).every((row) => row.state === "pending")).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  test("reports identity and permission startup failures while still releasing the lease", async () => {
    const cases = [
      { name: "identity", apply: (gateway: TelegramGateway) => { gateway.getBotIdentity = async () => { throw new Error("identity unavailable"); }; } },
      { name: "queue chat", apply: (gateway: TelegramGateway) => { gateway.getChat = async () => ({ id: asChatId(-1001234567890), type: "group" }) as never; } },
      { name: "queue rights", apply: (gateway: TelegramGateway) => { gateway.getBotMembership = async (chatId: number) => ({ status: "administrator", canPostMessages: Number(chatId) !== -1001234567890, canDeleteMessages: true, canEditMessages: true }) as never; } },
      { name: "target rights", apply: (gateway: TelegramGateway) => { gateway.getBotMembership = async (chatId: number) => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: Number(chatId) !== -1009876543210 }) as never; } },
    ];
    for (const entry of cases) {
      const harness = makeApplicationHarness();
      try {
        entry.apply(harness.gateway);
        await applicationMain(harness.options);
        expect(harness.statusEvents).toEqual(["starting", "stopping", "remove"]);
        const startupResponses = adminResponseRows(harness.config.databasePath).filter((row) => row.text.includes("Queue bot cannot start:"));
        expect(startupResponses).toHaveLength(1);
        expect(startupResponses[0]?.state).toBe("pending");
      } finally {
        harness.cleanup();
      }
    }
  });

  test("handles singleton conflicts, polling rejection, and status write failures without starting workers", async () => {
    const conflict = makeApplicationHarness();
    const conflictDatabase = createDatabase(conflict.config.databasePath);
    const owner = createRuntimeLease(conflictDatabase, "other-owner", conflict.options.clock!);
    expect(owner.acquire()).toBe(true);
    try {
      await applicationMain(conflict.options);
      expect(conflict.statusEvents).toEqual([]);
    } finally {
      conflictDatabase.close();
      conflict.cleanup();
    }

    const polling = makeApplicationHarness();
    polling.setStartMode("reject");
    try {
      await applicationMain(polling.options);
      expect(polling.events).toContain("bot_stop");
      expect(polling.statusEvents).toEqual(["starting", "stopping", "remove"]);
    } finally {
      polling.cleanup();
    }

    const statusFailure = makeApplicationHarness();
    statusFailure.options.runtimeStatus = {
      writeStarting: () => { throw new Error("status unavailable"); },
      writeReady: () => {},
      writeStopping: () => {},
      remove: () => {},
    };
    await expect(applicationMain(statusFailure.options)).rejects.toThrow("status unavailable");
    statusFailure.cleanup();
  });
});

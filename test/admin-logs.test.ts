import { afterEach, describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "@grammyjs/types";
import { registerAdminHandlers } from "../src/handlers/admin";
import { createAdminRepository } from "../src/db/admin-repository";
import { createAdminResponseRepository } from "../src/db/admin-response-repository";
import { createAdminUpdateRepository } from "../src/db/admin-update-repository";
import { createPolicyRepository, createQueueRepository, createScheduleRepository } from "../src/db/repositories";
import type { RecentLogRepository } from "../src/db/recent-log-repository";
import type { LogLevel } from "../src/config";
import type { LogFields } from "../src/logger";
import { asUserId } from "../src/types";
import { createTestDatabase } from "./support";

const NOW = 1_800_000_000_000;
const resources: Array<{ close(): void }> = [];
afterEach(() => { while (resources.length) resources.pop()!.close(); });
type Row = { id: number; at: number; level: LogLevel; event: string; fields: LogFields };
const row = (id: number, level: LogLevel = "info", fields: LogFields = {}): Row => ({ id, at: NOW + id, level, event: `event_${id}`, fields });
const botInfo: UserFromGetMe = { id: 9001, is_bot: true, first_name: "Bot", username: "test_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
const command = (updateId: number, text = "/logs", userId = 42, chatType: "private" | "group" = "private"): Update => ({
  update_id: updateId,
  message: { message_id: updateId, date: 1, chat: chatType === "private" ? { id: userId, type: "private", first_name: "User" } : { id: -123, type: "group", title: "Group" }, from: { id: userId, is_bot: false, first_name: "User" }, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] },
});
const open = (rows?: Row[]) => {
  const resource = createTestDatabase("admin-logs");
  resources.push(resource);
  const admin = createAdminRepository(resource.database);
  const responses = createAdminResponseRepository(resource.database);
  const updates = createAdminUpdateRepository(resource.database);
  const reads: Array<{ level?: LogLevel; limit?: number }> = [];
  const recentLogs = rows === undefined ? undefined : {
    recent: (options: { level?: LogLevel; limit?: number } = {}) => {
      reads.push(options);
      return rows.filter((entry) => options.level === undefined || ["debug", "info", "warn", "error"].indexOf(entry.level) >= ["debug", "info", "warn", "error"].indexOf(options.level)).slice(0, options.limit);
    },
  } as RecentLogRepository;
  const bot = new Bot("test-token", { botInfo });
  const calls: string[] = [];
  bot.api.config.use(async (_previous, method) => { calls.push(String(method)); return { ok: true, result: true } as never; });
  type Deps = Parameters<typeof registerAdminHandlers>[1];
  registerAdminHandlers(bot, {
    admin, responses, updates, bootId: "test", now: () => NOW,
    config: { adminUserId: asUserId(42) },
    queue: createQueueRepository(resource.database, { bootId: "test" }),
    policy: createPolicyRepository(resource.database), schedule: createScheduleRepository(resource.database),
    scheduler: { nextAt: () => undefined },
    ...(recentLogs === undefined ? {} : { recentLogs }),
  } as Deps);
  const views = () => (resource.database.raw.query("SELECT descriptor_json FROM admin_response_outbox ORDER BY created_at, rowid").all() as Array<{ descriptor_json: string }>).map((entry) => JSON.parse(entry.descriptor_json) as { text: string; disableLinkPreview?: boolean; replyMarkup?: { rows: Array<Array<{ text: string; action: string; payload: unknown }>> } });
  return { bot, admin, updates, reads, calls, views };
};

describe("private admin logs", () => {
  test("queues newest logs durably, supports level/count arguments and coalesces views", async () => {
    const h = open([row(3, "error", { itemId: 7, reason: "failed" }), row(2), row(1, "error")]);
    await h.bot.handleUpdate(command(1));
    expect(h.reads).toEqual([{ limit: 20 }]);
    expect(h.views()[0]).toMatchObject({ disableLinkPreview: true });
    expect(h.views()[0]!.text).toContain(`${new Date(NOW + 3).toISOString()} ERROR event_3 · itemId=7 · reason=failed`);
    expect(h.views()[0]!.text.indexOf("event_3")).toBeLessThan(h.views()[0]!.text.indexOf("event_2"));
    expect(h.calls).toEqual([]);
    await h.bot.handleUpdate(command(2, "/logs error 1"));
    expect(h.reads[1]).toEqual({ level: "error", limit: 1 });
    expect(h.views()).toHaveLength(1);
    expect(h.views()[0]!.text).not.toContain("event_2");
    await h.bot.handleUpdate(command(3, "/logs 10"));
    expect(h.reads[2]).toEqual({ limit: 10 });
  });

  test("does not expose logs to other users or groups", async () => {
    const h = open([row(1)]);
    await h.bot.handleUpdate(command(1, "/logs", 77));
    await h.bot.handleUpdate(command(2, "/logs", 42, "group"));
    expect(h.reads).toEqual([]);
    expect(h.views()).toEqual([]);
    expect(h.calls).toEqual(["sendMessage"]);
    expect(h.updates.find(1)).toBeUndefined();
  });

  test("duplicate receipts do not reread logs and commands preserve pending prompts", async () => {
    const h = open([row(1)]);
    h.admin.setPrompt(42, "alias_add", {}, undefined, NOW);
    await h.bot.handleUpdate(command(10));
    await h.bot.handleUpdate(command(10));
    expect(h.reads).toHaveLength(1);
    expect(h.admin.getPrompt(42, NOW)?.kind).toBe("alias_add");
    expect(h.updates.find(10)?.state).toBe("applied");
  });

  test("rejects invalid arguments without reading logs", async () => {
    const h = open([]);
    for (const [index, args] of ["0", "51", "-1", "error 5 extra", "trace", "2 error", "1.5", "01"].entries()) await h.bot.handleUpdate(command(index + 1, `/logs ${args}`));
    expect(h.reads).toEqual([]);
    expect(h.views()).toHaveLength(8);
    expect(h.views().every((view) => view.text.startsWith("Usage: /logs"))).toBe(true);
  });

  test("has explicit empty and unavailable states", async () => {
    const empty = open([]);
    await empty.bot.handleUpdate(command(1, "/logs warn"));
    expect(empty.reads).toEqual([{ level: "warn", limit: 20 }]);
    expect(empty.views()[0]!.text).toContain("No recent logs found.");
    const missing = open();
    await missing.bot.handleUpdate(command(1));
    expect(missing.views()[0]!.text).toContain("Logs are unavailable.");
  });

  test("bounds logs and normalizes field text to one line", async () => {
    const h = open(Array.from({ length: 50 }, (_, i) => row(50 - i, "error", { reason: `bad\n${"😀".repeat(200)}`, long: "x".repeat(300) })));
    await h.bot.handleUpdate(command(1, "/logs 50"));
    const text = h.views()[0]!.text;
    expect(text.length).toBeLessThanOrEqual(3900);
    expect(text).toContain("reason=bad ");
    expect(text).toContain("More details omitted. Use /logs with a smaller count.");
    expect(text).not.toContain("event_1 ·");
  });

  test("summarizes excessive fields and long labels without splitting surrogate pairs", async () => {
    const event = row(1, "debug", { ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["x".repeat(50) + i, "a".repeat(98) + "😀"])), omitted: undefined });
    event.event = "a".repeat(118) + "😀" + "end";
    const h = open([event]);
    await h.bot.handleUpdate(command(1, "/logs debug 50"));
    const text = h.views()[0]!.text;
    expect(h.reads).toEqual([{ level: "debug", limit: 50 }]);
    expect(text).toContain("DEBUG");
    expect(text).toContain("More details omitted");
    expect(text).not.toContain("omitted=");
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  test("dashboard logs action opens the same private durable view", async () => {
    const h = open([row(1)]);
    await h.bot.handleUpdate(command(1, "/manage"));
    expect(h.views()[0]!.replyMarkup?.rows.flat()).toContainEqual({ text: "Logs", action: "logs", payload: {} });
    const token = h.admin.createCallbackToken(42, "logs", {}, NOW);
    await h.bot.handleUpdate({ update_id: 2, callback_query: { id: "logs-callback", chat_instance: "test", from: { id: 42, first_name: "Admin", is_bot: false }, message: command(9).message!, data: `v1:${token}` } });
    expect(h.reads).toEqual([{ limit: 20 }]);
    expect(h.views()[1]!.text).toContain("event_1");
    expect(h.calls).toEqual(["answerCallbackQuery"]);
  });
});

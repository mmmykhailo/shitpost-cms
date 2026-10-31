import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type AppDatabase } from "../src/db/database";
import { createRecentLogRepository } from "../src/db/recent-log-repository";
import { sanitizeRecentLog, withRecentLogs, type Logger, type LogFields } from "../src/logger";

const resources: Array<{ directory: string; database: AppDatabase }> = [];
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.database.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});
const open = () => {
  const directory = mkdtempSync(join(tmpdir(), "recent-log-test-"));
  const resource = { directory, database: createDatabase(join(directory, "bot.sqlite")) };
  resources.push(resource);
  return resource;
};

describe("recent operational logs", () => {
  test("persist across restart, order newest first, and filter by minimum severity", () => {
    const resource = open();
    let logs = createRecentLogRepository(resource.database);
    const now = Date.now();
    logs.append({ at: now, level: "info", event: "import_started", fields: { itemId: 1 } });
    logs.append({ at: now + 1, level: "warn", event: "import_retry", fields: { itemId: 1 } });
    logs.append({ at: now + 1, level: "error", event: "import_failed", fields: { kind: "network" } });
    resource.database.close();
    resource.database = createDatabase(join(resource.directory, "bot.sqlite"));
    logs = createRecentLogRepository(resource.database);
    expect(logs.recent().map((row) => row.event)).toEqual(["import_failed", "import_retry", "import_started"]);
    expect(logs.recent({ level: "warn" }).map((row) => row.level)).toEqual(["error", "warn"]);
    expect(logs.recent({ level: "error" })[0]?.fields).toEqual({ kind: "network" });
    expect(logs.recent({ limit: 1 })).toHaveLength(1);
    expect(logs.recent({ limit: Number.NaN })).toHaveLength(3);
  });

  test("bounds stored logs at 500 and expires entries after seven days including on reopen", () => {
    const resource = open();
    let logs = createRecentLogRepository(resource.database);
    const now = Date.now();
    for (let index = 0; index < 510; index++) logs.append({ at: now + index, level: "info", event: "cycle", fields: { count: index } });
    expect(logs.recent({ limit: 10_000 })).toHaveLength(500);
    expect(logs.recent({ limit: 500 })[499]?.fields.count).toBe(10);
    logs.append({ at: now - 8 * 24 * 60 * 60 * 1_000, level: "info", event: "expired", fields: {} });
    expect(resource.database.raw.query("SELECT count(*) AS count FROM recent_logs WHERE event = 'expired'").get()).toEqual({ count: 0 });
    resource.database.raw.query("UPDATE recent_logs SET at = ?").run(now - 8 * 24 * 60 * 60 * 1_000);
    logs = createRecentLogRepository(resource.database);
    expect(logs.recent()).toEqual([]);
    logs.append({ at: now, level: "debug", event: "debug_event", fields: {} });
    logs.purge(now + 8 * 24 * 60 * 60 * 1_000);
    expect(logs.recent()).toEqual([]);
  });

  test("sanitizes before SQLite, omits content and secrets, and bounds diagnostic fields", () => {
    const { database } = open();
    const logs = createRecentLogRepository(database);
    logs.append({ at: Date.now(), level: "error", event: "import_failed", fields: {
      itemId: 42, caption: "private caption", text: "private message", token: "secret-value",
      url: "https://example.com/private", path: "/private/file", cookie: "session=secret",
      error: "Request failed https://cdn.example/video.mp4?signature=signed-secret 123456:abcdefghijklmnopqrstuvwxyz_0123456789 /tmp/private.mp4",
      reason: "Authorization: Bearer hidden-secret", description: "a".repeat(600), kind: "network", count: Number.NaN,
      state: "https://secret.example", task: "Bearer hidden", phase: null, requestStarted: true,
    } });
    const serialized = JSON.stringify(database.raw.query("SELECT * FROM recent_logs").all());
    for (const secret of ["private caption", "private message", "secret-value", "signed-secret", "hidden-secret", "private.mp4", "abcdefghijklmnopqrstuvwxyz_0123456789", "secret.example"]) expect(serialized).not.toContain(secret);
    const record = logs.recent()[0]!;
    expect(record.fields.itemId).toBe(42);
    expect(record.fields.description).toHaveLength(300);
    expect(record.fields.count).toBeUndefined();
    expect(sanitizeRecentLog("x".repeat(200), {}).event).toHaveLength(100);
    expect(sanitizeRecentLog("https://secret.example", {}).event).toBe("[redacted]");
    expect(sanitizeRecentLog("event", { error: "Cookie: session=hidden; csrf=hidden" }).fields.error).toBe("[redacted]");
  });

  test("logger forwards unchanged, respects storage level and isolates sink failures", () => {
    const calls: Array<[string, string, LogFields | undefined]> = [];
    const capture = (level: string) => (event: string, fields?: LogFields): void => { calls.push([level, event, fields]); };
    const base: Logger = { debug: capture("debug"), info: capture("info"), warn: capture("warn"), error: capture("error") };
    const stored: Array<[string, string, LogFields]> = [];
    const logger = withRecentLogs(base, (level, event, fields) => { stored.push([level, event, fields]); });
    const fields = { itemId: 1, caption: "private caption" };
    logger.debug("debug_event", fields);
    logger.info("info_event", fields);
    logger.warn("warn_event");
    logger.error("error_event");
    expect(calls).toHaveLength(4);
    expect(calls[1]?.[2]).toBe(fields);
    expect(stored.map((row) => row[0])).toEqual(["info", "warn", "error"]);
    expect(stored[0]?.[2]).toEqual({ itemId: 1 });
    const broken = withRecentLogs(base, () => { throw new Error("disk full"); }, "error");
    expect(() => broken.error("failure")).not.toThrow();
    broken.info("ignored");
    expect(calls).toHaveLength(6);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "grammy";
import { createDatabase } from "../src/db/database";
import { createTelegramCooldownRepository } from "../src/db/telegram-cooldown-repository";
import { createTelegramAdmissionRepository } from "../src/db/telegram-admission-repository";
import { createFakeClock } from "../src/clock";
import { classifyTelegramError } from "../src/errors";
import { createTelegramCooldown } from "../src/telegram-cooldown";
import { createTelegramAdmission } from "../src/services/telegram-admission";
import { createLogger } from "../src/logger";

const resources: Array<{ directory: string; close(): void }> = [];

const open = () => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-cooldown-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  resources.push({ directory, close: database.close });
  return { database, repository: createTelegramCooldownRepository(database) };
};

const createApi = (replyForMethod: (method: string) => unknown): { api: Api; calls: string[] } => {
  const calls: string[] = [];
  const api = new Api("123456:test-token", {
    fetch: async (input: RequestInfo | URL) => {
      const method = String(input).split("/").at(-1) ?? "unknown";
      calls.push(method);
      const reply = replyForMethod(method);
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { api, calls };
};

const rejected = async (work: () => Promise<unknown>): Promise<unknown> => {
  try { await work(); }
  catch (error) { return error; }
  throw new Error("Expected the Telegram API call to reject");
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("Telegram cooldown repository", () => {
  test("stores the longest shared deadline as a system-owned setting", () => {
    const { database, repository } = open();
    expect(repository.readNotBefore()).toBe(0);
    expect(repository.extendNotBefore(1_800_000, 100)).toBe(1_800_000);
    expect(repository.extendNotBefore(900_000, 200)).toBe(1_800_000);
    expect(repository.readNotBefore()).toBe(1_800_000);
    expect(database.raw.query("SELECT value_json, schema_version, updated_by_admin_id FROM settings WHERE key = 'telegram_mutation_not_before'").get()).toEqual({
      value_json: "1800000",
      schema_version: 1,
      updated_by_admin_id: null,
    });
  });

  test("retains the deadline after closing and reopening the database", () => {
    const { database, repository } = open();
    const path = database.path;
    repository.extendNotBefore(1_900_000, 100);
    database.close();

    const reopened = createDatabase(path);
    resources[resources.length - 1]!.close = reopened.close;
    expect(createTelegramCooldownRepository(reopened).readNotBefore()).toBe(1_900_000);
  });

  test("surfaces malformed persisted deadlines instead of permitting mutations", () => {
    const { database, repository } = open();
    database.raw.query("INSERT INTO settings (key, value_json, updated_at, updated_by_admin_id) VALUES ('telegram_mutation_not_before', 'null', 100, NULL)").run();
    expect(() => repository.readNotBefore()).toThrow("Invalid persisted Telegram mutation cooldown");
  });

  test("records raw 429 waits, blocks later mutation methods, then allows requests after the full wait", async () => {
    const { database, repository } = open();
    const clock = createFakeClock(100_000);
    const cooldown = createTelegramCooldown({ repository, clock });
    let sendCount = 0;
    const { api, calls } = createApi((method) => method === "sendMessage" && sendCount++ === 0
      ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1_800 } }
      : { ok: true, result: true });
    let floodObservations = 0;
    const admission = createTelegramAdmission({ repository: createTelegramAdmissionRepository(database), cooldown, clock, logger: createLogger("error"), onRealFloodWait: () => { floodObservations += 1; } });
    admission.install(api);

    const firstError = await rejected(() => api.sendMessage(42, "first"));
    expect(classifyTelegramError(firstError)).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 1_800 });
    expect(repository.readNotBefore()).toBe(1_900_000);
    await api.editMessageText(42, 10, "second");
    expect(clock.now()).toBe(1_900_000);
    expect(floodObservations).toBe(1);
    expect(calls).toEqual(["sendMessage", "editMessageText"]);
  });

  test("keeps read-only and callback-control requests available during a mutation cooldown", async () => {
    const { database, repository } = open();
    const clock = createFakeClock(200_000);
    const cooldown = createTelegramCooldown({ repository, clock });
    const { api, calls } = createApi((method) => method === "sendMessage"
      ? { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } }
      : method === "getChat"
        ? { ok: true, result: { id: -100, type: "channel", title: "Queue" } }
        : { ok: true, result: true });
    createTelegramAdmission({ repository: createTelegramAdmissionRepository(database), cooldown, clock, logger: createLogger("error") }).install(api);

    await rejected(() => api.sendMessage(42, "limited"));
    await api.getChat(-100);
    await api.answerCallbackQuery("callback-id");

    expect(calls).toEqual(["sendMessage", "getChat", "answerCallbackQuery"]);
  });

  test("does not turn network failures into a shared flood wait or a second send", async () => {
    const { database, repository } = open();
    const clock = createFakeClock(300_000);
    const cooldown = createTelegramCooldown({ repository, clock });
    const { api, calls } = createApi(() => new TypeError("network disconnected"));
    createTelegramAdmission({ repository: createTelegramAdmissionRepository(database), cooldown, clock, logger: createLogger("error") }).install(api);

    const error = await rejected(() => api.sendMessage(42, "uncertain"));

    expect(classifyTelegramError(error).kind).toBe("transient_network");
    expect(repository.readNotBefore()).toBe(0);
    expect(calls).toEqual(["sendMessage"]);
  });
});

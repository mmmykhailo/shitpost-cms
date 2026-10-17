import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "grammy";
import { createDatabase } from "../src/db/database";
import { createTelegramAdmissionRepository } from "../src/db/telegram-admission-repository";
import { createTelegramCooldownRepository } from "../src/db/telegram-cooldown-repository";
import { TelegramLocalDeferralError, classifyTelegramError } from "../src/errors";
import { createLogger } from "../src/logger";
import { createTelegramAdmission } from "../src/services/telegram-admission";
import { withTelegramMutationScope } from "../src/telegram-request-context";
import { createTelegramCooldown } from "../src/telegram-cooldown";
import { createControlledClock, type TestDatabase } from "./support";

const resources: TestDatabase[] = [];
const open = () => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-admission-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  let closed = false;
  const resource: TestDatabase = { directory, path: database.path, database, close: () => { if (closed) return; closed = true; database.close(); rmSync(directory, { recursive: true, force: true }); } };
  resources.push(resource);
  return { database, repository: createTelegramAdmissionRepository(database), cooldownRepository: createTelegramCooldownRepository(database) };
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const createApi = (fetcher: Fetcher = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } })): Api => new Api("123456:test-token", { fetch: fetcher as typeof fetch });

afterEach(() => { while (resources.length) resources.pop()!.close(); });

describe("shared Telegram admission", () => {
  test("serializes raw mutations and dispatches queued admin work ahead of background work", async () => {
    const { database, repository, cooldownRepository } = open();
    const clock = createControlledClock(100_000);
    const cooldown = createTelegramCooldown({ repository: cooldownRepository, clock });
    const dispatched: string[] = [];
    let releaseCurrent!: () => void;
    let requestEntered!: () => void;
    const entered = new Promise<void>((resolve) => { requestEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    let firstRequest = true;
    const api = createApi(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/sendMessage") && firstRequest) {
        firstRequest = false;
        requestEntered();
        await release;
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const admission = createTelegramAdmission({ repository, cooldown, clock, logger: createLogger("error") });
    admission.install(api);

    const scopedSend = (label: string, priority: "admin" | "background", chatId: number) => withTelegramMutationScope({
      family: priority === "admin" ? "admin_response" : "preparation",
      priority,
      beforeDispatch: () => { dispatched.push(label); },
    }, () => api.sendMessage(chatId, label));

    const active = scopedSend("current", "background", 10);
    await entered;
    const background = scopedSend("background", "background", 20);
    const admin = scopedSend("admin", "admin", 30);
    releaseCurrent();
    await clock.flush();
    expect(dispatched).toEqual(["current"]);
    expect(clock.pendingSleeps()).toEqual([1_000]);
    clock.advance(1_000);
    await clock.flush();
    expect(dispatched).toEqual(["current", "admin"]);
    expect(clock.pendingSleeps()).toEqual([1_000]);
    clock.advance(1_000);
    await clock.flush();
    await Promise.all([active, background, admin]);
    expect(dispatched).toEqual(["current", "admin", "background"]);
    expect(admission.pendingCount).toBe(0);
    void database;
  });

  test("rejects a mutation whose next admission would meet or pass its scheduled deadline without sending", async () => {
    const { database, repository, cooldownRepository } = open();
    const clock = createControlledClock(50_000);
    repository.reserve(10, 1, clock.now());
    let rawCalls = 0;
    const api = createApi(async () => { rawCalls += 1; return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } }); });
    createTelegramAdmission({ repository, cooldown: createTelegramCooldown({ repository: cooldownRepository, clock }), clock, logger: createLogger("error") }).install(api);
    const deadlineError = await withTelegramMutationScope({ family: "publication", priority: "publication", deadlineAt: clock.now() + 3_000 }, () => api.sendMessage(10, "too late")).catch((reason: unknown) => reason);
    expect(classifyTelegramError(deadlineError)).toMatchObject({ kind: "local_deferral", localDeferralReason: "deadline", requestMayHaveSucceeded: false });
    expect(deadlineError).toBeInstanceOf(TelegramLocalDeferralError);
    expect(rawCalls).toBe(0);
    void database;
  });

  test("charges plural mutations by member count in both durable pacing scopes", () => {
    const { database, repository } = open();
    repository.reserve(-200, 10, 200_000);
    expect(repository.readNotBefore("global")).toBe(210_000);
    expect(repository.readNotBefore("chat:-200")).toBe(230_000);
    expect(repository.snapshot()).toHaveLength(2);
    void database;
  });
});

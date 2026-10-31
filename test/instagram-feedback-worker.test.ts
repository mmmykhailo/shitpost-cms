import { afterEach, describe, expect, test } from "bun:test";
import { createInstagramFeedbackRepository } from "../src/db/instagram-feedback-repository";
import { createAdminRepository } from "../src/db/admin-repository";
import { createTelegramCooldownRepository } from "../src/db/telegram-cooldown-repository";
import { createInstagramFeedbackWorker } from "../src/services/instagram-feedback-worker";
import { createTelegramCooldown } from "../src/telegram-cooldown";
import { type TelegramRequestResult, telegramMutationScope } from "../src/telegram-request-context";
import { TelegramLocalDeferralError } from "../src/errors";
import { createFakeClock } from "../src/clock";
import { asMessageId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { createLoggerSpy, createTestDatabase } from "./support";
import type { InstagramProgress } from "../src/services/instagram-feedback";

const NOW = 1_800_000_000_000;
const resources: Array<{ close(): void }> = [];
afterEach(() => { while (resources.length) resources.pop()!.close(); });
const open = (managed = false) => {
  const resource = createTestDatabase("instagram-feedback-worker");
  resources.push(resource);
  const feedback = createInstagramFeedbackRepository(resource.database);
  const admin = createAdminRepository(resource.database);
  const clock = createFakeClock(NOW);
  const cooldown = createTelegramCooldown({ repository: createTelegramCooldownRepository(resource.database), clock });
  const calls: Array<{ action: string; input: unknown }> = [];
  let effect: (action: string) => void | Promise<void> = () => {};
  let wrapperError = false;
  let missingReceipt = false;
  let outcome: TelegramRequestResult | undefined;
  let omitOutcome = false;
  const execute = async (action: string, method: string, body: unknown): Promise<void> => {
    const scope = telegramMutationScope();
    const payload = {};
    if (managed) {
      expect(scope).toMatchObject({ family: "admin_response", priority: "admin", itemId: 1 });
      scope!.beforeDispatch!(method, payload);
    }
    calls.push({ action, input: body });
    await effect(action);
    if (managed && !omitOutcome) scope!.onResult!(outcome ?? { state: "accepted", ...(missingReceipt ? {} : { knownOutputIds: [99] }) });
    if (wrapperError) throw new TypeError("network wrapper failed after accepted");
  };
  const gateway = {
    dispatchManaged: managed,
    sendAdminMessage: async (input: unknown) => { await execute("send", "sendMessage", input); return asMessageId(99); },
    editAdminMessage: async (input: unknown) => { await execute("edit", "editMessageText", input); },
    deleteMessages: async (chatId: unknown, ids: unknown) => { await execute("delete", "deleteMessages", { chatId, ids }); },
  } as unknown as TelegramGateway;
  const { logger } = createLoggerSpy();
  const worker = createInstagramFeedbackWorker({ feedback, admin, clock, cooldown, gateway, logger, bootId: "boot", adminUserId: 42 });
  const update = (phase: InstagramProgress["phase"], text = phase) => feedback.update({ itemId: 1, operationId: "op", adminChatId: 42, phase, text, now: clock.now() });
  const row = () => resource.database.raw.query("SELECT * FROM instagram_feedback WHERE item_id = 1").get() as { state: string; message_id: number | null; last_error_code: string | null; next_attempt_at: number; request_started_at: number | null };
  return { ...resource, worker, feedback, clock, admin, calls, cooldown, update, row, effect: (next: typeof effect) => { effect = next; }, wrapperError: () => { wrapperError = true; }, missingReceipt: () => { missingReceipt = true; }, outcome: (next: TelegramRequestResult) => { outcome = next; }, omitOutcome: () => { omitOutcome = true; } };
};

describe("single Instagram progress PM delivery", () => {
  test("sends once, edits in place, then deletes the progress message on ready", async () => {
    const h = open();
    h.update("downloading");
    expect(await h.worker.runOnce()).toBe(true);
    expect(h.row()).toMatchObject({ state: "idle", message_id: 99 });
    h.update("uploading");
    await h.worker.runOnce();
    h.update("ready");
    await h.worker.runOnce();
    expect(h.calls.map(call => call.action)).toEqual(["send", "edit", "delete"]);
    expect(h.calls[1]!.input).toMatchObject({ messageId: 99, linkPreviewIsDisabled: true, replyMarkup: { inline_keyboard: [] } });
    expect(h.row()).toMatchObject({ state: "idle", message_id: null });
    expect(await h.worker.runOnce()).toBe(false);
  });

  test("keeps the error message and renders its current action tokens", async () => {
    const h = open();
    h.update("downloading"); await h.worker.runOnce();
    h.feedback.update({ itemId: 1, adminChatId: 42, operationId: "op", phase: "failed", text: "Cannot download", replyMarkup: { kind: "inline_keyboard", rows: [[{ text: "Retry", action: "queue_retry", payload: { itemId: 1 }, itemVersion: 3 }]] }, now: NOW });
    await h.worker.runOnce();
    expect(h.calls.map(call => call.action)).toEqual(["send", "edit"]);
    const body = h.calls[1]!.input as { replyMarkup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    const token = body.replyMarkup.inline_keyboard[0]![0]!.callback_data.slice(3);
    expect(h.admin.consumeCallbackToken(42, token, NOW)).toMatchObject({ action: "queue_retry", payload: { itemId: 1 }, itemVersion: 3 });
    expect(h.row()).toMatchObject({ state: "idle", message_id: 99 });
  });

  test("skips a message when the import finishes before its first dispatch", async () => {
    const h = open(); h.update("downloading"); h.update("ready");
    expect(await h.worker.runOnce()).toBe(false);
    expect(h.calls).toEqual([]);
  });

  test("preserves a newer ready revision that arrives during the initial send", async () => {
    const h = open(); h.update("downloading"); h.effect(() => { h.update("ready"); });
    await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "pending", message_id: 99 });
    h.effect(() => {}); await h.worker.runOnce();
    expect(h.calls.map(call => call.action)).toEqual(["send", "delete"]);
  });

  test("managed acceptance stores the message ID even if a gateway wrapper then throws", async () => {
    const h = open(true); h.update("downloading"); h.wrapperError();
    await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "idle", message_id: 99 });
    expect(await h.worker.runOnce()).toBe(false);
    h.update("ready"); await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "idle", message_id: null });
    expect(h.calls.map(call => call.action)).toEqual(["send", "delete"]);
  });

  test("ambiguous initial send becomes uncertain and is never sent again", async () => {
    const h = open(); h.update("downloading"); h.effect(() => { throw new TypeError("network timeout"); });
    await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "uncertain", message_id: null, last_error_code: "uncertain_send" });
    h.update("failed"); h.clock.advance(120_000);
    expect(await h.worker.runOnce()).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  test("accepted initial send without a usable managed receipt is not resent", async () => {
    const h = open(true); h.update("downloading"); h.missingReceipt();
    await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "uncertain", last_error_code: "missing_delivery_receipt" });
    expect(await h.worker.runOnce()).toBe(false);
  });

  test.each(["edit", "delete"])("network failure safely retries %s using the existing message ID", async action => {
    const h = open(); h.update("downloading"); await h.worker.runOnce();
    h.update(action === "edit" ? "uploading" : "ready");
    h.effect(() => { throw new TypeError("network timeout"); });
    await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "pending", message_id: 99 });
    expect(await h.worker.runOnce()).toBe(false);
    h.clock.advance(5_000); h.effect(() => {}); await h.worker.runOnce();
    expect(h.calls.map(call => call.action)).toEqual(["send", action, action]);
  });

  test.each([
    ["uploading", "Bad Request: message is not modified"],
    ["ready", "Bad Request: message to delete not found"],
  ] as const)("treats idempotent %s result as success", async (phase, description) => {
    const h = open(); h.update("downloading"); await h.worker.runOnce(); h.update(phase);
    h.effect(() => { throw { error_code: 400, description }; });
    await h.worker.runOnce();
    expect(h.row().state).toBe("idle");
    expect(await h.worker.runOnce()).toBe(false);
  });

  test("missing edit target fails without sending a replacement", async () => {
    const h = open(); h.update("downloading"); await h.worker.runOnce(); h.update("uploading");
    h.effect(() => { throw { error_code: 400, description: "Bad Request: message to edit not found" }; });
    await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "failed", message_id: 99, last_error_code: "source_missing" });
    expect(await h.worker.runOnce()).toBe(false);
    expect(h.calls.map(call => call.action)).toEqual(["send", "edit"]);
  });

  test("rate limits defer safely and respect the shared cooldown", async () => {
    const h = open(); h.update("downloading");
    h.effect(() => { throw { error_code: 429, description: "Too many requests", parameters: { retry_after: 30 } }; });
    await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "pending", next_attempt_at: NOW + 30_000 });
    expect(h.cooldown.notBefore()).toBe(NOW + 30_000);
    expect(await h.worker.runOnce()).toBe(false);
    h.clock.advance(30_000); h.effect(() => {}); await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "idle", message_id: 99 });
  });

  test("definite permission failures retain diagnostics and stop automatic attempts", async () => {
    const h = open(); h.update("downloading");
    h.effect(() => { throw { error_code: 403, description: "Forbidden: bot was blocked" }; });
    await h.worker.runOnce();
    expect(h.row().last_error_code).toBe("permission_denied");
    h.clock.advance(60_000); expect(await h.worker.runOnce()).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  test("a local deferral retries without marking an unknown send", async () => {
    const h = open(); h.update("downloading");
    h.effect(() => { throw new TelegramLocalDeferralError("shared_cooldown", NOW + 3_000); });
    await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "pending", next_attempt_at: NOW + 3_000 });
  });

  test.each([
    [{ state: "unknown" }, "uncertain", "uncertain_send"],
    [{ state: "rejected", errorKind: "rate_limited" }, "pending", "rate_limited"],
    [{ state: "rejected", errorKind: "permission_denied" }, "uncertain", "permission_denied"],
    [{ state: "rejected", errorKind: "transient_server" }, "pending", "transient_server"],
  ] as const)("managed send receipt %j preserves safe delivery state", async (outcome, state, code) => {
    const h = open(true); h.update("downloading"); h.outcome(outcome);
    await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state, last_error_code: code });
  });

  test("unknown edit receipts retry and a missing delete receipt converges safely", async () => {
    const h = open(true); h.update("downloading"); await h.worker.runOnce(); h.update("uploading");
    h.outcome({ state: "unknown", errorKind: "transient_network" }); await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "pending", last_error_code: "transient_network" });
    h.update("ready"); h.outcome({ state: "rejected", errorKind: "source_missing" }); await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "idle", message_id: null });
  });

  test("managed gateways without a receipt never blindly resend the first PM", async () => {
    const h = open(true); h.update("downloading"); h.omitOutcome(); await h.worker.runOnce();
    expect(h.row()).toMatchObject({ state: "uncertain", last_error_code: "missing_delivery_receipt" });
  });

  test("the run loop backs off after repository errors and stops when aborted", async () => {
    const h = open(); const controller = new AbortController(); const spy = createLoggerSpy();
    h.feedback.claim = () => { throw new Error("database unavailable"); };
    const worker = createInstagramFeedbackWorker({ feedback: h.feedback, admin: h.admin, gateway: {} as TelegramGateway, bootId: "boot", adminUserId: 42, logger: spy.logger, clock: { now: () => NOW, sleep: async () => { controller.abort(); } } });
    await worker.run(controller.signal);
    expect(spy.entries).toContainEqual({ level: "error", event: "instagram_feedback_worker_failed", fields: { error: "database unavailable" } });
  });

  test("the run loop exits on cancellation", async () => {
    const h = open(); const controller = new AbortController(); controller.abort();
    await h.worker.run(controller.signal);
    expect(h.calls).toEqual([]);
  });
});

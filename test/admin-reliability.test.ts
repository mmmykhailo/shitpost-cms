import { afterEach, describe, expect, test } from "bun:test";
import { asMessageId, asUserId } from "../src/types";
import { createAdminRepository } from "../src/db/admin-repository";
import { createAdminResponseRepository } from "../src/db/admin-response-repository";
import { createAdminUpdateRepository } from "../src/db/admin-update-repository";
import type { AdminResponseState } from "../src/db/admin-response-repository";
import { createTelegramIncidentRepository } from "../src/db/telegram-incident-repository";
import { createTelegramIncidentService } from "../src/services/telegram-incidents";
import { createAdminResponseWorker } from "../src/services/admin-response-worker";
import { createFakeClock } from "../src/clock";
import { safeErrorDescription, type Logger } from "../src/logger";
import type { TelegramGateway } from "../src/telegram";
import { TelegramLocalDeferralError } from "../src/errors";
import { telegramMutationScope, type TelegramRequestResult } from "../src/telegram-request-context";
import { createTestDatabase } from "./support";

const resources: Array<{ close(): void }> = [];
const open = () => {
  const resource = createTestDatabase("admin-reliability");
  resources.push(resource);
  return {
    ...resource,
    admin: createAdminRepository(resource.database),
    responses: createAdminResponseRepository(resource.database),
    updates: createAdminUpdateRepository(resource.database),
    incidents: createTelegramIncidentRepository(resource.database),
  };
};
const NOW = 1_800_000_000_000;
const ADMIN_ID = asUserId(42);
const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

afterEach(() => { while (resources.length) resources.pop()!.close(); });

describe("admin update receipts", () => {
  test("deduplicates input, defers work, and reconciles a bound manual publication only once", () => {
    const { updates } = open();
    expect(updates.begin({ updateId: 10, adminId: Number(ADMIN_ID), actionKind: "callback", actionPayload: {}, bootId: "boot-a", now: NOW })).toBe(true);
    expect(updates.begin({ updateId: 10, adminId: Number(ADMIN_ID), actionKind: "callback", actionPayload: {}, bootId: "boot-a", now: NOW })).toBe(false);
    expect(updates.defer(10, "manual_publish", { itemId: 7 }, NOW + 1)).toBe(true);
    const claim = updates.claimNext("boot-a", NOW + 2)!;
    expect(updates.setOperationId(claim.updateId, claim.claimToken, "publication-7", NOW + 3)).toBe(true);
    expect(updates.markInterruptedUncertain(NOW + 4)).toBe(1);
    expect(updates.find(10)).toMatchObject({ state: "uncertain", operationId: "publication-7" });

    const reconcile = updates.claimManualPublishReconciliation("boot-b", NOW + 5)!;
    expect(reconcile).toMatchObject({ updateId: 10, actionKind: "manual_publish", operationId: "publication-7", reconcileOnly: true });
    expect(updates.finish(10, "uncertain", { reconciliationAttempted: true }, NOW + 6, reconcile.claimToken)).toBe(true);
    expect(updates.claimManualPublishReconciliation("boot-b", NOW + 7)).toBeUndefined();
  });

  test("requeues only actions with a safe restart boundary and keeps uncertain actions out of normal claims", () => {
    const { updates } = open();
    for (const [updateId, kind] of [[20, "set_commands"], [21, "manual_publish"], [22, "recover"]] as const) {
      updates.begin({ updateId, adminId: Number(ADMIN_ID), actionKind: "inbound", actionPayload: {}, bootId: "boot-a", now: NOW });
      updates.defer(updateId, kind, { itemId: updateId }, NOW);
      updates.claimNext("boot-a", NOW + 1);
    }
    expect(updates.markInterruptedUncertain(NOW + 2)).toBe(3);
    expect(updates.find(20)?.state).toBe("queued");
    expect(updates.find(21)?.state).toBe("queued");
    expect(updates.find(22)).toMatchObject({ state: "uncertain", result: { reason: "restart_during_action" } });
    expect(updates.counts()).toEqual({ active: 2, uncertain: 1 });
    expect(updates.claimNext("boot-b", NOW + 3)?.actionKind).toBe("set_commands");
  });

  test("requeues a safely interrupted read-only channel lookup", () => {
    const { updates } = open();
    updates.begin({ updateId: 30, adminId: Number(ADMIN_ID), actionKind: "inbound", actionPayload: {}, bootId: "boot-a", now: NOW });
    updates.defer(30, "whitelist_lookup", { reference: "@public_channel" }, NOW);
    updates.claimNext("boot-a", NOW + 1);
    expect(updates.markInterruptedUncertain(NOW + 2)).toBe(1);
    expect(updates.claimNext("boot-b", NOW + 3)?.actionKind).toBe("whitelist_lookup");
  });
});

describe("admin response outbox", () => {
  test("coalesces only pending views and validates versioned descriptors on writes and reads", () => {
    const { database, responses } = open();
    const first = responses.enqueue({ adminChatId: 42, kind: "view", coalesceKey: "dashboard", descriptor: { version: 1, text: "old" }, now: NOW });
    const newest = responses.enqueue({ adminChatId: 42, kind: "view", coalesceKey: "dashboard", descriptor: { version: 1, text: "new" }, now: NOW + 1 });
    expect(newest.inserted).toBe(false);
    expect(newest.record.id).toBe(first.record.id);
    expect(newest.record.descriptor).toEqual({ version: 1, text: "new" });
    const confirmation = responses.enqueue({ adminChatId: 42, kind: "confirmation", descriptor: { version: 1, text: "saved" }, now: NOW + 2 });
    expect(confirmation.record.id).not.toBe(first.record.id);
    expect(() => responses.enqueue({ adminChatId: 42, kind: "view", descriptor: { version: 2, text: "bad" }, now: NOW })).toThrow("version or text");

    database.raw.query("UPDATE admin_response_outbox SET descriptor_json = ? WHERE id = ?").run('{"version":2,"text":"corrupt"}', first.record.id);
    expect(() => responses.find(first.record.id)).toThrow("version or text");
  });

  test("cancels and re-arms unsent work, acknowledges delivery atomically, and preserves ambiguous sends", () => {
    const { responses } = open();
    const warning = responses.enqueue({ dedupeKey: "incident:one:warning", adminChatId: 42, kind: "warning", descriptor: { version: 1, text: "warning" }, now: NOW }).record;
    let acknowledged = false;
    let claim = responses.claimDue(NOW, "boot-a")!;
    expect(claim.id).toBe(warning.id);
    expect(responses.cancel(warning.id, NOW)).toBe(true);
    expect(responses.rearmCancelled(warning.dedupeKey, { version: 1, text: "warning rearmed" }, NOW + 1)?.id).toBe(warning.id);

    claim = responses.claimDue(NOW + 1, "boot-a")!;
    expect(responses.markRequestStarted(claim.id, claim.claimToken!, NOW + 2)).toBe(true);
    expect(responses.markSentWithAcknowledgement(claim.id, claim.claimToken!, 900, NOW + 3, () => { acknowledged = true; })).toBe(true);
    expect(acknowledged).toBe(true);
    expect(responses.find(claim.id)).toMatchObject({ state: "sent", telegramMessageId: 900 });
    expect(responses.rearmSent(warning.dedupeKey, { version: 1, text: "repeat" }, NOW + 4)?.state).toBe("pending");

    claim = responses.claimDue(NOW + 4, "boot-a")!;
    expect(responses.markRequestStarted(claim.id, claim.claimToken!, NOW + 5)).toBe(true);
    expect(responses.cancel(claim.id, NOW + 6)).toBe(false);
    expect(responses.recover(NOW + 7, "boot-b")).toEqual({ requeued: 0, uncertain: 1 });
    expect(responses.find(claim.id)?.state).toBe("uncertain");
    expect(responses.counts().uncertain).toBe(1);
  });

  test("renders callback buttons at managed dispatch and acknowledges prompts, incidents, and alerts", async () => {
    const state = open();
    const clock = createFakeClock(NOW);
    const response = state.responses.enqueue({
      dedupeKey: "managed-success",
      adminChatId: 42,
      kind: "prompt",
      descriptor: {
        version: 1,
        text: "Choose an action",
        entities: [{ type: "bold", offset: 0, length: 6 }],
        disableLinkPreview: true,
        replyMarkup: { kind: "inline_keyboard", rows: [[{ text: "Open", action: "queue", payload: {}, itemVersion: 4 }]] },
        prompt: { adminId: 42, generationId: "prompt-generation", kind: "recover" },
        incident: { id: "incident-1", kind: "warning" },
        alert: { dedupeKey: "item_issue:4", fingerprint: "fingerprint", mode: "on_change" },
      },
      now: NOW,
    }).record;
    state.admin.setPendingPrompt(42, "recover", { step: "reference" }, "prompt-generation", response.id, NOW);
    const acknowledgements: string[] = [];
    let sentPayload: Record<string, unknown> | undefined;
    const gateway = {
      dispatchManaged: true as const,
      sendAdminMessage: async (message: Record<string, unknown>) => {
        const scope = telegramMutationScope()!;
        const payload = { ...message };
        scope.beforeDispatch?.("sendMessage", payload);
        sentPayload = payload;
        scope.onResult?.({ state: "accepted", knownOutputIds: [951] });
        return asMessageId(951);
      },
    } as unknown as TelegramGateway;
    const worker = createAdminResponseWorker({
      responses: state.responses,
      admin: state.admin,
      gateway,
      adminChatId: 42,
      adminUserId: ADMIN_ID,
      bootId: "boot-a",
      clock,
      logger: silentLogger,
      incidents: {
        canDeliver: () => true,
        acknowledgeDelivered: (_id, kind) => { acknowledgements.push(`incident:${kind}`); return true; },
      },
      alerts: {
        canDeliver: () => true,
        acknowledgeDelivered: (_key, _fingerprint, mode) => { acknowledgements.push(`alert:${mode}`); },
      },
    });

    expect(await worker.runOnce()).toBe(true);
    expect(state.responses.find(response.id)).toMatchObject({ state: "sent", telegramMessageId: 951 });
    expect(state.admin.getPrompt(42, NOW)).toMatchObject({ deliveryState: "active", expectedReplyToMessageId: 951 });
    expect(acknowledgements).toEqual(["incident:warning", "alert:on_change"]);
    expect(sentPayload?.text).toBe("Choose an action");
    expect(sentPayload?.entities).toEqual([{ type: "bold", offset: 0, length: 6 }]);
    expect(sentPayload?.linkPreviewIsDisabled).toBe(true);
    const markup = sentPayload?.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(markup.inline_keyboard[0]?.[0]?.callback_data).toMatch(/^v1:/);
  });

  test("maps managed response receipts and missing receipts to safe durable states", async () => {
    const cases: Array<{ name: string; result?: TelegramRequestResult; expected: AdminResponseState }> = [
      { name: "missing-message-id", result: { state: "accepted" }, expected: "uncertain" },
      { name: "unknown", result: { state: "unknown", errorKind: "transient_network" }, expected: "uncertain" },
      { name: "rate-limited", result: { state: "rejected", errorKind: "rate_limited" }, expected: "pending" },
      { name: "rejected", result: { state: "rejected", errorKind: "source_missing" }, expected: "failed" },
      { name: "missing-receipt", expected: "uncertain" },
    ];
    for (const [index, entry] of cases.entries()) {
      const state = open();
      const clock = createFakeClock(NOW);
      const record = state.responses.enqueue({ dedupeKey: entry.name, adminChatId: 42, kind: "confirmation", descriptor: { version: 1, text: entry.name }, now: NOW }).record;
      const gateway = {
        dispatchManaged: true as const,
        sendAdminMessage: async () => {
          const scope = telegramMutationScope()!;
          scope.beforeDispatch?.("sendMessage", {});
          if (entry.result !== undefined) scope.onResult?.(entry.result);
          return asMessageId(960 + index);
        },
      } as unknown as TelegramGateway;
      const worker = createAdminResponseWorker({ responses: state.responses, admin: state.admin, gateway, adminChatId: 42, adminUserId: ADMIN_ID, bootId: "boot-a", clock, logger: silentLogger, cooldown: { notBefore: () => NOW + 20_000, isActive: () => false } as never });
      expect(await worker.runOnce()).toBe(true);
      expect(state.responses.find(record.id)?.state).toBe(entry.expected);
      if (entry.expected === "pending") expect(state.responses.find(record.id)?.nextAttemptAt).toBeGreaterThan(NOW);
    }
  });

  test("retries deferrals, preserves ambiguous delivery, rejects definite failures, and cancels stale notices", async () => {
    const failures: Array<{ error: unknown; expected: AdminResponseState }> = [
      { error: new TelegramLocalDeferralError("shared_cooldown", NOW + 5_000, "wait"), expected: "pending" },
      { error: { kind: "rate_limited", retryAfterSeconds: 30, description: "retry later" }, expected: "pending" },
      { error: { kind: "transient_network", description: "connection lost" }, expected: "uncertain" },
      { error: { kind: "source_missing", description: "rejected" }, expected: "failed" },
    ];
    for (const [index, entry] of failures.entries()) {
      const state = open();
      const clock = createFakeClock(NOW);
      const response = state.responses.enqueue({ dedupeKey: `failure-${index}`, adminChatId: 42, kind: "confirmation", descriptor: { version: 1, text: "response" }, now: NOW }).record;
      const gateway = { dispatchManaged: false as const, sendAdminMessage: async () => { throw entry.error; } } as unknown as TelegramGateway;
      const worker = createAdminResponseWorker({ responses: state.responses, admin: state.admin, gateway, adminChatId: 42, adminUserId: ADMIN_ID, bootId: "boot-a", clock, logger: silentLogger });
      expect(await worker.runOnce()).toBe(true);
      expect(state.responses.find(response.id)?.state).toBe(entry.expected);
    }

    for (const type of ["incident", "alert"] as const) {
      const state = open();
      const clock = createFakeClock(NOW);
      const response = state.responses.enqueue({
        dedupeKey: `stale-${type}`,
        adminChatId: 42,
        kind: "warning",
        descriptor: { version: 1, text: "stale", ...(type === "incident" ? { incident: { id: "incident-stale", kind: "warning" } } : { alert: { dedupeKey: "item_issue:8", fingerprint: "old", mode: "on_change" } }) },
        now: NOW,
      }).record;
      const gateway = {
        dispatchManaged: true as const,
        sendAdminMessage: async () => {
          telegramMutationScope()!.beforeDispatch?.("sendMessage", {});
          return asMessageId(990);
        },
      } as unknown as TelegramGateway;
      const worker = createAdminResponseWorker({
        responses: state.responses,
        admin: state.admin,
        gateway,
        adminChatId: 42,
        adminUserId: ADMIN_ID,
        bootId: "boot-a",
        clock,
        logger: silentLogger,
        incidents: { canDeliver: () => false, acknowledgeDelivered: () => true },
        alerts: { canDeliver: () => false, acknowledgeDelivered: () => {} },
      });
      expect(await worker.runOnce()).toBe(true);
      expect(state.responses.find(response.id)?.state).toBe("cancelled");
    }
  });

  test("marks invalid stored descriptors failed and backs off after a worker claim error", async () => {
    const state = open();
    const response = state.responses.enqueue({ dedupeKey: "bad-descriptor", adminChatId: 42, kind: "confirmation", descriptor: { version: 1, text: "valid" }, now: NOW }).record;
    const claim = state.responses.claimDue(NOW, "boot-a")!;
    const badResponses = Object.assign({}, state.responses, { claimDue: () => ({ ...claim, descriptor: { version: 2, text: "bad" } }) }) as typeof state.responses;
    const neverSend = { dispatchManaged: false as const, sendAdminMessage: async () => asMessageId(999) } as unknown as TelegramGateway;
    const worker = createAdminResponseWorker({ responses: badResponses, admin: state.admin, gateway: neverSend, adminChatId: 42, adminUserId: ADMIN_ID, bootId: "boot-a", clock: createFakeClock(NOW), logger: silentLogger });
    expect(await worker.runOnce()).toBe(true);
    expect(state.responses.find(response.id)).toMatchObject({ state: "failed", lastErrorKind: "invalid_descriptor" });
    expect(await createAdminResponseWorker({ responses: state.responses, admin: state.admin, gateway: neverSend, adminChatId: 42, adminUserId: ADMIN_ID, bootId: "boot-a", clock: createFakeClock(NOW), logger: silentLogger }).runOnce()).toBe(false);

    const loggerEvents: string[] = [];
    const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: (event) => loggerEvents.push(event) };
    const brokenResponses = Object.assign({}, state.responses, { claimDue: () => { throw new Error("database unavailable"); } }) as typeof state.responses;
    const controller = new AbortController();
    const clock = { now: () => NOW, sleep: async () => { controller.abort(); } };
    await createAdminResponseWorker({ responses: brokenResponses, admin: state.admin, gateway: neverSend, adminChatId: 42, adminUserId: ADMIN_ID, bootId: "boot-a", clock, logger }).run(controller.signal);
    expect(loggerEvents).toContain("admin_response_worker_failed");
    expect(safeErrorDescription(new Error("secret 123456:abcdefghijklmnopqrstuvwxyzABCDEFGH"))).toBe("secret [redacted]");
  });
});

const incidentHarness = () => {
  const state = open();
  const clock = createFakeClock(NOW);
  let cooldownUntil = 0;
  const cooldown = { notBefore: () => cooldownUntil, isActive: () => clock.now() < cooldownUntil };
  const incidentService = createTelegramIncidentService({ incidents: state.incidents, responses: state.responses, adminChatId: 42, adminUserId: Number(ADMIN_ID), cooldown, now: clock.now, logger: silentLogger });
  const sent: Array<{ text: string; replyMarkup?: unknown }> = [];
  const gateway = {
    dispatchManaged: false as const,
    sendAdminMessage: async (message: { text: string; replyMarkup?: unknown }) => {
      sent.push(message);
      return asMessageId(950 + sent.length);
    },
  } as unknown as TelegramGateway;
  const responseWorker = createAdminResponseWorker({ responses: state.responses, admin: state.admin, gateway, adminChatId: 42, adminUserId: ADMIN_ID, bootId: "boot-a", clock, logger: silentLogger, incidents: incidentService });
  return { ...state, clock, cooldown, setCooldownUntil: (value: number) => { cooldownUntil = value; }, incidentService, responseWorker, sent };
};

describe("Telegram flood incidents", () => {
  test("keeps short disruptions silent and resolves them only after cooldown plus relevant success", () => {
    const harness = incidentHarness();
    const deadline = NOW + 30_000;
    harness.setCooldownUntil(deadline);
    harness.incidentService.observeRealFloodWait({ at: NOW, notBefore: deadline, method: "copyMessage", family: "publication" });
    harness.clock.advance(30_000);
    harness.incidentService.observeRelevantSuccess({ at: harness.clock.now(), method: "copyMessage", family: "publication", chatId: -100 });
    harness.clock.advance(5 * 60_000);
    expect(harness.incidentService.evaluate()).toMatchObject({ state: "resolved" });
    expect(harness.responses.counts().pending).toBe(0);
    expect(harness.incidents.snapshot()).toBeUndefined();
  });

  test("delivers one warning and one recovery only after the real delivery and recovery gates", async () => {
    const harness = incidentHarness();
    const deadline = NOW + 10 * 60_000;
    harness.setCooldownUntil(deadline);
    harness.incidentService.observeRealFloodWait({ at: NOW, notBefore: deadline, method: "copyMessage", family: "publication" });
    harness.clock.advance(5 * 60_000);
    const warningState = harness.incidentService.evaluate();
    expect(warningState.state).toBe("active");
    const incident = harness.incidents.snapshot()!;
    expect(incident.warningOutboxId).toBeDefined();
    expect(await harness.responseWorker.runOnce()).toBe(true);
    expect(harness.incidents.snapshot()?.warningDeliveredAt).toBe(NOW + 5 * 60_000);
    expect(harness.sent).toHaveLength(1);

    harness.clock.advance(5 * 60_000);
    harness.incidentService.observeRelevantSuccess({ at: harness.clock.now(), method: "deleteMessages", family: "cleanup", chatId: -100 });
    harness.clock.advance(5 * 60_000);
    expect(harness.incidentService.evaluate().state).toBe("recovering");
    expect(await harness.responseWorker.runOnce()).toBe(true);
    expect(harness.incidents.snapshot()).toBeUndefined();
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]?.text).toContain("recovered and remained healthy");
  });

  test("cancels an undelivered warning on stable recovery and re-arms a definitely-unsent recovery after recurrence", () => {
    const harness = incidentHarness();
    let deadline = NOW + 10 * 60_000;
    harness.setCooldownUntil(deadline);
    harness.incidentService.observeRealFloodWait({ at: NOW, notBefore: deadline, method: "copyMessage", family: "publication" });
    harness.clock.advance(5 * 60_000);
    harness.incidentService.evaluate();
    const incidentId = harness.incidents.snapshot()!.id;
    const warningId = harness.incidents.snapshot()!.warningOutboxId!;
    harness.clock.advance(5 * 60_000);
    harness.incidentService.observeRelevantSuccess({ at: harness.clock.now(), method: "copyMessage", family: "publication", chatId: -100 });
    harness.clock.advance(5 * 60_000);
    expect(harness.incidentService.evaluate().state).toBe("resolved");
    expect(harness.responses.find(warningId)?.state).toBe("cancelled");
    expect(harness.incidents.find(incidentId)?.warningDeliveredAt).toBeUndefined();

    deadline = harness.clock.now() + 1_000;
    harness.setCooldownUntil(deadline);
    harness.incidentService.observeRealFloodWait({ at: harness.clock.now(), notBefore: deadline, method: "copyMessage", family: "publication" });
    const repeatedId = harness.incidents.snapshot()!.id;
    expect(repeatedId).not.toBe(incidentId);
    harness.incidentService.setActionRequired(repeatedId, true);
    expect(harness.incidentService.evaluate().state).toBe("active");
    const rearmedWarning = harness.incidents.snapshot()!.warningOutboxId!;
    expect(rearmedWarning).not.toBe(warningId);
  });

  test("re-arms the same cancelled recovery row when a delivered incident recurs", async () => {
    const harness = incidentHarness();
    let deadline = NOW + 10 * 60_000;
    harness.setCooldownUntil(deadline);
    harness.incidentService.observeRealFloodWait({ at: NOW, notBefore: deadline, method: "copyMessage", family: "publication" });
    harness.clock.advance(5 * 60_000);
    harness.incidentService.evaluate();
    await expect(harness.responseWorker.runOnce()).resolves.toBe(true);
    harness.clock.advance(5 * 60_000);
    harness.incidentService.observeRelevantSuccess({ at: harness.clock.now(), method: "copyMessage", family: "publication", chatId: -100 });
    harness.clock.advance(5 * 60_000);
    harness.incidentService.evaluate();
    const firstRecoveryId = harness.incidents.snapshot()!.recoveryOutboxId!;
    const incidentId = harness.incidents.snapshot()!.id;

    deadline = harness.clock.now() + 30_000;
    harness.setCooldownUntil(deadline);
    harness.incidentService.observeRealFloodWait({ at: harness.clock.now(), notBefore: deadline, method: "deleteMessages", family: "cleanup" });
    expect(harness.incidents.snapshot()?.id).toBe(incidentId);
    expect(harness.responses.find(firstRecoveryId)?.state).toBe("cancelled");
    harness.clock.advance(30_000);
    harness.incidentService.observeRelevantSuccess({ at: harness.clock.now(), method: "copyMessage", family: "publication", chatId: -100 });
    harness.clock.advance(5 * 60_000);
    expect(harness.incidentService.evaluate().state).toBe("recovering");
    expect(harness.incidents.snapshot()?.recoveryOutboxId).toBe(firstRecoveryId);
  });
});

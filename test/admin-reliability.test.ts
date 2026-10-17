import { afterEach, describe, expect, test } from "bun:test";
import { asMessageId, asUserId } from "../src/types";
import { createAdminRepository } from "../src/db/admin-repository";
import { createAdminResponseRepository } from "../src/db/admin-response-repository";
import { createAdminUpdateRepository } from "../src/db/admin-update-repository";
import { createTelegramIncidentRepository } from "../src/db/telegram-incident-repository";
import { createTelegramIncidentService } from "../src/services/telegram-incidents";
import { createAdminResponseWorker } from "../src/services/admin-response-worker";
import { createFakeClock } from "../src/clock";
import type { Logger } from "../src/logger";
import type { TelegramGateway } from "../src/telegram";
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

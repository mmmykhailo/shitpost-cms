import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createTelegramCooldownRepository } from "../src/db/telegram-cooldown-repository";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository, createScheduleRepository } from "../src/db/repositories";
import { RENEWAL_START_AGE_MS } from "../src/domain/renewal-policy";
import { createLogger } from "../src/logger";
import { createRenewalService } from "../src/services/renewal";
import { createRenewalWorker } from "../src/services/renewal-worker";
import { createFakeClock } from "../src/clock";
import { createTelegramCooldown } from "../src/telegram-cooldown";
import { asChatId, asMessageId, asUserId, type Clock, type MessageId } from "../src/types";
import type { TelegramGateway } from "../src/telegram";
import { snapshotFixture } from "./fixtures";

const QUEUE_CHAT_ID = asChatId(-1001234567890);
const resources: Array<{ directory: string; close(): void }> = [];

type GatewayHooks = {
  copy?: (sourceIds: readonly MessageId[]) => Promise<MessageId[]>;
  forward?: (sourceIds: readonly MessageId[]) => Promise<MessageId[]>;
  delete?: (sourceIds: readonly MessageId[]) => Promise<void>;
};

const createGateway = (hooks: GatewayHooks = {}) => {
  let nextMessageId = 20_000;
  const copies: number[][] = [];
  const forwards: number[][] = [];
  const deletions: number[][] = [];
  const gateway: TelegramGateway = {
    getBotIdentity: async () => ({ id: asUserId(1) }),
    getChat: async (chatId) => ({ id: asChatId(Number(chatId)), type: "channel" }),
    getBotMembership: async () => ({ status: "administrator", canPostMessages: true, canDeleteMessages: true, canEditMessages: true }),
    copyMessages: async ({ messageIds }) => {
      copies.push(messageIds.map(Number));
      if (hooks.copy) return hooks.copy(messageIds);
      return messageIds.map(() => asMessageId(nextMessageId++));
    },
    copyMessage: async ({ messageId }) => {
      copies.push([Number(messageId)]);
      if (hooks.copy) return (await hooks.copy([messageId]))[0]!;
      return asMessageId(nextMessageId++);
    },
    forwardMessages: async ({ messageIds }) => {
      forwards.push(messageIds.map(Number));
      if (hooks.forward) return hooks.forward(messageIds);
      return messageIds.map(() => asMessageId(nextMessageId++));
    },
    forwardMessage: async ({ messageId }) => {
      forwards.push([Number(messageId)]);
      if (hooks.forward) return { message_id: Number((await hooks.forward([messageId]))[0]!) } as never;
      return { message_id: Number(asMessageId(nextMessageId++)) } as never;
    },
    editText: async () => {},
    editCaption: async () => {},
    sendText: async () => asMessageId(nextMessageId++),
    deleteMessages: async (_chatId, messageIds) => {
      deletions.push(messageIds.map(Number));
      await hooks.delete?.(messageIds);
    },
    sendAdminMessage: async () => asMessageId(nextMessageId++),
    editAdminMessage: async () => {},
    answerCallbackQuery: async () => {},
  };
  return { gateway, copies, forwards, deletions };
};

const open = (initialTime: number, hooks: GatewayHooks = {}, clockOverride?: Clock) => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-renewal-worker-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  const queue = createQueueRepository(database);
  const schedule = createScheduleRepository(database);
  const clock = clockOverride ?? createFakeClock(initialTime);
  const cooldown = createTelegramCooldown({ repository: createTelegramCooldownRepository(database), clock });
  const fake = createGateway(hooks);
  const renewal = createRenewalService({
    queue,
    policy: createPolicyRepository(database),
    generated: createGeneratedMessageRepository(database),
    gateway: fake.gateway,
    queueChannelId: QUEUE_CHAT_ID,
    clock,
    cooldown,
    logger: createLogger("error"),
    operationId: (() => { let next = 0; return () => `worker-renew-${++next}`; })(),
  });
  const worker = createRenewalWorker({ queue, renewal, cooldown, clock, logger: createLogger("error") });
  resources.push({ directory, close: database.close });
  return { database, queue, schedule, clock, cooldown, renewal, worker, ...fake };
};

const seedSingletons = (harness: ReturnType<typeof open>, count: number, now = 0, firstMessageId = 100): void => {
  for (let index = 0; index < count; index += 1) {
    harness.queue.observeQueueSnapshot(snapshotFixture({
      chatId: QUEUE_CHAT_ID,
      messageId: asMessageId(firstMessageId + index),
      telegramDate: 0,
      origin: { kind: "absent" },
    }), now);
  }
};

const createControlledClock = (initialTime: number) => {
  let current = initialTime;
  const sleepers: Array<{ deadline: number; resolve(): void }> = [];
  return {
    now: () => current,
    sleep: (milliseconds: number) => new Promise<void>((resolve) => {
      if (milliseconds <= 0) { resolve(); return; }
      sleepers.push({ deadline: current + milliseconds, resolve });
    }),
    advance: (milliseconds: number): void => {
      current += milliseconds;
      for (let index = sleepers.length - 1; index >= 0; index -= 1) {
        if (sleepers[index]!.deadline <= current) sleepers.splice(index, 1)[0]!.resolve();
      }
    },
    pendingSleeps: (): number[] => sleepers.map((sleeper) => sleeper.deadline - current),
  };
};

const settle = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("renewal worker", () => {
  test("drains sixty due singleton items at the shared pacing rate", async () => {
    const start = RENEWAL_START_AGE_MS;
    const harness = open(start);
    seedSingletons(harness, 60, 0);

    const result = await harness.worker.runCycle(new AbortController().signal);

    expect(result.attempts).toBe(60);
    expect(result.renewed).toBe(60);
    expect(result.attemptBudgetExhausted).toBe(false);
    expect(harness.copies).toHaveLength(60);
    expect(harness.deletions).toHaveLength(60);
    expect(harness.clock.now() - start).toBeLessThanOrEqual(180_000);
    expect(harness.queue.findItemById(1)?.sourceGeneration).toBe(1);
    expect(harness.queue.findItemById(60)?.sourceGeneration).toBe(1);
    expect(harness.queue.findItemById(1)?.enqueuedAt).toBe(0);
  });

  test("resumes a 100-attempt batch after pacing without an idle scan pause", async () => {
    const start = RENEWAL_START_AGE_MS;
    const harness = open(start);
    seedSingletons(harness, 105, 0, 1_000);

    const first = await harness.worker.runCycle(new AbortController().signal);
    expect(first.attempts).toBe(100);
    expect(first.attemptBudgetExhausted).toBe(true);
    expect(first.nextWakeAt).toBe(harness.clock.now() + 3_000);
    expect(harness.copies).toHaveLength(100);

    const second = await harness.worker.runCycle(new AbortController().signal);

    expect(second.attempts).toBe(5);
    expect(second.attemptBudgetExhausted).toBe(false);
    expect(harness.copies).toHaveLength(105);
    expect(harness.queue.findItemById(105)?.sourceGeneration).toBe(1);
    expect(harness.clock.now() - start).toBeLessThan(6 * 60_000);
  });

  test("backs off the oldest definite failure and renews later due items", async () => {
    const start = RENEWAL_START_AGE_MS;
    const harness = open(start, {
      copy: async (sourceIds) => {
        if (sourceIds[0] === 100) throw { kind: "permission_denied", description: "queue channel rights lost" };
        return [asMessageId(30_000 + Number(sourceIds[0]))];
      },
    });
    seedSingletons(harness, 3, 0);
    const originalSequences = [1, 2, 3].map((id) => harness.queue.findItemById(id)?.logicalSequence);

    const result = await harness.worker.runCycle(new AbortController().signal);

    expect(result.attempts).toBe(3);
    expect(result.renewed).toBe(2);
    expect(result.failed).toBe(1);
    expect(harness.copies).toEqual([[100], [101], [102]]);
    expect(harness.queue.findItemById(1)).toMatchObject({ status: "queued", maintenanceStatus: "idle", lastErrorCode: "permission_denied" });
    expect(harness.queue.findItemById(1)?.maintenanceRetryNotBefore).toBe(start + 60_000);
    expect(harness.queue.currentSourceIds(1)).toEqual([asMessageId(100)]);
    expect(harness.queue.findItemById(2)?.sourceGeneration).toBe(1);
    expect(harness.queue.findItemById(3)?.sourceGeneration).toBe(1);
    expect([1, 2, 3].map((id) => harness.queue.findItemById(id)?.logicalSequence)).toEqual(originalSequences);
  });

  test("isolates an uncertain oldest renewal while continuing other due work", async () => {
    const harness = open(RENEWAL_START_AGE_MS, {
      copy: async (sourceIds) => {
        if (sourceIds[0] === 200) throw new TypeError("network timeout after sending");
        return [asMessageId(40_000 + Number(sourceIds[0]))];
      },
    });
    seedSingletons(harness, 2, 0, 200);

    const result = await harness.worker.runCycle(new AbortController().signal);

    expect(result.attempts).toBe(2);
    expect(result.uncertain).toBe(1);
    expect(result.renewed).toBe(1);
    expect(harness.copies).toEqual([[200], [201]]);
    expect(harness.queue.findItemById(1)?.maintenanceStatus).toBe("uncertain_renewal");
    expect(harness.queue.currentSourceIds(1)).toEqual([asMessageId(200)]);
    expect(harness.queue.operationEvidence(1)?.knownReplacementIds).toEqual([]);
    expect(harness.queue.findItemById(2)?.sourceGeneration).toBe(1);
  });

  test("lets a healthy source go first when an older item has a future retry deadline", async () => {
    const start = RENEWAL_START_AGE_MS;
    const harness = open(start);
    seedSingletons(harness, 2, 0, 300);
    const deferred = harness.queue.claimRenewal("defer-oldest", start, 0)!;
    harness.queue.setRetry(deferred.item.id, deferred.operationId, start, start + 5 * 60 * 60_000, "permission_denied", "manual retry delay");

    const result = await harness.worker.runCycle(new AbortController().signal);

    expect(result.attempts).toBe(1);
    expect(harness.copies).toEqual([[301]]);
    expect(harness.queue.findItemById(1)?.sourceGeneration).toBe(0);
    expect(harness.queue.findItemById(2)?.sourceGeneration).toBe(1);
  });

  test("stops after a flood response and resumes after the full shared cooldown", async () => {
    const start = RENEWAL_START_AGE_MS;
    const clock = createFakeClock(start);
    let hasFlooded = false;
    const harness = open(start, {
      copy: async (sourceIds) => {
        if (sourceIds[0] === 400 && !hasFlooded) {
          hasFlooded = true;
          throw { kind: "rate_limited", description: "slow down", retryAfterSeconds: 1_800 };
        }
        return [asMessageId(50_000 + Number(sourceIds[0]))];
      },
    }, clock);
    seedSingletons(harness, 2, 0, 400);

    const limited = await harness.worker.runCycle(new AbortController().signal);
    expect(limited.attempts).toBe(1);
    expect(limited.nextWakeAt).toBe(start + 1_800_000);
    expect(harness.copies).toEqual([[400]]);
    expect((await harness.worker.runCycle(new AbortController().signal)).attempts).toBe(0);
    expect(harness.clock.now()).toBe(start);

    clock.advance(1_800_000);
    const resumed = await harness.worker.runCycle(new AbortController().signal);
    expect(resumed.attempts).toBe(2);
    expect(harness.copies).toEqual([[400], [400], [401]]);
    expect(harness.queue.findItemById(1)?.sourceGeneration).toBe(1);
    expect(harness.queue.findItemById(2)?.sourceGeneration).toBe(1);
  });

  test("continues maintenance while scheduled publishing is paused", async () => {
    const start = RENEWAL_START_AGE_MS;
    const harness = open(start);
    harness.schedule.setEnabled(false, 42, start);
    seedSingletons(harness, 1, 0, 500);

    const result = await harness.worker.runCycle(new AbortController().signal);

    expect(harness.schedule.enabled()).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.renewed).toBe(1);
    expect(harness.copies).toEqual([[500]]);
  });

  test("paces an album by its ten physical members", async () => {
    const start = RENEWAL_START_AGE_MS;
    const harness = open(start);
    const first = snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(600), mediaGroupId: "ten-member-album", contentType: "photo", telegramDate: 0, origin: { kind: "absent" } });
    const item = harness.queue.observeQueueSnapshot(first, 0).item;
    for (let index = 1; index < 10; index += 1) {
      harness.queue.addAlbumMember(item.id, snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(600 + index), mediaGroupId: "ten-member-album", contentType: "photo", ordinal: index, telegramDate: 0, origin: { kind: "absent" } }), index);
    }
    harness.queue.finalizeAlbums(10_000);

    const result = await harness.worker.runCycle(new AbortController().signal);

    expect(result.attempts).toBe(1);
    expect(harness.copies).toEqual([Array.from({ length: 10 }, (_, index) => 600 + index)]);
    expect(harness.clock.now() - start).toBe(30_000);
    expect(harness.queue.currentSourceIds(item.id)).toHaveLength(10);
  });

  test("retries installed-source cleanup without sending another replacement", async () => {
    const start = RENEWAL_START_AGE_MS;
    const harness = open(start);
    const item = harness.queue.observeQueueSnapshot(snapshotFixture({ chatId: QUEUE_CHAT_ID, messageId: asMessageId(700), telegramDate: 0, origin: { kind: "absent" } }), 0).item;
    const claimed = harness.queue.claimRenewal("installed-cleanup", start, 0)!;
    const guard = { operationId: claimed.operationId, itemId: item.id, capturedContentVersion: claimed.capturedContentVersion, capturedSourceGeneration: claimed.capturedSourceGeneration };
    harness.queue.setOperationPhase(claimed.operationId, "replacement_pending", start);
    harness.queue.recordReplacementOutput(claimed.operationId, QUEUE_CHAT_ID, 9000, 0, start);
    harness.queue.markReplacementOutputsRecorded(guard, start);
    const original = harness.queue.getCurrentSnapshotSet(item.id)[0]!;
    harness.queue.installRenewedGeneration(guard, [{ ...original, messageId: asMessageId(9000), telegramDate: start }], start);

    const result = await harness.worker.runCycle(new AbortController().signal);

    expect(result.cleanupAttempts).toBe(1);
    expect(harness.copies).toEqual([]);
    expect(harness.deletions).toEqual([[700]]);
    expect(harness.queue.findItemById(item.id)?.sourceGeneration).toBe(1);
    expect(harness.queue.findItemById(item.id)?.maintenanceStatus).toBe("idle");
  });

  test("aborts during idle, pacing, and cooldown waits without starting another send", async () => {
    const idleClock = createControlledClock(0);
    const idle = open(0, {}, idleClock);
    const idleAbort = new AbortController();
    const idleRun = idle.worker.run(idleAbort.signal);
    await settle();
    expect(idleClock.pendingSleeps()).toEqual([60_000]);
    idleAbort.abort();
    await idleRun;
    expect(idle.copies).toEqual([]);

    const pacingStart = RENEWAL_START_AGE_MS;
    const pacingClock = createControlledClock(pacingStart);
    const pacing = open(pacingStart, {}, pacingClock);
    seedSingletons(pacing, 2, 0, 800);
    const pacingAbort = new AbortController();
    const pacingRun = pacing.worker.run(pacingAbort.signal);
    await settle();
    expect(pacing.copies).toHaveLength(1);
    expect(pacingClock.pendingSleeps()).toEqual([3_000]);
    pacingAbort.abort();
    await pacingRun;
    expect(pacing.copies).toHaveLength(1);

    const cooldownClock = createControlledClock(pacingStart);
    const cooldownRun = open(pacingStart, {}, cooldownClock);
    cooldownRun.cooldown.extendForRetryAfter(1_800, pacingStart);
    const cooldownAbort = new AbortController();
    const running = cooldownRun.worker.run(cooldownAbort.signal);
    await settle();
    expect(cooldownClock.pendingSleeps()).toEqual([1_800_000]);
    cooldownAbort.abort();
    await running;
    expect(cooldownRun.copies).toEqual([]);
  });

  test("shares one in-flight cycle instead of claiming the same item twice", async () => {
    let releaseCopy: ((ids: MessageId[]) => void) | undefined;
    const harness = open(RENEWAL_START_AGE_MS, {
      copy: async () => new Promise<MessageId[]>((resolve) => { releaseCopy = resolve; }),
    });
    seedSingletons(harness, 1, 0, 900);

    const first = harness.worker.runCycle(new AbortController().signal);
    const overlapping = harness.worker.runCycle(new AbortController().signal);
    expect(overlapping).toBe(first);
    await settle();
    expect(harness.copies).toEqual([[900]]);
    releaseCopy?.([asMessageId(9900)]);

    const result = await first;
    expect(result.attempts).toBe(1);
    expect(harness.copies).toHaveLength(1);
    expect(harness.queue.findItemById(1)?.sourceGeneration).toBe(1);
  });

  test("starts renewal at exactly 36 hours of source age", async () => {
    const beforeThreshold = RENEWAL_START_AGE_MS - 1;
    const clock = createFakeClock(beforeThreshold);
    const harness = open(beforeThreshold, {}, clock);
    seedSingletons(harness, 1, 0, 950);

    const early = await harness.worker.runCycle(new AbortController().signal);
    expect(early.attempts).toBe(0);
    expect(harness.copies).toEqual([]);

    clock.advance(1);
    const due = await harness.worker.runCycle(new AbortController().signal);
    expect(due.attempts).toBe(1);
    expect(harness.copies).toEqual([[950]]);
  });
});

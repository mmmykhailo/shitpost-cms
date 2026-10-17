import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createScheduleRepository } from "../src/db/repositories";
import { createSchedulerService } from "../src/services/scheduler";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import type { MessageId } from "../src/types";
import type { PublicationOutcome } from "../src/services/publisher";

const resources: Array<{ directory: string; close(): void }> = [];

const open = (options: { outcomes?: PublicationOutcome[]; initialTime?: number } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-scheduler-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  const schedule = createScheduleRepository(database);
  const clock = createFakeClock(options.initialTime ?? Date.parse("2026-10-04T01:02:00Z"));
  let publishCount = 0;
  const outcomes = [...(options.outcomes ?? [{ kind: "empty" } as const])];
  const scheduler = createSchedulerService({
    schedule,
    publisher: { publishNext: async () => { publishCount += 1; return outcomes.shift() ?? { kind: "empty" }; } },
    clock,
    logger: createLogger("error"),
    bootId: "test-boot",
    operationId: (() => { let i = 0; return () => `slot-${++i}`; })(),
  });
  resources.push({ directory, close: database.close });
  return { schedule, scheduler, clock, get publishCount() { return publishCount; } };
};

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("scheduler service", () => {
  test("skips older missed UTC occurrences and runs the newest within its fixed window", async () => {
    const { schedule, scheduler, clock } = open();
    const occurrence = Date.parse("2026-10-04T01:00:00Z");
    schedule.addSlot(60, 1, clock.now() - 3 * 86_400_000);
    schedule.setEnabled(true, 1, clock.now());
    schedule.setLastScan(occurrence - 3 * 86_400_000 - 1);
    const result = await scheduler.scanOnce();
    expect(result).toMatchObject({ ran: true, occurrenceAt: occurrence, outcome: { kind: "empty" } });
    expect(schedule.run(Date.parse("2026-10-02T01:00:00Z"))?.status).toBe("skipped_downtime");
    expect(schedule.run(occurrence)?.status).toBe("empty");
    expect(await scheduler.scanOnce()).toEqual({ ran: false });
  });

  test("retries a definite scheduled rejection without another trigger", async () => {
    const occurrence = Date.parse("2026-10-04T01:00:00Z");
    const retryAt = occurrence + 120_000;
    const harness = open({
      initialTime: occurrence + 30_000,
      outcomes: [
        { kind: "retry_scheduled", itemId: 4, retryAt, operationId: "first-attempt" },
        { kind: "published", itemId: 5, destinationMessageIds: [88 as MessageId], operationId: "second-attempt" },
      ],
    });
    const { schedule, scheduler, clock } = harness;
    schedule.addSlot(60, 1, occurrence - 86_400_000);
    schedule.setEnabled(true, 1, clock.now());
    schedule.setLastScan(occurrence - 1);
    await scheduler.scanOnce();
    expect(schedule.run(occurrence)).toMatchObject({ status: "pending", retryNotBefore: retryAt, retryDeadlineAt: occurrence + 300_000 });
    expect(harness.publishCount).toBe(1);
    clock.advance(retryAt - clock.now());
    await scheduler.scanOnce();
    expect(harness.publishCount).toBe(2);
    expect(schedule.run(occurrence)?.status).toBe("published");
  });

  test("does not backfill an occurrence at the five-minute deadline", async () => {
    const occurrence = Date.parse("2026-10-04T01:00:00Z");
    const harness = open({ initialTime: occurrence + 300_000 });
    const { schedule, scheduler, clock } = harness;
    schedule.addSlot(60, 1, occurrence - 86_400_000);
    schedule.setEnabled(true, 1, clock.now());
    schedule.setLastScan(occurrence - 1);
    expect(await scheduler.scanOnce()).toEqual({ ran: false });
    expect(harness.publishCount).toBe(0);
    expect(schedule.run(occurrence)).toMatchObject({ status: "failed", errorCode: "retry_window_expired" });
  });

  test("pausing cancels saved retries and resume cannot revive them", () => {
    const occurrence = Date.parse("2026-10-04T01:00:00Z");
    const { schedule, clock } = open({ initialTime: occurrence + 60_000 });
    schedule.addSlot(60, 1, occurrence - 86_400_000);
    schedule.setEnabled(true, 1, clock.now());
    schedule.materialize(occurrence);
    const claim = schedule.claimRun(occurrence, "test-boot", clock.now())!;
    expect(schedule.deferRun(claim.claimToken, occurrence + 120_000, clock.now(), "telegram_rate_limited")).toBe(true);
    schedule.setEnabled(false, 1, clock.now());
    expect(schedule.run(occurrence)).toMatchObject({ status: "failed", cancelReason: "schedule_paused" });
    schedule.setEnabled(true, 1, clock.now());
    expect(schedule.duePending(clock.now())).toEqual([]);
  });

  test("manual publication does not create a scheduled run", async () => {
    const { schedule, scheduler } = open();
    expect((await scheduler.manualPublish()).kind).toBe("empty");
    expect(schedule.run(Date.parse("2026-10-04T01:00:00Z"))).toBeUndefined();
    expect(scheduler.nextAt()).toBeUndefined();
  });

  test("scheduler loop exits cleanly when its worker signal is aborted", async () => {
    const { schedule, clock } = open();
    const controller = new AbortController();
    const scheduler = createSchedulerService({
      schedule,
      publisher: { publishNext: async () => ({ kind: "empty" }) },
      clock: { now: clock.now, sleep: async () => { controller.abort(); } },
      logger: createLogger("error"),
    });
    await scheduler.run(controller.signal);
    scheduler.stop();
    expect(scheduler.nextAt()).toBeUndefined();
  });

  test("does not treat a no-output result that crosses the retry deadline as empty", async () => {
    const occurrence = Date.parse("2026-10-04T01:00:00Z");
    const { schedule, clock } = open({ initialTime: occurrence + 299_999 });
    schedule.addSlot(60, 1, occurrence - 86_400_000);
    schedule.setEnabled(true, 1, clock.now());
    schedule.setLastScan(occurrence - 1);
    const scheduler = createSchedulerService({
      schedule,
      publisher: { publishNext: async () => { clock.advance(1); return { kind: "empty" }; } },
      clock,
      logger: createLogger("error"),
    });
    expect((await scheduler.scanOnce()).outcome?.kind).toBe("empty");
    expect(schedule.run(occurrence)).toMatchObject({ status: "failed", errorCode: "retry_window_expired" });
  });
});

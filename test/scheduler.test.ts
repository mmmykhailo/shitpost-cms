import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createScheduleRepository } from "../src/db/repositories";
import { createSchedulerService } from "../src/services/scheduler";
import { createFakeClock } from "../src/clock";
import { createLogger } from "../src/logger";
import type { PublicationOutcome } from "../src/services/publisher";

const resources: Array<{ directory: string; close(): void }> = [];

const open = (publisherOutcome: PublicationOutcome = { kind: "empty" }) => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-scheduler-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  const schedule = createScheduleRepository(database);
  const clock = createFakeClock(Date.parse("2026-10-04T02:00:00Z"));
  let publishCount = 0;
  const scheduler = createSchedulerService({
    schedule,
    publisher: { publishNext: async () => { publishCount += 1; return publisherOutcome; } },
    clock,
    logger: createLogger("error"),
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
  test("publishes at most the newest missed UTC occurrence", async () => {
    const { schedule, scheduler, clock } = open({ kind: "empty" });
    schedule.addSlot(60, 1, clock.now() - 3 * 86_400_000);
    schedule.setEnabled(true, 1, clock.now());
    schedule.setLastScan(clock.now() - 3 * 86_400_000);
    const result = await scheduler.scanOnce();
    expect(result.ran).toBe(true);
    expect(schedule.run(Date.parse("2026-10-02T01:00:00Z"))?.status).toBe("skipped_downtime");
    expect(schedule.run(Date.parse("2026-10-04T01:00:00Z"))?.status).toBe("empty");
    expect(await scheduler.scanOnce()).toEqual({ ran: false });
  });

  test("manual publication does not create a scheduled run", async () => {
    const { schedule, scheduler } = open({ kind: "empty" });
    expect((await scheduler.manualPublish()).kind).toBe("empty");
    expect(schedule.run(Date.parse("2026-10-04T01:00:00Z"))).toBeUndefined();
    expect(scheduler.nextAt()).toBeUndefined();
  });
});

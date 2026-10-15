import { nextOccurrence, occurrencesBetween } from "../domain/schedule";
import type { ScheduleRepository } from "../db/repositories";
import type { Logger } from "../logger";
import type { Clock } from "../types";
import type { PublicationOutcome } from "./publisher";
import { abortableSleep } from "./task-supervisor";

type ReadyCandidate = { itemId: number; contentVersion: number; sourceGeneration: number };
type Publisher = { publishNext(type?: "publish" | "manual_publish", expected?: ReadyCandidate): Promise<PublicationOutcome> };

export type SchedulerService = ReturnType<typeof createSchedulerService>;

export const createSchedulerService = (input: {
  schedule: ScheduleRepository;
  publisher: Publisher;
  clock: Clock;
  logger: Logger;
  operationId?: () => string;
}) => {
  let scanBusy = false;
  let loopRunning = false;
  const outcomeToRun = (outcome: PublicationOutcome): { status: "published" | "empty" | "blocked" | "failed"; itemId?: number; operationId: string | undefined; errorCode?: string } => {
    switch (outcome.kind) {
      case "published": return { status: "published", itemId: outcome.itemId, operationId: outcome.operationId };
      case "empty": return { status: "empty", operationId: undefined };
      case "blocked": return { status: "blocked", itemId: outcome.itemId, operationId: outcome.operationId, errorCode: outcome.reason };
      case "cleanup_pending": return { status: "published", itemId: outcome.itemId, operationId: outcome.operationId, errorCode: "cleanup_pending" };
      case "deleted_external": return { status: "failed", itemId: outcome.itemId, operationId: outcome.operationId, errorCode: "source_missing" };
      case "retry_scheduled": return { status: "failed", itemId: outcome.itemId, operationId: outcome.operationId, errorCode: "retry_scheduled" };
      case "uncertain": return { status: "failed", itemId: outcome.itemId, operationId: outcome.operationId, errorCode: "uncertain_publish" };
      case "failed": return { status: "failed", itemId: outcome.itemId, operationId: outcome.operationId, errorCode: outcome.status };
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  };

  const scanOnce = async (): Promise<{ ran: boolean; occurrenceAt?: number; outcome?: PublicationOutcome }> => {
    if (scanBusy) return { ran: false };
    scanBusy = true;
    try {
      const now = input.clock.now();
      if (!input.schedule.enabled()) {
        input.schedule.setLastScan(now);
        return { ran: false };
      }
      const slots = input.schedule.slots();
      const previousScan = input.schedule.lastScan() ?? now;
      const missed = occurrencesBetween(previousScan, now, slots);
      if (missed.length === 0) {
        input.schedule.setLastScan(now);
        return { ran: false };
      }
      const newest = missed[missed.length - 1]!;
      for (const occurrenceAt of missed) {
        input.schedule.materialize(occurrenceAt);
        if (occurrenceAt !== newest) {
          input.schedule.markRun(occurrenceAt, "skipped_downtime", now, undefined, undefined, "missed_downtime");
          continue;
        }
        const current = input.schedule.run(occurrenceAt);
        if (!current || ["published", "empty", "blocked", "failed", "skipped_downtime"].includes(current.status)) continue;
        if (!input.schedule.markRunning(occurrenceAt, now)) continue;
        const outcome = await input.publisher.publishNext("publish");
        const run = outcomeToRun(outcome);
        input.schedule.markRun(occurrenceAt, run.status, input.clock.now(), run.itemId, run.operationId, run.errorCode);
        input.schedule.setLastScan(input.clock.now());
        input.logger.info("schedule_run", { occurrenceAt, status: run.status, itemId: run.itemId, errorCode: run.errorCode });
        return { ran: true, occurrenceAt, outcome };
      }
      input.schedule.setLastScan(now);
      return { ran: false };
    } finally {
      scanBusy = false;
    }
  };

  const nextAt = (): number | undefined => input.schedule.enabled() ? nextOccurrence(input.clock.now(), input.schedule.slots()) : undefined;

  const run = async (signal?: AbortSignal): Promise<void> => {
    if (loopRunning) return;
    loopRunning = true;
    const effectiveSignal = signal ?? new AbortController().signal;
    try {
      while (loopRunning && !effectiveSignal.aborted) {
        await scanOnce();
        const next = nextAt();
        await abortableSleep(input.clock, next === undefined ? 60_000 : Math.max(1_000, next - input.clock.now()), effectiveSignal);
      }
    } finally {
      loopRunning = false;
    }
  };

  const stop = (): void => { loopRunning = false; };

  const manualPublish = (expected?: ReadyCandidate): Promise<PublicationOutcome> => input.publisher.publishNext("manual_publish", expected);

  return { scanOnce, nextAt, run, stop, manualPublish };
};

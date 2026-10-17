import { nextOccurrence, occurrencesBetween } from "../domain/schedule";
import type { ScheduleRepository } from "../db/repositories";
import type { Logger } from "../logger";
import type { Clock } from "../types";
import type { PublicationOutcome, ScheduledPublicationContext } from "./publisher";
import { abortableSleep } from "./task-supervisor";

type ReadyCandidate = { itemId: number; contentVersion: number; sourceGeneration: number };
type Publisher = {
  publishNext(type?: "publish" | "manual_publish", expected?: ReadyCandidate, scheduled?: ScheduledPublicationContext): Promise<PublicationOutcome>;
};

export type SchedulerService = ReturnType<typeof createSchedulerService>;

export const createSchedulerService = (input: {
  schedule: ScheduleRepository;
  publisher: Publisher;
  clock: Clock;
  logger: Logger;
  bootId?: string;
  operationId?: () => string;
}) => {
  let scanBusy = false;
  let loopRunning = false;
  const bootId = input.bootId ?? "scheduler";
  const outcomeToRun = (outcome: PublicationOutcome): { status: "published" | "empty" | "blocked" | "failed"; errorCode?: string } => {
    switch (outcome.kind) {
      case "published": return { status: "published" };
      case "empty": return { status: "empty" };
      case "blocked": return { status: "blocked", errorCode: outcome.reason };
      case "cleanup_pending": return { status: "published", errorCode: "cleanup_pending" };
      case "deleted_external": return { status: "failed", errorCode: "source_missing" };
      case "retry_scheduled": return { status: "failed", errorCode: "retry_scheduled" };
      case "uncertain": return { status: "failed", errorCode: "uncertain_publish" };
      case "failed": return { status: "failed", errorCode: outcome.status };
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  };

  const reconcilePreviousAttempts = (occurrenceAt: number): { unsafe: boolean; completed: boolean; itemId?: number; operationId?: string } => {
    const attempts = input.schedule.associatedAttempts(occurrenceAt);
    for (const attempt of attempts) {
      if (attempt.expectedOutputCount !== null && attempt.expectedOutputCount > 0 && attempt.outputIds.length === attempt.expectedOutputCount
        && (attempt.operationPhase === "output_complete" || attempt.operationPhase === "source_cleanup_pending" || attempt.operationPhase === "completed" || attempt.operationState === "done" || attempt.operationState === "cleanup_pending")) {
        return { unsafe: true, completed: true, itemId: attempt.itemId, operationId: attempt.operationId };
      }
      if (attempt.outputIds.length > 0) return { unsafe: true, completed: false, itemId: attempt.itemId, operationId: attempt.operationId };
      if (attempt.operationState === "uncertain" || attempt.operationPhase === "uncertain") return { unsafe: true, completed: false, itemId: attempt.itemId, operationId: attempt.operationId };
      if (attempt.requestStates.some((state) => state === "in_flight" || state === "accepted" || state === "unknown")) {
        return { unsafe: true, completed: false, itemId: attempt.itemId, operationId: attempt.operationId };
      }
    }
    return { unsafe: false, completed: false };
  };

  const scanOnce = async (): Promise<{ ran: boolean; occurrenceAt?: number; outcome?: PublicationOutcome }> => {
    if (scanBusy) return { ran: false };
    scanBusy = true;
    try {
      let now = input.clock.now();
      input.schedule.expirePendingRuns(now);
      if (!input.schedule.enabled()) {
        input.schedule.cancelPendingRuns("schedule_paused", now);
        input.schedule.setLastScan(now);
        return { ran: false };
      }

      const slots = input.schedule.slots();
      const previousScan = input.schedule.lastScan() ?? now;
      const discovered = occurrencesBetween(previousScan, now, slots);
      const materialized = discovered.filter((occurrenceAt) => input.schedule.materialize(occurrenceAt));
      const newestDiscovered = materialized.at(-1);
      for (const occurrenceAt of materialized) {
        if (occurrenceAt !== newestDiscovered) {
          input.schedule.markRun(occurrenceAt, "skipped_downtime", now, undefined, undefined, "missed_downtime");
        } else if (now >= occurrenceAt + 300_000) {
          input.schedule.markRun(occurrenceAt, "failed", now, undefined, undefined, "retry_window_expired");
        }
      }
      if (newestDiscovered !== undefined && now < newestDiscovered + 300_000) input.schedule.cancelOlderPendingRuns(newestDiscovered, "superseded_by_newer_occurrence", now);

      now = input.clock.now();
      const pending = input.schedule.duePending(now);
      const occurrenceAt = pending.at(-1)?.occurrenceAt;
      if (occurrenceAt === undefined) {
        input.schedule.setLastScan(now);
        return { ran: false };
      }
      input.schedule.cancelOlderPendingRuns(occurrenceAt, "superseded_by_newer_occurrence", now);
      const claim = input.schedule.claimRun(occurrenceAt, bootId, now);
      if (!claim) {
        input.schedule.setLastScan(now);
        return { ran: false };
      }

      const previous = reconcilePreviousAttempts(occurrenceAt);
      if (previous.unsafe) {
        const terminal = previous.completed ? "published" : "failed";
        input.schedule.finishRun(claim.claimToken, { status: terminal, ...(previous.itemId === undefined ? {} : { itemId: previous.itemId }), ...(previous.operationId === undefined ? {} : { operationId: previous.operationId }), errorCode: previous.completed ? "recovered_output" : "uncertain_publish" }, input.clock.now());
        input.schedule.setLastScan(input.clock.now());
        return { ran: true, occurrenceAt };
      }

      const context: ScheduledPublicationContext = { occurrenceAt, deadlineAt: claim.deadlineAt, claimToken: claim.claimToken };
      const outcome = await input.publisher.publishNext("publish", undefined, context);
      now = input.clock.now();
      if (outcome.kind === "retry_scheduled") {
        const retryAt = Math.min(outcome.retryAt, claim.deadlineAt);
        if (retryAt >= claim.deadlineAt || now >= claim.deadlineAt || !input.schedule.deferRun(claim.claimToken, retryAt, now, "telegram_rate_limited")) {
          input.schedule.finishRun(claim.claimToken, { status: "failed", errorCode: "retry_window_expired" }, now);
        }
      } else if (now >= claim.deadlineAt && outcome.kind === "empty") {
        input.schedule.finishRun(claim.claimToken, { status: "failed", errorCode: "retry_window_expired" }, now);
      } else {
        const run = outcomeToRun(outcome);
        input.schedule.finishRun(claim.claimToken, { status: run.status, ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }) }, now);
      }
      input.schedule.setLastScan(now);
      input.logger.info("schedule_run", { occurrenceAt, outcome: outcome.kind, itemId: "itemId" in outcome ? outcome.itemId : undefined, retryAt: outcome.kind === "retry_scheduled" ? outcome.retryAt : undefined });
      return { ran: true, occurrenceAt, outcome };
    } finally {
      scanBusy = false;
    }
  };

  const nextAt = (): number | undefined => {
    const now = input.clock.now();
    const normal = input.schedule.enabled() ? nextOccurrence(now, input.schedule.slots()) : undefined;
    const retry = input.schedule.enabled() ? input.schedule.nextPendingWake(now) : undefined;
    if (normal === undefined) return retry;
    if (retry === undefined) return normal;
    return Math.min(normal, retry);
  };

  const run = async (signal?: AbortSignal): Promise<void> => {
    if (loopRunning) return;
    loopRunning = true;
    const effectiveSignal = signal ?? new AbortController().signal;
    try {
      while (loopRunning && !effectiveSignal.aborted) {
        await scanOnce();
        const next = nextAt();
        const wait = next === undefined ? 1_000 : Math.max(1, Math.min(1_000, next - input.clock.now()));
        await abortableSleep(input.clock, wait, effectiveSignal);
      }
    } finally {
      loopRunning = false;
    }
  };

  const stop = (): void => { loopRunning = false; };
  const manualPublish = (expected?: ReadyCandidate): Promise<PublicationOutcome> => input.publisher.publishNext("manual_publish", expected);
  return { scanOnce, nextAt, run, stop, manualPublish };
};

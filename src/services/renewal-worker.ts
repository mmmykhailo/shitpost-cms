import type { QueueRepository } from "../db/repositories";
import {
  RENEWAL_IDLE_SCAN_MS,
  RENEWAL_MAX_ATTEMPTS_PER_CYCLE,
  RENEWAL_MAX_CLEANUPS_PER_CYCLE,
  RENEWAL_START_AGE_MS,
  renewalPacingCostMs,
} from "../domain/renewal-policy";
import type { Logger } from "../logger";
import type { Clock } from "../types";
import type { TelegramCooldown } from "../telegram-cooldown";
import { abortableSleep } from "./task-supervisor";
import type { RenewalService } from "./renewal";

export type RenewalWorkerPolicy = {
  minimumSourceAgeMs: number;
  idleScanMs: number;
  maximumAttemptsPerCycle: number;
  maximumCleanupsPerCycle: number;
};

export type RenewalCycleResult = {
  attempts: number;
  cleanupAttempts: number;
  renewed: number;
  uncertain: number;
  failed: number;
  attemptBudgetExhausted: boolean;
  nextWakeAt?: number;
};

export const createRenewalWorker = (input: {
  queue: QueueRepository;
  renewal: RenewalService;
  cooldown: TelegramCooldown;
  clock: Clock;
  logger: Logger;
  policy?: Partial<RenewalWorkerPolicy>;
}) => {
  const policy: RenewalWorkerPolicy = {
    minimumSourceAgeMs: input.policy?.minimumSourceAgeMs ?? RENEWAL_START_AGE_MS,
    idleScanMs: input.policy?.idleScanMs ?? RENEWAL_IDLE_SCAN_MS,
    maximumAttemptsPerCycle: input.policy?.maximumAttemptsPerCycle ?? RENEWAL_MAX_ATTEMPTS_PER_CYCLE,
    maximumCleanupsPerCycle: input.policy?.maximumCleanupsPerCycle ?? RENEWAL_MAX_CLEANUPS_PER_CYCLE,
  };
  for (const [label, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Renewal worker ${label} must be a positive safe integer`);
  }

  let nextRenewalAt = 0;
  let inFlightCycle: Promise<RenewalCycleResult> | undefined;

  const waitUntil = async (deadline: number, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return false;
    const delay = Math.max(0, deadline - input.clock.now());
    if (delay > 0) await abortableSleep(input.clock, delay, signal);
    return !signal.aborted;
  };

  const runCycleOnce = async (signal: AbortSignal): Promise<RenewalCycleResult> => {
    const result: RenewalCycleResult = {
      attempts: 0,
      cleanupAttempts: 0,
      renewed: 0,
      uncertain: 0,
      failed: 0,
      attemptBudgetExhausted: false,
    };
    if (signal.aborted) return result;

    const activeCooldown = input.cooldown.notBefore();
    if (activeCooldown > input.clock.now()) {
      result.nextWakeAt = activeCooldown;
      return result;
    }

    const cleanupItems = input.queue.listActive(10_000).filter((item) => item.maintenanceStatus === "renewal_cleanup_pending");
    for (const item of cleanupItems.slice(0, policy.maximumCleanupsPerCycle)) {
      if (signal.aborted) return result;
      const deadline = input.cooldown.notBefore();
      if (deadline > input.clock.now()) {
        result.nextWakeAt = deadline;
        return result;
      }
      await input.renewal.cleanupPending(item.id);
      result.cleanupAttempts += 1;
      if (signal.aborted) return result;
      const floodWait = input.cooldown.notBefore();
      if (floodWait > input.clock.now()) {
        result.nextWakeAt = floodWait;
        return result;
      }
    }

    for (; result.attempts < policy.maximumAttemptsPerCycle;) {
      if (signal.aborted) return result;
      const floodWait = input.cooldown.notBefore();
      if (floodWait > input.clock.now()) {
        result.nextWakeAt = floodWait;
        return result;
      }
      if (!await waitUntil(nextRenewalAt, signal)) return result;
      if (signal.aborted) return result;
      const afterPacingCooldown = input.cooldown.notBefore();
      if (afterPacingCooldown > input.clock.now()) {
        result.nextWakeAt = afterPacingCooldown;
        return result;
      }

      const attempt = await input.renewal.renewNextAttempt(policy.minimumSourceAgeMs);
      if (attempt.outcome.kind === "nothing_due") break;
      result.attempts += 1;
      if (attempt.outcome.kind === "renewed") result.renewed += 1;
      else if (attempt.outcome.kind === "uncertain") result.uncertain += 1;
      else result.failed += 1;

      nextRenewalAt = Math.max(nextRenewalAt, input.clock.now() + renewalPacingCostMs(attempt.sourceCount));
      if (attempt.outcome.kind === "retry_scheduled") {
        result.nextWakeAt = Math.max(attempt.outcome.retryAt, input.cooldown.notBefore());
        return result;
      }
      const cooldownAfterAttempt = input.cooldown.notBefore();
      if (cooldownAfterAttempt > input.clock.now()) {
        result.nextWakeAt = cooldownAfterAttempt;
        return result;
      }
      if (signal.aborted) return result;
    }

    if (result.attempts >= policy.maximumAttemptsPerCycle) {
      result.attemptBudgetExhausted = true;
      result.nextWakeAt = nextRenewalAt;
    } else if (cleanupItems.length > policy.maximumCleanupsPerCycle) {
      result.nextWakeAt = input.clock.now();
    } else {
      result.nextWakeAt = input.clock.now() + policy.idleScanMs;
    }

    if (result.attempts > 0 || result.cleanupAttempts > 0) input.logger.debug("renewal_cycle_completed", { attempts: result.attempts, cleanupAttempts: result.cleanupAttempts, renewed: result.renewed, uncertain: result.uncertain, failed: result.failed, attemptBudgetExhausted: result.attemptBudgetExhausted });
    return result;
  };

  const runCycle = (signal: AbortSignal): Promise<RenewalCycleResult> => {
    if (inFlightCycle !== undefined) return inFlightCycle;
    const cycle = runCycleOnce(signal);
    inFlightCycle = cycle.finally(() => {
      if (inFlightCycle === wrapped) inFlightCycle = undefined;
    });
    const wrapped = inFlightCycle;
    return wrapped;
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      const result = await runCycle(signal);
      if (signal.aborted) return;
      const deadline = result.nextWakeAt ?? input.clock.now() + policy.idleScanMs;
      if (!await waitUntil(deadline, signal) || signal.aborted) return;
    }
  };

  return { runCycle, run };
};

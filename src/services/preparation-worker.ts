import type { Logger } from "../logger";
import type { Clock } from "../types";
import type { TelegramCooldown } from "../telegram-cooldown";
import { abortableSleep } from "./task-supervisor";
import type { PreparationService } from "./preparation";

export type PreparationWorkerPolicy = {
  idleScanMs: number;
  maximumAttemptsPerCycle: number;
  maximumCleanupsPerCycle: number;
};

export const createPreparationWorker = (input: {
  preparation: PreparationService;
  cooldown: TelegramCooldown;
  clock: Clock;
  logger: Logger;
  policy?: Partial<PreparationWorkerPolicy>;
}) => {
  const policy: PreparationWorkerPolicy = {
    idleScanMs: input.policy?.idleScanMs ?? 1_000,
    maximumAttemptsPerCycle: input.policy?.maximumAttemptsPerCycle ?? 10,
    maximumCleanupsPerCycle: input.policy?.maximumCleanupsPerCycle ?? 25,
  };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Preparation worker ${key} must be a positive safe integer`);
  }

  let running = false;
  const runCycleOnce = async (signal?: AbortSignal): Promise<{ attempts: number; cleanups: number; pending: boolean; nextWakeAt?: number }> => {
    const result = { attempts: 0, cleanups: 0, pending: false } as { attempts: number; cleanups: number; pending: boolean; nextWakeAt?: number };
    if (signal?.aborted) return result;
    const cooldownAt = input.cooldown.notBefore();
    if (cooldownAt > input.clock.now()) {
      result.nextWakeAt = cooldownAt;
      return result;
    }
    try {
      result.cleanups = await input.preparation.cleanupPending(policy.maximumCleanupsPerCycle);
      for (; result.attempts < policy.maximumAttemptsPerCycle;) {
        if (signal?.aborted) break;
        const deadline = input.cooldown.notBefore();
        if (deadline > input.clock.now()) {
          result.nextWakeAt = deadline;
          break;
        }
        const outcome = await input.preparation.prepareNext();
        if (outcome.kind === "empty") break;
        result.attempts += 1;
        if (outcome.kind === "retry_scheduled") result.nextWakeAt = Math.max(outcome.retryAt, input.cooldown.notBefore());
      }
      result.pending = result.attempts === policy.maximumAttemptsPerCycle;
      if (result.attempts > 0 || result.cleanups > 0) input.logger.debug("preparation_cycle_completed", { attempts: result.attempts, cleanupAttempts: result.cleanups, pending: result.pending });
      return result;
    } catch (error) {
      input.logger.error("preparation_cycle_failed", { error: error instanceof Error ? error.message : String(error) });
      return result;
    }
  };

  const run = async (signal?: AbortSignal): Promise<void> => {
    if (running) return;
    running = true;
    const effectiveSignal = signal ?? new AbortController().signal;
    try {
      while (!effectiveSignal.aborted) {
        const cycle = await runCycleOnce(effectiveSignal);
        const wakeAt = cycle.pending ? input.clock.now() : cycle.nextWakeAt ?? input.clock.now() + policy.idleScanMs;
        const delay = Math.max(1, wakeAt - input.clock.now());
        await abortableSleep(input.clock, delay, effectiveSignal);
      }
    } finally {
      running = false;
    }
  };

  return { run, runCycleOnce };
};

import type { Clock } from "../types";
import type { Logger } from "../logger";

export const abortableSleep = async (clock: Clock, milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void clock.sleep(milliseconds).then(finish, finish);
  });
};

export type OperationTracker = ReturnType<typeof createOperationTracker>;

export const createOperationTracker = () => {
  const active = new Map<string, number>();
  let drainPromise: Promise<boolean> | undefined;
  let stopping = false;

  const begin = (operationId: string): (() => void) => {
    if (stopping) throw new Error("Runtime is stopping");
    active.set(operationId, (active.get(operationId) ?? 0) + 1);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const count = (active.get(operationId) ?? 1) - 1;
      if (count <= 0) active.delete(operationId);
      else active.set(operationId, count);
    };
  };

  const stopAccepting = (): void => { stopping = true; };
  const names = (): string[] => [...active.keys()];
  const waitForEmpty = (timeoutMs: number): Promise<boolean> => {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      while (active.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      return active.size === 0;
    })();
    return drainPromise;
  };
  return { begin, stopAccepting, names, waitForEmpty };
};

export type TaskSupervisor = ReturnType<typeof createTaskSupervisor>;

export const createTaskSupervisor = (input: { logger: Logger }) => {
  const controller = new AbortController();
  const tasks = new Map<string, Promise<void>>();
  let stopPromise: Promise<boolean> | undefined;
  let stopping = false;

  const sleepWithSignal = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    if (signal.aborted || milliseconds <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

  const start = (name: string, task: (signal: AbortSignal) => Promise<void>): void => {
    if (stopping || tasks.has(name)) return;
    const promise = (async () => {
      const backoffMs = [1_000, 5_000, 30_000, 60_000];
      let failures = 0;
      while (!controller.signal.aborted) {
        try {
          await task(controller.signal);
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          const delay = backoffMs[Math.min(failures, backoffMs.length - 1)]!;
          failures += 1;
          input.logger.error("supervised_task_failed", { task: name, error: error instanceof Error ? error.message : String(error), restartInMs: delay, failureCount: failures });
          await sleepWithSignal(delay, controller.signal);
          if (failures >= backoffMs.length && !controller.signal.aborted) {
            input.logger.error("supervised_task_disabled_after_restarts", { task: name, failureCount: failures });
            return;
          }
        }
      }
    })().finally(() => {
      tasks.delete(name);
    });
    tasks.set(name, promise);
  };

  const stopAndDrain = (timeoutMs: number): Promise<boolean> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    controller.abort();
    stopPromise = (async () => {
      const pending = [...tasks.values()];
      if (pending.length === 0) return true;
      let timedOut = false;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs)),
      ]);
      return !timedOut && tasks.size === 0;
    })();
    return stopPromise;
  };

  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    controller.abort();
  };

  const names = (): string[] => [...tasks.keys()];
  return { start, requestStop, stopAndDrain, names, get signal() { return controller.signal; } };
};

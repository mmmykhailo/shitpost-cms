import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger";
import { createOperationTracker, createTaskSupervisor } from "../src/services/task-supervisor";

describe("shutdown lifecycle", () => {
  test("waits for polling middleware and operations before closing workers", async () => {
    const tracker = createOperationTracker();
    const supervisor = createTaskSupervisor({ logger: createLogger("error") });
    const events: string[] = [];
    let finishMiddleware!: () => void;
    const middlewareFinished = new Promise<void>((resolve) => { finishMiddleware = resolve; });
    const finishOperation = tracker.begin("publish-1");

    supervisor.start("worker", async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      events.push("worker-drained");
    });
    tracker.stopAccepting();
    supervisor.requestStop();
    events.push("polling-stopped");
    const middlewareDrain = middlewareFinished.then(() => { events.push("middleware-drained"); });
    const operationDrain = tracker.waitForEmpty(500);
    expect(await Promise.race([operationDrain, Promise.resolve(false)])).toBe(false);

    finishMiddleware();
    finishOperation();
    await middlewareDrain;
    expect(await operationDrain).toBe(true);
    expect(await supervisor.stopAndDrain(500)).toBe(true);

    events.push("database-closed");
    expect(events[0]).toBe("polling-stopped");
    expect(events.at(-1)).toBe("database-closed");
    expect(events.indexOf("middleware-drained")).toBeLessThan(events.indexOf("database-closed"));
    expect(events.indexOf("worker-drained")).toBeLessThan(events.indexOf("database-closed"));
  });
});

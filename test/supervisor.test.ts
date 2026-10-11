import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logger";
import { createOperationTracker, createTaskSupervisor } from "../src/services/task-supervisor";

describe("runtime lifecycle helpers", () => {
  test("operation drain is idempotent and waits for the active operation", async () => {
    const tracker = createOperationTracker();
    const finish = tracker.begin("publish-1");
    tracker.stopAccepting();
    expect(() => tracker.begin("publish-2")).toThrow();
    const pending = tracker.waitForEmpty(100);
    finish();
    expect(await pending).toBe(true);
    expect(await tracker.waitForEmpty(100)).toBe(true);
  });

  test("task supervisor aborts a running loop and returns one shutdown promise", async () => {
    const supervisor = createTaskSupervisor({ logger: createLogger("error") });
    let aborted = false;
    supervisor.start("loop", async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    });
    const first = supervisor.stopAndDrain(100);
    expect(await supervisor.stopAndDrain(100)).toBe(await first);
    expect(aborted).toBe(true);
    expect(supervisor.names()).toEqual([]);
  });
});

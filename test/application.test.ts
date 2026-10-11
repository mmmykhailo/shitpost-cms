import { describe, expect, test } from "bun:test";
import type { Logger } from "../src/logger";
import { main, waitForShutdownStage } from "../src/application";

const loggerSpy = (): { logger: Logger; events: string[] } => {
  const events: string[] = [];
  const logger: Logger = {
    debug: (event) => events.push(`debug:${event}`),
    info: (event) => events.push(`info:${event}`),
    warn: (event) => events.push(`warn:${event}`),
    error: (event) => events.push(`error:${event}`),
  };
  return { logger, events };
};

describe("application composition", () => {
  test("exports an import-safe runner without starting polling", () => {
    expect(main).toBeFunction();
    expect(process.listenerCount("SIGINT")).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  test("waits for a successful shutdown stage", async () => {
    const { logger, events } = loggerSpy();
    expect(await waitForShutdownStage("complete", async () => "done", 100, logger)).toBe(true);
    expect(events).toEqual([]);
  });

  test("records rejected, timed-out, and immediately expired shutdown stages", async () => {
    const { logger, events } = loggerSpy();
    expect(await waitForShutdownStage("rejected", async () => { throw new Error("boom"); }, 100, logger)).toBe(false);
    expect(await waitForShutdownStage("expired", async () => undefined, 0, logger)).toBe(false);
    expect(await waitForShutdownStage("timed_out", () => new Promise<void>(() => {}), 1, logger)).toBe(false);
    expect(events).toEqual(["warn:shutdown_stage_failed", "error:shutdown_stage_timeout", "error:shutdown_stage_timeout"]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createRuntimeLease } from "../src/db/runtime";
import { createFakeClock } from "../src/clock";

const resources: Array<{ directory: string; close(): void }> = [];
afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("runtime lease", () => {
  test("allows one owner and recovers after expiry", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-lease-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    resources.push({ directory, close: database.close });
    const clock = createFakeClock(1_000);
    const first = createRuntimeLease(database, "one", clock, 100);
    const second = createRuntimeLease(database, "two", clock, 100);
    expect(first.acquire()).toBe(true);
    expect(second.acquire()).toBe(false);
    clock.advance(101);
    expect(second.acquire()).toBe(true);
    expect(first.heartbeat()).toBe(false);
  });
});

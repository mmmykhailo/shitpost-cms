import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStatusWriter, type RuntimeStatus } from "../src/runtime-status";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

const readStatus = (path: string): RuntimeStatus => JSON.parse(readFileSync(path, "utf8")) as RuntimeStatus;

describe("runtime status", () => {
  test("writes atomic, non-secret status records with readable permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-status-"));
    directories.push(directory);
    const path = join(directory, "ready.json");
    const writer = createRuntimeStatusWriter({
      path,
      releaseSha: "a".repeat(40),
      pid: 1234,
      processStartedAt: "2026-10-05T18:00:00.000Z",
      now: () => new Date("2026-10-05T18:00:01.000Z"),
    });

    writer.writeStarting();
    expect(readStatus(path)).toEqual({
      schemaVersion: 1,
      state: "starting",
      releaseSha: "a".repeat(40),
      pid: 1234,
      processStartedAt: "2026-10-05T18:00:00.000Z",
      changedAt: "2026-10-05T18:00:01.000Z",
    });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(existsSync(`${path}.tmp.1234`)).toBe(false);

    writer.writeReady(9876);
    const ready = readStatus(path);
    expect(ready.state).toBe("ready");
    expect(ready.botId).toBe(9876);
    expect(JSON.stringify(ready)).not.toContain("BOT_TOKEN");
    expect(JSON.stringify(ready)).not.toContain("DATABASE_PATH");

    writer.writeStopping();
    expect(readStatus(path).state).toBe("stopping");
    writer.remove();
    expect(existsSync(path)).toBe(false);
  });

  test("does not write a local status file when deployment status is disabled", () => {
    const writer = createRuntimeStatusWriter({ releaseSha: "development" });
    expect(() => writer.writeStarting()).not.toThrow();
    expect(() => writer.writeReady(1)).not.toThrow();
    expect(() => writer.writeStopping()).not.toThrow();
    expect(() => writer.remove()).not.toThrow();
  });

  test("fails clearly when the status directory is unavailable", () => {
    const writer = createRuntimeStatusWriter({ path: "/tmp/queuebot-status-missing/ready.json", releaseSha: "development", pid: 1234 });
    expect(() => writer.writeStarting()).toThrow();
  });
});

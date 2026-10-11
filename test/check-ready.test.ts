import { describe, expect, test } from "bun:test";
import { checkReadiness, ReadinessCheckError, runReadinessCheck } from "../deploy/check-ready";

const SHA = "a".repeat(40);
const ready = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  schemaVersion: 1,
  state: "ready",
  releaseSha: SHA,
  pid: 1234,
  processStartedAt: "2026-10-11T10:00:00.000Z",
  changedAt: "2026-10-11T10:30:00.000Z",
  botId: 99,
  ...overrides,
});

const rejects = (work: () => unknown, pattern: RegExp): void => {
  expect(work).toThrow(pattern);
};

describe("deployment readiness checker", () => {
  test("accepts a matching fresh ready record", () => {
    const status = checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "/run/status", maxAgeMs: "60000", now: Date.parse("2026-10-11T10:30:30.000Z"), readStatus: () => ready() });
    expect(status.state).toBe("ready");
  });

  test.each([
    ["wrong argument count", () => runReadinessCheck([SHA], {}, 0), /usage/],
    ["bad SHA", () => checkReadiness({ expectedSha: "bad", expectedPid: "1234", statusPath: "x", readStatus: () => ready() }), /expected SHA/],
    ["bad PID", () => checkReadiness({ expectedSha: SHA, expectedPid: "0", statusPath: "x", readStatus: () => ready() }), /expected PID/],
    ["invalid JSON", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", readStatus: () => "{" }), /invalid JSON/],
    ["wrong schema", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", readStatus: () => ready({ schemaVersion: 2 }) }), /unsupported schema/],
    ["wrong state", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", readStatus: () => ready({ state: "starting" }) }), /state is starting/],
    ["wrong release", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", readStatus: () => ready({ releaseSha: "b".repeat(40) }) }), /release SHA/],
    ["wrong PID", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", readStatus: () => ready({ pid: 1235 }) }), /PID does not/],
    ["invalid process time", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", readStatus: () => ready({ processStartedAt: "nope" }) }), /processStartedAt/],
    ["invalid changed time", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", readStatus: () => ready({ changedAt: "nope" }) }), /changedAt/],
    ["future changed time", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", now: Date.parse("2026-10-11T10:00:00.000Z"), readStatus: () => ready() }), /future/],
    ["bad bot ID", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", readStatus: () => ready({ botId: 0 }) }), /botId/],
    ["bad max age", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", maxAgeMs: "nope", readStatus: () => ready() }), /MAX_AGE/],
    ["stale max age", () => checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", maxAgeMs: "1", now: Date.parse("2026-10-11T10:30:30.000Z"), readStatus: () => ready() }), /too old/],
  ] as const)("rejects %s", (_label, work, pattern) => rejects(work, pattern));

  test("uses the configured status path and max age when run as a command", () => {
    let pathSeen = "";
    const status = runReadinessCheck([SHA, "1234"], { RUNTIME_STATUS_PATH: "/custom/status", READINESS_MAX_AGE_MS: "60000" }, Date.parse("2026-10-11T10:30:30.000Z"), (path) => { pathSeen = path; return ready(); });
    expect(status).toBeDefined();
    expect(pathSeen).toBe("/custom/status");
  });

  test("exports a typed readiness error", () => {
    try {
      checkReadiness({ expectedSha: SHA, expectedPid: "1234", statusPath: "x", readStatus: () => ready({ state: "stopping" }) });
    } catch (error) {
      expect(error).toBeInstanceOf(ReadinessCheckError);
    }
  });
});

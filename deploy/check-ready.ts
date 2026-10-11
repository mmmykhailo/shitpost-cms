import { readFileSync } from "node:fs";
import type { RuntimeStatus } from "../src/runtime-status";

export type ReadinessEnvironment = Record<string, string | undefined>;

export type ReadinessInput = {
  expectedSha: string;
  expectedPid: string;
  statusPath: string;
  maxAgeMs?: string;
  now?: number;
  readStatus?: (path: string) => string;
};

export class ReadinessCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadinessCheckError";
  }
}

const fail = (message: string): never => {
  throw new ReadinessCheckError(message);
};

const parsePid = (raw: string): number => {
  if (!/^\d+$/u.test(raw)) fail("expected PID is invalid");
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0) fail("expected PID is invalid");
  return pid;
};

const parseStatus = (text: string): RuntimeStatus => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) fail("status file is missing or invalid JSON");
    return value as RuntimeStatus;
  } catch (error) {
    if (error instanceof ReadinessCheckError) throw error;
    return fail("status file is missing or invalid JSON");
  }
};

export const checkReadiness = (input: ReadinessInput): RuntimeStatus => {
  if (!/^[0-9a-f]{40}$/u.test(input.expectedSha)) fail("expected SHA is invalid");
  const expectedPid = parsePid(input.expectedPid);
  const now = input.now ?? Date.now();
  const readStatus = input.readStatus ?? ((path: string) => readFileSync(path, "utf8"));
  const status = (() => {
    try {
      return parseStatus(readStatus(input.statusPath));
    } catch (error) {
      if (error instanceof ReadinessCheckError && error.message === "status file is missing or invalid JSON") throw error;
      return fail("status file is missing or invalid JSON");
    }
  })();

  if (status.schemaVersion !== 1) fail("unsupported schema version");
  if (status.state !== "ready") fail(`state is ${String(status.state)}`);
  if (status.releaseSha !== input.expectedSha) fail("release SHA does not match");
  if (status.pid !== expectedPid) fail("PID does not match systemd MainPID");
  if (!Number.isSafeInteger(status.pid) || status.pid <= 0) fail("status PID is invalid");
  if (typeof status.processStartedAt !== "string" || Number.isNaN(Date.parse(status.processStartedAt))) fail("processStartedAt is invalid");
  if (typeof status.changedAt !== "string") fail("changedAt is invalid");
  const changedAt = Date.parse(status.changedAt);
  if (Number.isNaN(changedAt)) fail("changedAt is invalid");
  if (changedAt > now) fail("changedAt is in the future");
  if (status.botId !== undefined && (!Number.isSafeInteger(status.botId) || status.botId <= 0)) fail("botId is invalid");

  if (input.maxAgeMs !== undefined && input.maxAgeMs !== "") {
    if (!/^\d+$/u.test(input.maxAgeMs)) fail("READINESS_MAX_AGE_MS is invalid");
    const maxAge = Number(input.maxAgeMs);
    if (!Number.isSafeInteger(maxAge) || now - changedAt > maxAge) fail("status record is too old");
  }
  return status;
};

export const runReadinessCheck = (argv: readonly string[], environment: ReadinessEnvironment = process.env, now = Date.now(), readStatus?: (path: string) => string): RuntimeStatus => {
  if (argv.length !== 2 || argv[0] === undefined || argv[1] === undefined) fail("usage: check-ready.ts <40-character-sha> <main-pid>");
  const expectedSha = argv[0]!;
  const expectedPid = argv[1]!;
  const statusPath = environment.RUNTIME_STATUS_PATH?.trim() || "/run/shitpost-cms/ready.json";
  const maxAgeMs = environment.READINESS_MAX_AGE_MS;
  return checkReadiness({
    expectedSha,
    expectedPid,
    statusPath,
    ...(maxAgeMs === undefined ? {} : { maxAgeMs: maxAgeMs.trim() }),
    now,
    ...(readStatus === undefined ? {} : { readStatus }),
  });
};

if (import.meta.main) {
  try {
    runReadinessCheck(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof ReadinessCheckError ? error.message : "unexpected readiness check failure";
    console.error(`readiness check failed: ${message}`);
    process.exitCode = 1;
  }
}

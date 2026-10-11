import { readFileSync } from "node:fs";
import type { RuntimeStatus } from "../src/runtime-status";

const fail = (message: string): never => {
  console.error(`readiness check failed: ${message}`);
  process.exit(1);
};

const [expectedSha, expectedPidRaw] = process.argv.slice(2);
if (expectedSha === undefined || expectedPidRaw === undefined || process.argv.length !== 4) fail("usage: check-ready.ts <40-character-sha> <main-pid>");
if (!/^[0-9a-f]{40}$/.test(expectedSha)) fail("expected SHA is invalid");
if (!/^\d+$/.test(expectedPidRaw)) fail("expected PID is invalid");
const expectedPid = Number(expectedPidRaw);
if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) fail("expected PID is invalid");

const statusPath = process.env.RUNTIME_STATUS_PATH?.trim() || "/run/shitpost-cms/ready.json";
let status: RuntimeStatus;
try {
  status = JSON.parse(readFileSync(statusPath, "utf8")) as RuntimeStatus;
} catch {
  fail("status file is missing or invalid JSON");
}

if (status.schemaVersion !== 1) fail("unsupported schema version");
if (status.state !== "ready") fail(`state is ${String(status.state)}`);
if (status.releaseSha !== expectedSha) fail("release SHA does not match");
if (status.pid !== expectedPid) fail("PID does not match systemd MainPID");
if (!Number.isSafeInteger(status.pid) || status.pid <= 0) fail("status PID is invalid");
if (typeof status.processStartedAt !== "string" || Number.isNaN(Date.parse(status.processStartedAt))) fail("processStartedAt is invalid");
if (typeof status.changedAt !== "string") fail("changedAt is invalid");
const changedAt = Date.parse(status.changedAt);
if (Number.isNaN(changedAt)) fail("changedAt is invalid");
if (changedAt > Date.now()) fail("changedAt is in the future");
if (status.botId !== undefined && (!Number.isSafeInteger(status.botId) || status.botId <= 0)) fail("botId is invalid");

const maxAgeRaw = process.env.READINESS_MAX_AGE_MS?.trim();
if (maxAgeRaw !== undefined && maxAgeRaw !== "") {
  if (!/^\d+$/.test(maxAgeRaw)) fail("READINESS_MAX_AGE_MS is invalid");
  const maxAge = Number(maxAgeRaw);
  if (!Number.isSafeInteger(maxAge) || Date.now() - changedAt > maxAge) fail("status record is too old");
}

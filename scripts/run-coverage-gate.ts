import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { runCoverageGate } from "./check-coverage";

const root = process.cwd();
const coverageDirectory = resolve(root, "coverage");
const lcovPath = resolve(coverageDirectory, "lcov.info");

rmSync(coverageDirectory, { recursive: true, force: true });
mkdirSync(coverageDirectory, { recursive: true });

const processResult = Bun.spawnSync([process.execPath, "test", "--coverage", "--coverage-reporter=lcov"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (!processResult.success) {
  process.exitCode = processResult.exitCode ?? 1;
} else {
  try {
    runCoverageGate({ root, coveragePath: lcovPath });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

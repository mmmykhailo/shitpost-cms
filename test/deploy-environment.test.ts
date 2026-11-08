import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

const step = (name: string) => {
  const text = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0];
  const [header, body] = text?.split("        run: |\n") ?? [];
  if (!header || !body) throw new Error(`Missing deploy step ${name}`);
  const mapsWidgetMode = header.includes("ADMIN_WIDGETS: ${{ vars.ADMIN_WIDGETS }}");
  return { mapsWidgetMode, shell: body.split("\n").map((line) => line.slice(10)).join("\n") };
};

test("production forwards the widget mode and rejects the separate Telegram test environment", () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-widget-env-"));
  try {
    const stub = join(directory, "ssh");
    writeFileSync(stub, '#!/bin/sh\ncat > "$RUNNER_TEMP/staged.env"\n');
    chmodSync(stub, 0o700);
    const env = {
      PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory,
      BOT_TOKEN: "1:fake", ADMIN_USER_ID: "1", QUEUE_CHANNEL_ID: "-1001", TARGET_CHANNEL_ID: "-1002",
      GITHUB_SHA: "a".repeat(40), VPS_HOST: "example.test", VPS_USER: "deploy",
      VPS_SSH_KEY: "fixture", VPS_KNOWN_HOSTS: "fixture",
    };
    const run = (name: string, mode: string) => {
      const { mapsWidgetMode, shell } = step(name);
      return Bun.spawnSync(["bash", "-c", shell], {
        env: { ...env, ...(mapsWidgetMode ? { ADMIN_WIDGETS: mode } : {}) },
        stdout: "pipe", stderr: "pipe",
      });
    };
    for (const [value, expected] of [["", "classic"], ["widget", "widget"]] as const) {
      expect(run("Validate production configuration", value).exitCode).toBe(0);
      expect(run("Render and upload bot environment", value).exitCode).toBe(0);
      const staged = readFileSync(join(directory, "staged.env"), "utf8");
      expect(staged.split("\n").find((line) => line.startsWith("ADMIN_WIDGETS="))).toBe(`ADMIN_WIDGETS=${expected}`);
    }
    const rejected = run("Validate production configuration", "beta-test");
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain("ADMIN_WIDGETS=beta-test requires a separate Telegram test bot");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";

const base = {
  BOT_TOKEN: "token",
  ADMIN_USER_ID: "42",
  QUEUE_CHANNEL_ID: "-1001",
  TARGET_CHANNEL_ID: "-1002",
};

describe("configuration", () => {
  test("validates IDs and keeps relative database paths inside the project", () => {
    const config = parseConfig(base, "/tmp/project");
    expect(config.databasePath).toBe("/tmp/project/data/bot.sqlite");
    expect(() => parseConfig({ ...base, DATABASE_PATH: "../../outside.sqlite" }, "/tmp/project")).toThrow(/inside/);
    expect(() => parseConfig({ ...base, QUEUE_CHANNEL_ID: "-1002" }, "/tmp/project")).toThrow(/differ/);
  });

  test("rejects missing and malformed environment values", () => {
    expect(() => parseConfig({ ...base, BOT_TOKEN: "" })).toThrow(/BOT_TOKEN/);
    expect(() => parseConfig({ ...base, ADMIN_USER_ID: "not-an-id" })).toThrow(/ADMIN_USER_ID/);
    expect(() => parseConfig({ ...base, LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type AppDatabase } from "../src/db/database";
import type { LogFields, Logger } from "../src/logger";

export type TestDatabase = {
  directory: string;
  path: string;
  database: AppDatabase;
  close(): void;
};

export const createTestDatabase = (prefix = "queuebot-test"): TestDatabase => {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const path = join(directory, "bot.sqlite");
  const database = createDatabase(path);
  let closed = false;
  return {
    directory,
    path,
    database,
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

export type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields: LogFields;
};

export type LoggerSpy = {
  logger: Logger;
  entries: LogEntry[];
};

export const createLoggerSpy = (): LoggerSpy => {
  const entries: LogEntry[] = [];
  const record = (level: LogEntry["level"], event: string, fields: LogFields = {}): void => {
    entries.push({ level, event, fields });
  };
  return {
    entries,
    logger: {
      debug: (event, fields) => record("debug", event, fields),
      info: (event, fields) => record("info", event, fields),
      warn: (event, fields) => record("warn", event, fields),
      error: (event, fields) => record("error", event, fields),
    },
  };
};

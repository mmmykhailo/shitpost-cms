import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrations } from "./migrations";

export type AppDatabase = {
  readonly path: string;
  readonly raw: Database;
  close(): void;
  transaction<T>(work: () => T): T;
};

export const createDatabase = (path: string): AppDatabase => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const raw = new Database(path, { create: true, strict: true });
    raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    applyMigrations(raw);
    return {
      path,
      raw,
      close: () => raw.close(),
      transaction: <T>(work: () => T): T => {
        raw.exec("BEGIN IMMEDIATE");
        try {
          const result = work();
          raw.exec("COMMIT");
          return result;
        } catch (error) {
          raw.exec("ROLLBACK");
          throw error;
        }
      },
    };
};

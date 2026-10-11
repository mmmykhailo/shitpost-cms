import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrations } from "./migrations";

export class AppDatabase {
  readonly raw: Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw = new Database(path, { create: true, strict: true });
    this.raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    applyMigrations(this.raw);
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(work: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

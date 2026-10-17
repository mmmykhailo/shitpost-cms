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
    let transactionDepth = 0;
    let savepointSequence = 0;
    return {
      path,
      raw,
      close: () => raw.close(),
      transaction: <T>(work: () => T): T => {
        const outermost = transactionDepth === 0;
        const savepoint = outermost ? undefined : `internal_${++savepointSequence}`;
        raw.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
        transactionDepth += 1;
        try {
          const result = work();
          if ((typeof result === "object" && result !== null || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
            // Avoid an unhandled rejection when rejecting an accidentally async callback.
            void Promise.resolve(result).catch(() => undefined);
            throw new Error("Database transaction callbacks must finish synchronously");
          }
          raw.exec(outermost ? "COMMIT" : `RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          if (outermost) raw.exec("ROLLBACK");
          else {
            raw.exec(`ROLLBACK TO ${savepoint}`);
            raw.exec(`RELEASE ${savepoint}`);
          }
          throw error;
        } finally {
          transactionDepth -= 1;
        }
      },
    };
};

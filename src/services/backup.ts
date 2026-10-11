import { chmodSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { AppDatabase } from "../db/database";
import type { Logger } from "../logger";

const sqlPath = (path: string): string => `'${path.replaceAll("'", "''")}'`;

export type BackupService = ReturnType<typeof createBackupService>;

export const createBackupService = (input: { database: AppDatabase; directory: string; logger: Logger; now?: () => number }) => {
  const runOnce = (): string => {
    mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    const stamp = new Date((input.now ?? Date.now)()).toISOString().replaceAll(/[:.]/gu, "-");
    const finalPath = join(input.directory, `bot-${stamp}.sqlite`);
    const temporaryPath = join(input.directory, `.backup-${randomUUID()}.sqlite`);
    try {
      input.database.raw.exec(`VACUUM INTO ${sqlPath(temporaryPath)}`);
      const check = new Database(temporaryPath, { create: false, strict: true });
      try {
        const result = check.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
        if (result?.integrity_check !== "ok") throw new Error("Backup integrity_check failed");
      } finally {
        check.close();
      }
      renameSync(temporaryPath, finalPath);
      chmodSync(finalPath, 0o600);
      const backups = readdirSync(input.directory).filter((name) => /^bot-.*\.sqlite$/u.test(name)).sort().reverse();
      for (const old of backups.slice(7)) unlinkSync(join(input.directory, old));
      input.logger.info("backup_completed", { path: finalPath });
      return finalPath;
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* best effort */ }
      throw error;
    }
  };
  return { runOnce };
};

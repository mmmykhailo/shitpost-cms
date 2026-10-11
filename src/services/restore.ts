import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

export type RestoreInspection = {
  path: string;
  schemaVersion: number;
  integrity: "ok";
};

export type RestoreResult = RestoreInspection & {
  destinationPath: string;
  previousPath?: string;
};

const inspect = (path: string): RestoreInspection => {
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) throw new Error("Restore source must be a standalone SQLite backup without WAL sidecars");
  const database = new Database(path, { create: false, readonly: true, strict: true });
  try {
    const integrity = database.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    if (integrity?.integrity_check !== "ok") throw new Error("Restore source failed PRAGMA integrity_check");
    const schema = database.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null } | null;
    if (schema?.version === null || schema?.version === undefined) throw new Error("Restore source has no schema migration history");
    return { path, schemaVersion: schema.version, integrity: "ok" };
  } finally {
    database.close();
  }
};

export const createRestoreService = () => {
  const inspectBackup = (path: string): RestoreInspection => inspect(resolve(path));

  const restoreBackup = (sourcePath: string, destinationPath: string): RestoreResult => {
    const source = resolve(sourcePath);
    const destination = resolve(destinationPath);
    if (source === destination) throw new Error("Restore source and destination must be different files");
    const sourceInspection = inspect(source);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.restore-${randomUUID()}`;
    let previousPath: string | undefined;
    try {
      copyFileSync(source, temporary);
      inspect(temporary);
      if (existsSync(destination)) {
        previousPath = `${destination}.before-restore-${randomUUID()}`;
        renameSync(destination, previousPath);
      }
      renameSync(temporary, destination);
      return { ...sourceInspection, path: source, destinationPath, ...(previousPath === undefined ? {} : { previousPath }) };
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* best effort */ }
      if (previousPath !== undefined && !existsSync(destination)) {
        try { renameSync(previousPath, destination); } catch { /* preserve the original error */ }
      }
      throw error;
    }
  };

  return { inspectBackup, restoreBackup };
};


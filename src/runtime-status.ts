import { chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";

export type RuntimeStatus = {
  schemaVersion: 1;
  state: "starting" | "ready" | "stopping";
  releaseSha: string;
  pid: number;
  processStartedAt: string;
  changedAt: string;
  botId?: number;
};

type RuntimeStatusWriterInput = {
  path?: string;
  releaseSha: string;
  pid?: number;
  processStartedAt?: string;
  now?: () => Date;
};

const ignoreMissing = (path: string): void => {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

export const createRuntimeStatusWriter = (input: RuntimeStatusWriterInput) => {
  const statusPath = input.path;
  const pid = input.pid ?? process.pid;
  const processStartedAt = input.processStartedAt ?? new Date().toISOString();
  const now = input.now ?? (() => new Date());

  const write = (state: RuntimeStatus["state"], botId?: number): void => {
    if (statusPath === undefined) return;
    const status: RuntimeStatus = {
      schemaVersion: 1,
      state,
      releaseSha: input.releaseSha,
      pid,
      processStartedAt,
      changedAt: now().toISOString(),
      ...(botId === undefined ? {} : { botId }),
    };
    const temporaryPath = `${statusPath}.tmp.${pid}`;
    let descriptor: number | undefined;
    try {
      ignoreMissing(temporaryPath);
      descriptor = openSync(temporaryPath, "wx", 0o600);
      const payload = `${JSON.stringify(status)}\n`;
      writeSync(descriptor, payload);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, statusPath);
      chmodSync(statusPath, 0o644);
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); }
        catch { /* Preserve the original write error. */ }
      }
      try { ignoreMissing(temporaryPath); }
      catch { /* Preserve the original write error. */ }
      throw error;
    }
  };

  const remove = (): void => {
    if (statusPath === undefined) return;
    ignoreMissing(statusPath);
    ignoreMissing(`${statusPath}.tmp.${pid}`);
  };

  return {
    writeStarting: (): void => write("starting"),
    writeReady: (botId: number): void => write("ready", botId),
    writeStopping: (): void => write("stopping"),
    remove,
  };
};

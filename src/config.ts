import { dirname, isAbsolute, relative, resolve } from "node:path";
import { asChatId, asUserId, type ChatId, type UserId } from "./types";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type AppConfig = {
  botToken: string;
  adminUserId: UserId;
  queueChannelId: ChatId;
  targetChannelId: ChatId;
  databasePath: string;
  dataDirectory: string;
  logLevel: LogLevel;
  releaseSha: string;
  runtimeStatusPath?: string;
};

const required = (environment: Record<string, string | undefined>, name: string): string => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const parseInteger = (environment: Record<string, string | undefined>, name: string): number => {
  const raw = required(environment, name);
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  return value;
};

const validateDatabasePath = (rawPath: string, workingDirectory: string): string => {
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workingDirectory, rawPath);
  const relativePath = relative(workingDirectory, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${"/"}`) || isAbsolute(relativePath)) {
    throw new Error("DATABASE_PATH must stay inside the project working directory");
  }
  if (absolutePath === workingDirectory) throw new Error("DATABASE_PATH must point to a file");
  return absolutePath;
};

export const parseConfig = (
  environment: Record<string, string | undefined> = process.env,
  workingDirectory = process.cwd(),
): AppConfig => {
  const botToken = required(environment, "BOT_TOKEN");
  const adminUserId = parseInteger(environment, "ADMIN_USER_ID");
  const queueChannelId = parseInteger(environment, "QUEUE_CHANNEL_ID");
  const targetChannelId = parseInteger(environment, "TARGET_CHANNEL_ID");
  if (adminUserId <= 0) throw new Error("ADMIN_USER_ID must be positive");
  if (queueChannelId === targetChannelId) throw new Error("QUEUE_CHANNEL_ID and TARGET_CHANNEL_ID must differ");
  const rawDatabasePath = environment.DATABASE_PATH?.trim() || "./data/bot.sqlite";
  const databasePath = validateDatabasePath(rawDatabasePath, resolve(workingDirectory));
  const rawLogLevel = environment.LOG_LEVEL?.trim() || "info";
  if (!(["debug", "info", "warn", "error"] as const).includes(rawLogLevel as LogLevel)) {
    throw new Error("LOG_LEVEL must be one of debug, info, warn, error");
  }
  const rawReleaseSha = environment.RELEASE_SHA?.trim() || undefined;
  const runtimeStatusPath = environment.RUNTIME_STATUS_PATH?.trim() || undefined;
  if (rawReleaseSha === undefined && runtimeStatusPath !== undefined) throw new Error("RELEASE_SHA is required when RUNTIME_STATUS_PATH is set");
  if (rawReleaseSha !== undefined && runtimeStatusPath === undefined) throw new Error("RUNTIME_STATUS_PATH is required when RELEASE_SHA is set");
  if (rawReleaseSha !== undefined && rawReleaseSha !== "development" && !/^[0-9a-f]{40}$/.test(rawReleaseSha)) {
    throw new Error("RELEASE_SHA must be development or a 40-character lowercase hexadecimal SHA");
  }
  if (runtimeStatusPath !== undefined && (!isAbsolute(runtimeStatusPath) || runtimeStatusPath.includes("\0") || runtimeStatusPath.includes("\n"))) {
    throw new Error("RUNTIME_STATUS_PATH must be an absolute path without control characters");
  }
  return {
    botToken,
    adminUserId: asUserId(adminUserId),
    queueChannelId: asChatId(queueChannelId),
    targetChannelId: asChatId(targetChannelId),
    databasePath,
    dataDirectory: dirname(databasePath),
    logLevel: rawLogLevel as LogLevel,
    releaseSha: rawReleaseSha ?? "development",
    ...(runtimeStatusPath === undefined ? {} : { runtimeStatusPath }),
  };
};

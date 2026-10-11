import type { LogLevel } from "./config";

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export type Logger = {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

const write = (level: LogLevel, minimum: LogLevel, event: string, fields: LogFields): void => {
  if (priorities[level] < priorities[minimum]) return;
  const payload = { timestamp: new Date().toISOString(), level, event, ...fields };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const createLogger = (minimum: LogLevel = "info"): Logger => ({
  debug: (event, fields = {}) => write("debug", minimum, event, fields),
  info: (event, fields = {}) => write("info", minimum, event, fields),
  warn: (event, fields = {}) => write("warn", minimum, event, fields),
  error: (event, fields = {}) => write("error", minimum, event, fields),
});

export const safeErrorDescription = (error: unknown): string => {
  if (error instanceof Error) return error.message.replace(/\b\d{6,}:\w+\b/g, "[redacted]");
  return "Unknown error";
};

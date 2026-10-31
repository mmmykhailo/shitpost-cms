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

// Persist operational metadata only; never retain captions or message contents.
const recentFieldKeys = new Set([
  "itemId", "operationId", "messageId", "chatId", "queueChatId", "targetChatId", "botId",
  "updateId", "incidentId", "outboxId", "responseId", "generation", "count", "kind", "errorKind",
  "method", "family", "state", "status", "stage", "task", "signal", "actionKind", "outcome",
  "attempt", "attempts", "failureCount", "delayMs", "restartInMs", "requestStarted", "knownOutputIds",
  "occurrenceAt", "retryAt", "cooldownUntil", "elapsedMs", "durationMs", "bytes", "sizeBytes",
  "requeued", "uncertain", "cleanupPending", "completed", "blocked", "failed", "renewed", "pending",
  "cleanupAttempts", "attemptBudgetExhausted", "redactedItems", "redactedMessages", "purgedResponses",
  "purgedAdminUpdates", "purgedIncidents", "sourceGeneration", "contentVersion", "phase",
  "error", "reason", "description",
]);

const redactDiagnostic = (value: string): string => value
  .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, "[redacted]")
  .replace(/\b(?:authorization|cookie|set-cookie|sessionid|csrftoken|password|secret|access[_-]?token|token)\s*[:=]\s*[^\r\n]+/giu, "[redacted]")
  .replace(/\bbearer\s+[^\s,;]+/giu, "[redacted]")
  .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/giu, "[redacted]")
  .replace(/(?:[a-zA-Z]:\\|(?:^|\s)\/)[^\s<>"']+/gu, " [redacted]")
  .replace(/[\u0000-\u001f\u007f]/gu, " ")
  .slice(0, 300);

const operationalString = (value: string, maximum: number): string => {
  // Token values are useful for correlation, while unrestricted prose is unsafe.
  if (!/^[a-zA-Z0-9_.:-]+$/u.test(value)
    || /\d{6,}:[A-Za-z0-9_-]{20,}/u.test(value)
    || /(?:bearer|cookie|authorization|token|password|secret)/iu.test(value)) return "[redacted]";
  return value.slice(0, maximum);
};

export const sanitizeRecentLog = (event: string, fields: LogFields = {}): { event: string; fields: LogFields } => {
  const sanitized: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!recentFieldKeys.has(key) || value === undefined) continue;
    if (typeof value === "string") sanitized[key] = ["error", "reason", "description"].includes(key)
      ? redactDiagnostic(value) : operationalString(value, 300);
    else if (typeof value === "number") {
      if (Number.isFinite(value)) sanitized[key] = value;
    } else if (typeof value === "boolean" || value === null) sanitized[key] = value;
  }
  return { event: operationalString(event, 100), fields: sanitized };
};

export const withRecentLogs = (
  base: Logger,
  sink: (level: LogLevel, event: string, fields: LogFields) => void,
  minimum: LogLevel = "info",
): Logger => {
  const forward = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    base[level](event, fields);
    if (priorities[level] < priorities[minimum]) return;
    try {
      const sanitized = sanitizeRecentLog(event, fields);
      sink(level, sanitized.event, sanitized.fields);
    } catch {
      // A full disk or unavailable log store must never interrupt bot work.
    }
  };
  return {
    debug: (event, fields) => forward("debug", event, fields),
    info: (event, fields) => forward("info", event, fields),
    warn: (event, fields) => forward("warn", event, fields),
    error: (event, fields) => forward("error", event, fields),
  };
};

export const safeErrorDescription = (error: unknown): string => {
  const redact = (message: string): string => message.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, "[redacted]");
  if (error instanceof Error) return redact(error.message);
  if (typeof error === "object" && error !== null) {
    const candidate = error as { description?: unknown; message?: unknown };
    if (typeof candidate.description === "string") return redact(candidate.description);
    if (typeof candidate.message === "string") return redact(candidate.message);
  }
  return "Unknown error";
};

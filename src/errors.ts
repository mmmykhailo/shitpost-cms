import type { NormalizedTelegramError, NormalizedTelegramErrorKind } from "./types";

export class OperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationConflictError";
  }
}

type TelegramLikeError = {
  error_code?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown };
  status?: unknown;
  message?: unknown;
};

const descriptionOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const candidate = error as TelegramLikeError;
    if (typeof candidate.description === "string") return candidate.description;
    if (typeof candidate.message === "string") return candidate.message;
  }
  if (error instanceof Error) return error.message;
  return "Unknown Telegram error";
};

const numeric = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export const classifyTelegramError = (error: unknown, method?: string): NormalizedTelegramError => {
  if (typeof error === "object" && error !== null && "kind" in error && "description" in error) {
    const normalized = error as NormalizedTelegramError;
    if (method !== undefined && normalized.method === undefined) return { ...normalized, method };
    return normalized;
  }
  const candidate = typeof error === "object" && error !== null ? (error as TelegramLikeError) : {};
  const code = numeric(candidate.error_code) ?? numeric(candidate.status);
  const description = descriptionOf(error);
  const lower = description.toLowerCase();
  const retryAfterSeconds = numeric(candidate.parameters?.retry_after);
  let kind: NormalizedTelegramErrorKind;
  if (code === 429 || retryAfterSeconds !== undefined || lower.includes("too many requests")) kind = "rate_limited";
  else if (lower.includes("message to delete not found") || lower.includes("message not found") || lower.includes("message_id_invalid")) kind = "source_missing";
  else if (lower.includes("protected content") || lower.includes("can't be forwarded") || lower.includes("cannot be forwarded")) kind = "content_protected";
  else if (lower.includes("not enough rights") || lower.includes("forbidden") || code === 401 || code === 403) kind = "permission_denied";
  else if (lower.includes("48 hours") || lower.includes("too old") || lower.includes("message is too old") || lower.includes("can't be deleted after")) kind = "telegram_age_limit";
  else if (lower.includes("chat not found") || lower.includes("destination")) kind = "destination_unavailable";
  else if (lower.includes("can't copy") || lower.includes("cannot copy") || lower.includes("unsupported") || lower.includes("paid media") || lower.includes("invoice") || lower.includes("giveaway")) kind = "unsupported_content";
  else if (lower.includes("entity") || lower.includes("caption") || lower.includes("message is too long") || lower.includes("text is too long") || lower.includes("exceeds telegram limit") || lower.includes("exceeds the limit")) kind = "invalid_content_or_entities";
  else if (code !== undefined && code >= 500) kind = "transient_server";
  else if (error instanceof TypeError || error instanceof Error && /fetch|network|timeout|socket|econn|reset/i.test(error.message)) kind = "transient_network";
  else kind = "unknown_permanent";
  const normalized: NormalizedTelegramError = { kind, description, cause: error };
  if (code !== undefined) normalized.code = code;
  if (retryAfterSeconds !== undefined) normalized.retryAfterSeconds = retryAfterSeconds;
  if (method !== undefined) normalized.method = method;
  return normalized;
};

export const isRetryable = (error: NormalizedTelegramError): boolean =>
  error.kind === "rate_limited" || error.kind === "transient_network" || error.kind === "transient_server";

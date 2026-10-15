import type { NormalizedTelegramError, NormalizedTelegramErrorKind } from "./types";

export class OperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationConflictError";
  }
}

export class InvalidTelegramOutputError extends Error {
  readonly knownOutputs: readonly number[];
  readonly requestMayHaveSucceeded: boolean;

  constructor(message: string, knownOutputs: readonly number[] = [], requestMayHaveSucceeded = true) {
    super(message);
    this.name = "InvalidTelegramOutputError";
    this.knownOutputs = knownOutputs;
    this.requestMayHaveSucceeded = requestMayHaveSucceeded;
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
  if (error instanceof InvalidTelegramOutputError) {
    const normalized: NormalizedTelegramError = { kind: "ambiguous_send_result", method: method ?? "recordOutput", description: error.message, requestMayHaveSucceeded: error.requestMayHaveSucceeded, cause: error };
    if (error.knownOutputs.length > 0) normalized.knownOutputs = error.knownOutputs as NormalizedTelegramError["knownOutputs"] & {};
    return normalized;
  }
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
  else if (["message to delete not found", "message to copy not found", "message to forward not found", "message to edit not found"].some((phrase) => lower.includes(phrase))) kind = "source_missing";
  else if (lower.includes("protected content") || lower.includes("can't be forwarded") || lower.includes("cannot be forwarded")) kind = "content_protected";
  else if (lower.includes("not enough rights") || lower.includes("forbidden") || code === 401 || code === 403) kind = "permission_denied";
  else if (lower.includes("48 hours") || lower.includes("too old") || lower.includes("message is too old") || lower.includes("can't be deleted after") || lower.includes("can't be deleted for everyone") || lower.includes("cannot be deleted for everyone")) kind = "telegram_age_limit";
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

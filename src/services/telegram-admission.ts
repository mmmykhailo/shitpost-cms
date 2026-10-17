import type { Api, Transformer } from "grammy";
import { classifyTelegramError, TelegramLocalDeferralError } from "../errors";
import type { TelegramAdmissionRepository } from "../db/telegram-admission-repository";
import type { Logger } from "../logger";
import type { TelegramCooldown } from "../telegram-cooldown";
import type { Clock } from "../types";
import { asNumericChatId, telegramMutationScope, type TelegramMutationScope, type TelegramRequestResult } from "../telegram-request-context";

const MUTATION_METHODS = new Set([
  "sendMessage", "sendPhoto", "sendVideo", "sendDocument", "sendAudio", "sendAnimation", "sendVoice", "sendVideoNote", "sendMediaGroup",
  "forwardMessage", "forwardMessages", "copyMessage", "copyMessages", "editMessageText", "editMessageCaption", "editMessageMedia",
  "editMessageReplyMarkup", "deleteMessage", "deleteMessages", "setMyCommands",
]);

const priorityRank: Record<TelegramMutationScope["priority"], number> = {
  publication: 0,
  admin: 1,
  urgent_maintenance: 2,
  background: 3,
};

const recordOf = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

const messageCost = (method: string, payload: unknown): number => {
  const record = recordOf(payload);
  const plural = record.message_ids ?? record.messageIds;
  if ((method === "forwardMessages" || method === "copyMessages" || method === "deleteMessages" || method === "sendMediaGroup") && Array.isArray(plural)) return Math.max(1, Math.min(100, plural.length));
  return 1;
};

const targetChat = (method: string, payload: unknown) => {
  const record = recordOf(payload);
  const value = method === "setMyCommands" ? undefined : record.chat_id ?? record.target_chat_id ?? record.chatId ?? record.targetChatId;
  return asNumericChatId(value);
};

const outputIds = (result: unknown): number[] => {
  const idOf = (value: unknown): number | undefined => {
    const id = recordOf(value).message_id;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  };
  if (Array.isArray(result)) return result.map(idOf).filter((id): id is number => id !== undefined);
  const id = idOf(result);
  return id === undefined ? [] : [id];
};

type QueueEntry = {
  sequence: number;
  method: string;
  payload: unknown;
  signal?: any;
  scope?: TelegramMutationScope;
  previous: (...args: any[]) => Promise<any>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  abortListener?: () => void;
  scopeAbortListener?: () => void;
};

export const createTelegramAdmission = (input: {
  repository: TelegramAdmissionRepository;
  cooldown: TelegramCooldown;
  clock: Clock;
  logger: Logger;
  queueChatId?: number;
  targetChatId?: number;
  onRealFloodWait?: (input: { at: number; notBefore: number; method: string; family: string }) => Promise<void> | void;
  onRelevantSuccess?: (input: { at: number; method: string; family: string; chatId: number }) => Promise<void> | void;
}) => {
  const queue: QueueEntry[] = [];
  let sequence = 0;
  let draining = false;
  let stopping = false;
  let wakeWaiter: (() => void) | undefined;
  let currentMethod: string | undefined;
  let activeRawEntry: QueueEntry | undefined;

  const wake = (): void => {
    const resolve = wakeWaiter;
    wakeWaiter = undefined;
    resolve?.();
  };

  const report = async (event: "telegram_real_flood_wait_observer_failed" | "telegram_relevant_success_observer_failed", error: unknown): Promise<void> => {
    input.logger.error(event, { error: error instanceof Error ? error.message : "unknown" });
  };

  const observeReal429 = async (method: string, scope: TelegramMutationScope | undefined, error: unknown, at: number): Promise<void> => {
    const normalized = classifyTelegramError(error, method);
    if (normalized.kind !== "rate_limited") return;
    const notBefore = input.cooldown.extendForRetryAfter(normalized.retryAfterSeconds, at);
    try { await input.onRealFloodWait?.({ at, notBefore, method, family: scope?.family ?? "control" }); }
    catch (observerError) { await report("telegram_real_flood_wait_observer_failed", observerError); }
  };

  const recordResult = (scope: TelegramMutationScope | undefined, result: TelegramRequestResult): void => {
    try { scope?.onResult?.(result); }
    catch (error) { input.logger.error("telegram_request_evidence_write_failed", { operationId: scope?.operationId, error: error instanceof Error ? error.message : "unknown" }); }
  };

  const removeEntry = (entry: QueueEntry): void => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (entry.abortListener !== undefined) entry.signal?.removeEventListener("abort", entry.abortListener);
    if (entry.scopeAbortListener !== undefined) entry.scope?.signal?.removeEventListener("abort", entry.scopeAbortListener);
  };

  const sortQueue = (): void => { queue.sort((left, right) => {
    const leftRank = left.scope === undefined ? 3 : priorityRank[left.scope.priority];
    const rightRank = right.scope === undefined ? 3 : priorityRank[right.scope.priority];
    return leftRank - rightRank || left.sequence - right.sequence;
  }); };

  const waitFor = async (milliseconds: number): Promise<void> => {
    const abort = new AbortController();
    let resolveWake!: () => void;
    const awakened = new Promise<void>((resolve) => { resolveWake = resolve; });
    wakeWaiter = resolveWake;
    try {
      await Promise.race([input.clock.sleep(milliseconds, abort.signal), awakened]);
    } finally {
      abort.abort();
      if (wakeWaiter === resolveWake) wakeWaiter = undefined;
    }
  };

  const processEntry = async (entry: QueueEntry): Promise<{ sent: false } | { sent: true; response: unknown }> => {
    const method = entry.method;
    const chatId = targetChat(method, entry.payload);
    const cost = messageCost(method, entry.payload);
    const scope = entry.scope;
    const now = input.clock.now();
    const notBefore = Math.max(input.repository.nextAllowedAt(chatId), input.cooldown.notBefore());
    if (stopping) throw new TelegramLocalDeferralError("shutdown", now, "Telegram admission stopped before dispatch");
    if (entry.signal?.aborted || scope?.signal?.aborted) {
      throw new TelegramLocalDeferralError("cancelled", notBefore, "Telegram mutation was cancelled before dispatch");
    }
    if (scope?.deadlineAt !== undefined && (now >= scope.deadlineAt || notBefore >= scope.deadlineAt)) {
      throw new TelegramLocalDeferralError("deadline", notBefore, "Telegram mutation cannot be admitted before its deadline");
    }
    if (notBefore > now) {
      await waitFor(notBefore - now);
      return { sent: false };
    }
    if (scope?.deadlineAt !== undefined && input.clock.now() >= scope.deadlineAt) {
      throw new TelegramLocalDeferralError("deadline", input.clock.now(), "Telegram mutation deadline elapsed while waiting for admission");
    }
    if (entry.signal?.aborted || scope?.signal?.aborted) throw new TelegramLocalDeferralError("cancelled", input.clock.now(), "Telegram mutation was cancelled before dispatch");

    scope?.beforeDispatch?.();
    input.repository.reserve(chatId, cost, input.clock.now());
    currentMethod = method;
    activeRawEntry = entry;
    try {
      const response = await entry.previous(method, entry.payload, entry.signal);
      const raw = recordOf(response);
      if (raw.ok === false) {
        const normalized = classifyTelegramError(response, method);
        const at = input.clock.now();
        await observeReal429(method, scope, response, at);
        recordResult(scope, { state: "rejected", errorKind: normalized.kind, result: response });
        return { sent: true, response };
      }
      const rawResult = raw.result;
      const ids = outputIds(rawResult);
      recordResult(scope, { state: "accepted", ...(ids.length === 0 ? {} : { knownOutputIds: ids }), result: rawResult });
      if (chatId !== undefined && (chatId === input.queueChatId || chatId === input.targetChatId)
        && ["publication", "renewal", "preparation", "cleanup"].includes(scope?.family ?? "")) {
        try { await input.onRelevantSuccess?.({ at: input.clock.now(), method, family: scope!.family, chatId }); }
        catch (error) { await report("telegram_relevant_success_observer_failed", error); }
      }
      return { sent: true, response };
    } catch (error) {
      const normalized = classifyTelegramError(error, method);
      const at = input.clock.now();
      if (normalized.kind === "rate_limited") await observeReal429(method, scope, error, at);
      const state = normalized.kind === "rate_limited" || normalized.kind === "source_missing" || normalized.kind === "permission_denied" || normalized.kind === "destination_unavailable" || normalized.kind === "unsupported_content" || normalized.kind === "invalid_content_or_entities" || normalized.kind === "content_protected" || normalized.kind === "telegram_age_limit" || normalized.kind === "unknown_permanent"
        ? "rejected" as const
        : "unknown" as const;
      recordResult(scope, { state, errorKind: normalized.kind, ...(normalized.knownOutputs === undefined ? {} : { knownOutputIds: normalized.knownOutputs }) });
      throw error;
    } finally {
      currentMethod = undefined;
      if (activeRawEntry === entry) activeRawEntry = undefined;
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        sortQueue();
        const entry = queue[0]!;
        if (entry.signal?.aborted || entry.scope?.signal?.aborted) {
          removeEntry(entry);
          entry.reject(new TelegramLocalDeferralError("cancelled", input.clock.now(), "Telegram mutation was cancelled before dispatch"));
          continue;
        }
        try {
          const result = await processEntry(entry);
          if (!queue.includes(entry)) continue;
          if (!result.sent) continue;
          removeEntry(entry);
          entry.resolve(result.response);
        } catch (error) {
          if (!queue.includes(entry)) continue;
          removeEntry(entry);
          entry.reject(error);
        }
      }
    } finally {
      draining = false;
      if (queue.length > 0) void drain();
    }
  };

  const transformer: Transformer = (previous, method, payload, signal) => {
    const methodName = String(method);
    if (!MUTATION_METHODS.has(methodName)) return previous(method, payload, signal);
    if (stopping) return Promise.reject(new TelegramLocalDeferralError("shutdown", input.clock.now(), "Telegram admission is shutting down")) as never;
    const scope = telegramMutationScope();
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        sequence: sequence++,
        method: methodName,
        payload,
        previous,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(scope === undefined ? {} : { scope }),
      };
      if (signal !== undefined) {
        entry.abortListener = () => wake();
        signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      if (scope?.signal !== undefined) {
        entry.scopeAbortListener = () => wake();
        scope.signal.addEventListener("abort", entry.scopeAbortListener, { once: true });
      }
      queue.push(entry);
      wake();
      void drain();
    });
  };

  const install = (api: Api): void => { api.config.use(transformer); };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    for (const entry of [...queue]) {
      if (entry === activeRawEntry) continue;
      removeEntry(entry);
      entry.reject(new TelegramLocalDeferralError("shutdown", input.clock.now(), "Telegram admission stopped before dispatch"));
    }
    wake();
  };
  return { transformer, install, stop, get pendingCount() { return queue.length; }, get inFlightMethod() { return currentMethod; } };
};

export type TelegramAdmission = ReturnType<typeof createTelegramAdmission>;

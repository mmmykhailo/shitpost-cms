import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatId } from "./types";

export type TelegramRequestResult = {
  state: "accepted" | "rejected" | "unknown";
  errorKind?: string;
  knownOutputIds?: readonly number[];
  result?: unknown;
};

export type TelegramMutationScope = {
  family: "publication" | "renewal" | "preparation" | "cleanup" | "admin_response" | "control" | "recovery";
  priority: "publication" | "admin" | "urgent_maintenance" | "background";
  operationId?: string;
  itemId?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
  stepKey?: string;
  beforeDispatch?: (method?: string, payload?: unknown) => void;
  onResult?: (result: TelegramRequestResult) => void;
};

const storage = new AsyncLocalStorage<TelegramMutationScope>();

export const withTelegramMutationScope = <T>(scope: TelegramMutationScope, work: () => Promise<T>): Promise<T> => storage.run(scope, work);
export const telegramMutationScope = (): TelegramMutationScope | undefined => storage.getStore();

export const asNumericChatId = (value: unknown): ChatId | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value as ChatId;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed as ChatId;
  }
  return undefined;
};

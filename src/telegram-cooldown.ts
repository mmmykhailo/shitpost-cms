import type { Api, Transformer } from "grammy";
import { classifyTelegramError } from "./errors";
import type { TelegramCooldownRepository } from "./db/telegram-cooldown-repository";
import type { Clock } from "./types";

const DEFAULT_FLOOD_WAIT_SECONDS = 60;

/** Durable shared state for outbound mutation requests made by this bot. */
export const createTelegramCooldown = (input: { repository: TelegramCooldownRepository; clock: Clock }) => {
  const notBefore = (): number => input.repository.readNotBefore();
  const remainingMs = (): number => Math.max(0, notBefore() - input.clock.now());
  const isActive = (): boolean => remainingMs() > 0;
  const extendForRetryAfter = (retryAfterSeconds?: number, receivedAt = input.clock.now()): number => {
    const usableSeconds = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : DEFAULT_FLOOD_WAIT_SECONDS;
    const deadline = Math.ceil(receivedAt + usableSeconds * 1_000);
    return input.repository.extendNotBefore(deadline, receivedAt);
  };

  return { notBefore, remainingMs, isActive, extendForRetryAfter };
};

export type TelegramCooldown = ReturnType<typeof createTelegramCooldown>;

// Polling and read-only identity/rights checks stay available during a wait.
// Callback answers are control acknowledgements and also remain available.
const MUTATION_METHODS = new Set([
  "sendMessage",
  "forwardMessage",
  "forwardMessages",
  "copyMessage",
  "copyMessages",
  "editMessageText",
  "editMessageCaption",
  "deleteMessage",
  "deleteMessages",
  "setMyCommands",
]);

export const installTelegramCooldownTransformer = (api: Api, cooldown: TelegramCooldown, clock: Clock): void => {
  const transformer: Transformer = async (previous, method, payload, signal) => {
    const methodName = String(method);
    if (!MUTATION_METHODS.has(methodName)) return previous(method, payload, signal);

    const now = clock.now();
    const deadline = cooldown.notBefore();
    if (deadline > now) {
      const retryAfter = Math.max(1, Math.ceil((deadline - now) / 1_000));
      return {
        ok: false,
        error_code: 429,
        description: `Too Many Requests: shared mutation cooldown active for ${retryAfter} seconds`,
        parameters: { retry_after: retryAfter },
      } as never;
    }

    try {
      const response = await previous(method, payload, signal);
      if (!response.ok && response.error_code === 429) cooldown.extendForRetryAfter(response.parameters?.retry_after, clock.now());
      return response;
    } catch (error) {
      const normalized = classifyTelegramError(error, methodName);
      if (normalized.kind === "rate_limited") cooldown.extendForRetryAfter(normalized.retryAfterSeconds, clock.now());
      throw error;
    }
  };
  api.config.use(transformer);
};

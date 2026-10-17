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

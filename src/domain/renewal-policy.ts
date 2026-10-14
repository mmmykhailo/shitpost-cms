export const RENEWAL_START_AGE_MS = 36 * 60 * 60_000;
export const RENEWAL_IDLE_SCAN_MS = 60_000;
export const RENEWAL_ITEM_RETRY_MS = 60_000;
export const RENEWAL_MESSAGES_PER_MINUTE = 20;
export const RENEWAL_MAX_ATTEMPTS_PER_CYCLE = 100;
export const RENEWAL_MAX_CLEANUPS_PER_CYCLE = 10;

export const renewalPacingCostMs = (memberCount: number): number => {
  if (!Number.isSafeInteger(memberCount) || memberCount < 0) throw new RangeError("Renewal member count must be a non-negative safe integer");
  return Math.ceil(Math.max(1, memberCount) * 60_000 / RENEWAL_MESSAGES_PER_MINUTE);
};

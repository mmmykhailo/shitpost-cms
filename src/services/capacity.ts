import { RENEWAL_START_AGE_MS, renewalPacingCostMs } from "../domain/renewal-policy";

export type RenewalCapacitySource = {
  itemId: number;
  logicalSequence?: number;
  physicalCreatedAt: number;
  memberCount: number;
  maintenanceStatus?: string;
  maintenanceRetryNotBefore?: number;
  queueStatus?: string;
};

export type RenewalCapacityInput = {
  now: number;
  sources: readonly RenewalCapacitySource[];
  cooldownUntil?: number;
  startAgeMs?: number;
  deadlineAgeMs?: number;
};

export type RenewalCapacity = {
  safe: boolean;
  projectedFirstMiss?: { itemId: number; deadlineAt: number; projectedAt: number };
  blockedItemIds?: number[];
  availableAt: number;
  totalMessages: number;
};

const EXCLUDED_QUEUE_STATUSES = new Set(["done", "deleted", "deleted_external", "collecting", "publishing", "published_cleanup_pending"]);

/** Projects the same per-message schedule used by the renewal worker. */
export const calculateRenewalCapacity = (input: RenewalCapacityInput): RenewalCapacity => {
  const startAgeMs = input.startAgeMs ?? RENEWAL_START_AGE_MS;
  const deadlineAgeMs = input.deadlineAgeMs ?? 46 * 60 * 60_000;
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new RangeError("Capacity time must be a non-negative safe integer");
  if (!Number.isSafeInteger(startAgeMs) || startAgeMs < 0 || !Number.isSafeInteger(deadlineAgeMs) || deadlineAgeMs < 0) throw new RangeError("Capacity age limits must be non-negative safe integers");

  const dueBlockedIds: number[] = [];
  const candidates = input.sources.filter((source) => {
    if (EXCLUDED_QUEUE_STATUSES.has(source.queueStatus ?? "")) return false;
    if (source.maintenanceStatus === "uncertain_renewal") {
      if (source.physicalCreatedAt + startAgeMs <= input.now) dueBlockedIds.push(source.itemId);
      return false;
    }
    return source.maintenanceStatus === undefined || source.maintenanceStatus === "idle";
  }).map((source) => ({
    ...source,
    readyAt: Math.max(source.physicalCreatedAt + startAgeMs, source.maintenanceRetryNotBefore ?? input.now),
  }));

  let cursor = Math.max(input.now, input.cooldownUntil ?? input.now);
  let totalMessages = 0;
  let projectedFirstMiss: RenewalCapacity["projectedFirstMiss"];
  const pending = [...candidates];

  while (pending.length > 0) {
    let ready = pending.filter((source) => source.readyAt <= cursor);
    if (ready.length === 0) {
      cursor = Math.min(...pending.map((source) => source.readyAt));
      ready = pending.filter((source) => source.readyAt <= cursor);
    }
    ready.sort((left, right) => left.physicalCreatedAt - right.physicalCreatedAt || (left.logicalSequence ?? left.itemId) - (right.logicalSequence ?? right.itemId));
    const next = ready[0]!;
    pending.splice(pending.indexOf(next), 1);

    const finishAt = cursor + renewalPacingCostMs(next.memberCount);
    const deadlineAt = next.physicalCreatedAt + deadlineAgeMs;
    totalMessages += next.memberCount;
    if (finishAt > deadlineAt && projectedFirstMiss === undefined) projectedFirstMiss = { itemId: next.itemId, deadlineAt, projectedAt: finishAt };
    cursor = finishAt;
  }

  const blockedItemIds = dueBlockedIds.length > 0 ? [...new Set(dueBlockedIds)].sort((left, right) => left - right) : undefined;
  const result: RenewalCapacity = {
    safe: projectedFirstMiss === undefined && blockedItemIds === undefined,
    availableAt: cursor,
    totalMessages,
  };
  if (projectedFirstMiss !== undefined) result.projectedFirstMiss = projectedFirstMiss;
  if (blockedItemIds !== undefined) result.blockedItemIds = blockedItemIds;
  return result;
};

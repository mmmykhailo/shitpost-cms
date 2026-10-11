export type RenewalCapacityInput = {
  now: number;
  sources: readonly { itemId: number; physicalCreatedAt: number; memberCount: number }[];
  retryAfterUntil?: number;
  messagesPerMinute?: number;
  deadlineAgeMs?: number;
};

export type RenewalCapacity = {
  safe: boolean;
  projectedFirstMiss?: { itemId: number; deadlineAt: number; projectedAt: number };
  availableAt: number;
  totalMessages: number;
};

/** Conservative FIFO capacity projection for the pre-48-hour renewal gate. */
export const calculateRenewalCapacity = (input: RenewalCapacityInput): RenewalCapacity => {
  const throughput = Math.max(1, input.messagesPerMinute ?? 20);
  const deadlineAgeMs = input.deadlineAgeMs ?? 46 * 60 * 60_000;
  let cursor = Math.max(input.now, input.retryAfterUntil ?? input.now);
  let totalMessages = 0;
  let firstMiss: RenewalCapacity["projectedFirstMiss"];
  const sources = [...input.sources].sort((left, right) => (left.physicalCreatedAt - right.physicalCreatedAt) || (left.itemId - right.itemId));
  for (const source of sources) {
    const duration = Math.max(1, Math.ceil(source.memberCount / throughput) * 60_000);
    const projectedAt = cursor + duration;
    const deadlineAt = source.physicalCreatedAt + deadlineAgeMs;
    totalMessages += source.memberCount;
    if (firstMiss === undefined && projectedAt > deadlineAt) firstMiss = { itemId: source.itemId, deadlineAt, projectedAt };
    cursor = projectedAt;
  }
  const result: RenewalCapacity = { safe: firstMiss === undefined, availableAt: cursor, totalMessages };
  if (firstMiss !== undefined) result.projectedFirstMiss = firstMiss;
  return result;
};

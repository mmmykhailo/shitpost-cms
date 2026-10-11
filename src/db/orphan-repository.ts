import type { AppDatabase } from "./database";

export type OrphanSource = {
  itemId: number;
  sourceGeneration: number;
  chatId: number;
  messageId: number;
  reason: string;
  firstAttemptAt: number;
  lastAttemptAt: number;
  attemptCount: number;
  nextAttemptAt?: number;
  terminalReason?: string;
};

export type OrphanRepository = ReturnType<typeof createOrphanRepository>;

export const createOrphanRepository = (database: AppDatabase) => {
  const due = (now: number, limit = 500): OrphanSource[] => {
    const rows = database.raw.query("SELECT item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, attempt_count, next_attempt_at, terminal_reason FROM orphaned_sources WHERE resolved_at IS NULL AND terminal_reason IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY first_attempt_at LIMIT ?").all(now, limit) as Array<{ item_id: number; source_generation: number; chat_id: number; telegram_message_id: number; reason: string; first_attempt_at: number; last_attempt_at: number; attempt_count: number; next_attempt_at: number | null; terminal_reason: string | null }>;
    return rows.map((row) => {
      const result: OrphanSource = { itemId: row.item_id, sourceGeneration: row.source_generation, chatId: row.chat_id, messageId: row.telegram_message_id, reason: row.reason, firstAttemptAt: row.first_attempt_at, lastAttemptAt: row.last_attempt_at, attemptCount: row.attempt_count };
      if (row.next_attempt_at !== null) result.nextAttemptAt = row.next_attempt_at;
      if (row.terminal_reason !== null) result.terminalReason = row.terminal_reason;
      return result;
    });
  };

  const markAttempt = (orphan: OrphanSource, now: number, nextAttemptAt: number): void => {
    database.raw.query("UPDATE orphaned_sources SET last_attempt_at = ?, attempt_count = attempt_count + 1, next_attempt_at = ? WHERE item_id = ? AND source_generation = ? AND chat_id = ? AND telegram_message_id = ? AND resolved_at IS NULL AND terminal_reason IS NULL").run(now, nextAttemptAt, orphan.itemId, orphan.sourceGeneration, orphan.chatId, orphan.messageId);
  };

  const resolve = (orphan: OrphanSource, now: number): void => {
    database.raw.query("UPDATE orphaned_sources SET resolved_at = ?, last_attempt_at = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL WHERE item_id = ? AND source_generation = ? AND chat_id = ? AND telegram_message_id = ? AND resolved_at IS NULL").run(now, now, orphan.itemId, orphan.sourceGeneration, orphan.chatId, orphan.messageId);
  };

  const markTerminal = (orphan: OrphanSource, now: number, reason: string): void => {
    database.raw.query("UPDATE orphaned_sources SET terminal_reason = ?, last_attempt_at = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL WHERE item_id = ? AND source_generation = ? AND chat_id = ? AND telegram_message_id = ? AND resolved_at IS NULL").run(reason, now, orphan.itemId, orphan.sourceGeneration, orphan.chatId, orphan.messageId);
  };

  const counts = (): { unresolved: number; terminal: number; oldestAgeMs?: number } => {
    const row = database.raw.query("SELECT SUM(CASE WHEN resolved_at IS NULL AND terminal_reason IS NULL THEN 1 ELSE 0 END) AS unresolved, SUM(CASE WHEN terminal_reason IS NOT NULL AND resolved_at IS NULL THEN 1 ELSE 0 END) AS terminal, MIN(CASE WHEN resolved_at IS NULL THEN first_attempt_at ELSE NULL END) AS oldest FROM orphaned_sources").get() as { unresolved: number | null; terminal: number | null; oldest: number | null };
    const result = { unresolved: row.unresolved ?? 0, terminal: row.terminal ?? 0 } as { unresolved: number; terminal: number; oldestAgeMs?: number };
    if (row.oldest !== null) result.oldestAgeMs = Date.now() - row.oldest;
    return result;
  };

  return { due, markAttempt, resolve, markTerminal, counts };
};

import type { AppDatabase } from "./database";
import { parseStoredMessageSnapshot } from "../domain/validation";
import type { ChatId, MessageId, PendingQueueUpdateState, StoredMessageSnapshot } from "../types";

export type PendingQueueUpdateRecord = {
  queueChatId: ChatId;
  telegramMessageId: MessageId;
  mediaGroupId?: string;
  snapshot: StoredMessageSnapshot;
  receivedAt: number;
  processAfter: number;
  state: PendingQueueUpdateState;
  candidateOperationId?: string;
  lastError?: string;
};

type PendingRow = {
  queue_chat_id: number;
  telegram_message_id: number;
  media_group_id: string | null;
  snapshot_json: string;
  received_at: number;
  process_after: number;
  state: PendingQueueUpdateState;
  candidate_operation_id: string | null;
  last_error: string | null;
};

const rowToRecord = (row: PendingRow): PendingQueueUpdateRecord => {
  const result: PendingQueueUpdateRecord = {
    queueChatId: row.queue_chat_id as ChatId,
    telegramMessageId: row.telegram_message_id as MessageId,
    snapshot: parseStoredMessageSnapshot(row.snapshot_json),
    receivedAt: row.received_at,
    processAfter: row.process_after,
    state: row.state,
  };
  if (row.media_group_id !== null) result.mediaGroupId = row.media_group_id;
  if (row.candidate_operation_id !== null) result.candidateOperationId = row.candidate_operation_id;
  if (row.last_error !== null) result.lastError = row.last_error;
  return result;
};

export type PendingUpdateRepository = ReturnType<typeof createPendingUpdateRepository>;

export const createPendingUpdateRepository = (database: AppDatabase) => {
  const find = (chatId: number, messageId: number): PendingQueueUpdateRecord | undefined => {
    const row = database.raw.query("SELECT * FROM pending_queue_updates WHERE queue_chat_id = ? AND telegram_message_id = ?").get(chatId, messageId) as PendingRow | null;
    return row ? rowToRecord(row) : undefined;
  };

  const upsert = (snapshot: StoredMessageSnapshot, receivedAt: number, processAfter = receivedAt + 2_000): PendingQueueUpdateRecord => {
    database.raw.query(`
      INSERT INTO pending_queue_updates (queue_chat_id, telegram_message_id, media_group_id, snapshot_json, received_at, process_after, state, candidate_operation_id, last_error)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)
      ON CONFLICT(queue_chat_id, telegram_message_id) DO UPDATE SET
        media_group_id = excluded.media_group_id,
        snapshot_json = excluded.snapshot_json,
        received_at = MIN(pending_queue_updates.received_at, excluded.received_at),
        process_after = excluded.process_after,
        state = CASE WHEN pending_queue_updates.state IN ('ingested','consumed_generated','discarded') THEN 'pending' ELSE pending_queue_updates.state END,
        last_error = NULL
    `).run(snapshot.chatId, snapshot.messageId, snapshot.mediaGroupId ?? null, JSON.stringify(snapshot), receivedAt, processAfter);
    const result = find(snapshot.chatId, snapshot.messageId);
    if (!result) throw new Error("Pending update disappeared after upsert");
    return result;
  };

  const due = (now: number, limit = 500): PendingQueueUpdateRecord[] => {
    const rows = database.raw.query("SELECT * FROM pending_queue_updates WHERE state IN ('pending','quarantined_renewal_candidate') AND process_after <= ? ORDER BY process_after, received_at, telegram_message_id LIMIT ?").all(now, limit) as PendingRow[];
    return rows.map(rowToRecord);
  };

  const markState = (chatId: number, messageId: number, state: PendingQueueUpdateState, now: number, candidateOperationId?: string, lastError?: string): boolean => {
    const result = database.raw.query("UPDATE pending_queue_updates SET state = ?, candidate_operation_id = ?, last_error = ? WHERE queue_chat_id = ? AND telegram_message_id = ? AND state IN ('pending','quarantined_renewal_candidate')").run(state, candidateOperationId ?? null, lastError ?? null, chatId, messageId);
    return Number(result.changes) === 1;
  };

  const countByState = (): Record<string, number> => {
    const result: Record<string, number> = {};
    const rows = database.raw.query("SELECT state, COUNT(*) AS count FROM pending_queue_updates GROUP BY state").all() as Array<{ state: string; count: number }>;
    for (const row of rows) result[row.state] = row.count;
    return result;
  };

  const listByState = (state: PendingQueueUpdateState, limit = 50, offset = 0): PendingQueueUpdateRecord[] => {
    const rows = database.raw.query("SELECT * FROM pending_queue_updates WHERE state = ? ORDER BY received_at, telegram_message_id LIMIT ? OFFSET ?").all(state, limit, offset) as PendingRow[];
    return rows.map(rowToRecord);
  };

  const purge = (before: number): void => {
    database.raw.query("DELETE FROM pending_queue_updates WHERE state IN ('consumed_generated','ingested','discarded') AND received_at < ?").run(before);
  };

  return { find, upsert, due, markState, countByState, listByState, purge };
};

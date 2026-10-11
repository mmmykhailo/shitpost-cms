import type { AppDatabase } from "./database";
import { parseStoredMessageSnapshot, validateOrderedMessageIds } from "../domain/validation";
import type { MessageId, RecoveryPhase, StoredMessageSnapshot } from "../types";

export type RecoverySessionRecord = {
  id: string;
  phase: RecoveryPhase;
  sourceIds: MessageId[];
  itemId?: number;
  bootId: string;
  leaseExpiresAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

export type RecoveryPreviewRecord = {
  sessionId: string;
  sourceMessageId: MessageId;
  previewChatId?: number;
  previewMessageId?: MessageId;
  ordinal: number;
  snapshot?: StoredMessageSnapshot;
  createdAt: number;
};

export type RecoveryRepository = ReturnType<typeof createRecoveryRepository>;

export const createRecoveryRepository = (database: AppDatabase) => {
  const createSession = (id: string, sourceIds: readonly MessageId[], bootId: string, now: number, leaseMs = 300_000): void => {
    const validatedSourceIds = validateOrderedMessageIds(sourceIds, "recovery.sourceIds");
    database.raw.query("INSERT INTO recovery_sessions (id, phase, source_ids_json, item_id, boot_id, lease_expires_at, last_error, created_at, updated_at) VALUES (?, 'claimed', ?, NULL, ?, ?, NULL, ?, ?)").run(id, JSON.stringify(validatedSourceIds), bootId, now + leaseMs, now, now);
  };

  const setPhase = (id: string, phase: RecoveryPhase, now: number, error?: string): void => {
    database.raw.query("UPDATE recovery_sessions SET phase = ?, last_error = ?, updated_at = ? WHERE id = ?").run(phase, error ?? null, now, id);
  };

  const addPreviewPending = (sessionId: string, sourceMessageId: number, ordinal: number, now: number): void => {
    database.raw.query("INSERT OR IGNORE INTO recovery_previews (session_id, source_message_id, preview_chat_id, preview_message_id, ordinal, snapshot_json, created_at) VALUES (?, ?, NULL, NULL, ?, NULL, ?)").run(sessionId, sourceMessageId, ordinal, now);
  };

  const recordPreview = (sessionId: string, sourceMessageId: number, previewChatId: number, previewMessageId: number, snapshot: StoredMessageSnapshot, now: number): void => {
    const result = database.raw.query("UPDATE recovery_previews SET preview_chat_id = ?, preview_message_id = ?, snapshot_json = ? WHERE session_id = ? AND source_message_id = ? AND preview_chat_id IS NULL").run(previewChatId, previewMessageId, JSON.stringify(snapshot), sessionId, sourceMessageId);
    if (Number(result.changes) !== 1) throw new Error("Recovery preview row was not pending");
    setPhase(sessionId, "previews_recorded", now);
  };

  const linkItem = (sessionId: string, itemId: number, now: number): void => {
    const result = database.raw.query("UPDATE recovery_sessions SET item_id = ?, phase = 'item_inserted', updated_at = ? WHERE id = ? AND phase IN ('previews_recorded','preview_pending')").run(itemId, now, sessionId);
    if (Number(result.changes) !== 1) throw new Error("Recovery session item link conflict");
  };

  const session = (id: string): RecoverySessionRecord | undefined => {
    const row = database.raw.query("SELECT * FROM recovery_sessions WHERE id = ?").get(id) as { id: string; phase: RecoveryPhase; source_ids_json: string; item_id: number | null; boot_id: string; lease_expires_at: number; last_error: string | null; created_at: number; updated_at: number } | null;
    if (!row) return undefined;
    const result: RecoverySessionRecord = { id: row.id, phase: row.phase, sourceIds: validateOrderedMessageIds(JSON.parse(row.source_ids_json) as unknown, "recovery.sourceIds"), bootId: row.boot_id, leaseExpiresAt: row.lease_expires_at, createdAt: row.created_at, updatedAt: row.updated_at };
    if (row.item_id !== null) result.itemId = row.item_id;
    if (row.last_error !== null) result.lastError = row.last_error;
    return result;
  };

  const previews = (sessionId: string): RecoveryPreviewRecord[] => {
    const rows = database.raw.query("SELECT * FROM recovery_previews WHERE session_id = ? ORDER BY ordinal").all(sessionId) as Array<{ session_id: string; source_message_id: number; preview_chat_id: number | null; preview_message_id: number | null; ordinal: number; snapshot_json: string | null; created_at: number }>;
    return rows.map((row) => {
      const result: RecoveryPreviewRecord = { sessionId: row.session_id, sourceMessageId: row.source_message_id as MessageId, ordinal: row.ordinal, createdAt: row.created_at };
      if (row.preview_chat_id !== null) result.previewChatId = row.preview_chat_id;
      if (row.preview_message_id !== null) result.previewMessageId = row.preview_message_id as MessageId;
      if (row.snapshot_json !== null) result.snapshot = parseStoredMessageSnapshot(row.snapshot_json);
      return result;
    });
  };

  const listRecoverable = (now: number): RecoverySessionRecord[] => {
    const rows = database.raw.query("SELECT id FROM recovery_sessions WHERE phase NOT IN ('completed','failed') AND lease_expires_at <= ? ORDER BY updated_at").all(now) as Array<{ id: string }>;
    return rows.map((row) => session(row.id)).filter((value): value is RecoverySessionRecord => value !== undefined);
  };

  const markPreviewCleanupPending = (id: string, now: number, error: string): void => setPhase(id, "preview_cleanup_pending", now, error);
  const complete = (id: string, now: number): void => database.transaction(() => {
    setPhase(id, "completed", now);
    database.raw.query("DELETE FROM recovery_previews WHERE session_id = ?").run(id);
  });

  return { createSession, setPhase, addPreviewPending, recordPreview, linkItem, session, previews, listRecoverable, markPreviewCleanupPending, complete };
};

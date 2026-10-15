import type { AppDatabase } from "./database";
import { assertStatusTransition, isSourceBearing, type QueueItemRecord } from "../domain/queue-item";
import { validateSlotCount } from "../domain/schedule";
import { validateOrderedMessageIds, validatePublicationContract, validateSemanticOrigin, validateStoredMessageSnapshot } from "../domain/validation";
import { InvalidTelegramOutputError, OperationConflictError } from "../errors";
import type { MaintenanceStatus, MessageId, OperationGuard, OperationOutputRole, OperationPhase, OperationState, PublicationContract, QueueItemStatus, SemanticOrigin, StoredMessageSnapshot } from "../types";

type QueueRow = {
  id: number;
  logical_sequence: number;
  queue_chat_id: number;
  media_group_id: string | null;
  first_message_id: number;
  content_type: StoredMessageSnapshot["contentType"];
  origin_json: string;
  status: QueueItemStatus;
  maintenance_status: MaintenanceStatus;
  maintenance_operation_id: string | null;
  maintenance_retry_not_before: number | null;
  content_version: number;
  source_generation: number;
  attempts: number;
  enqueued_at: number;
  physical_created_at: number;
  last_renewed_at: number | null;
  retry_not_before: number | null;
  last_error_code: string | null;
  last_error: string | null;
  destination_message_ids_json: string | null;
  claimed_operation_id: string | null;
  claimed_at: number | null;
  album_quiet_deadline: number | null;
  album_max_deadline: number | null;
  published_at: number | null;
  completed_at: number | null;
};

type QueueMessageRow = {
  item_id: number;
  source_generation: number;
  queue_chat_id: number;
  telegram_message_id: number;
  ordinal: number;
  telegram_date: number;
  edit_date: number | null;
  snapshot_json: string;
};

export type QueueMessageRecord = {
  itemId: number;
  sourceGeneration: number;
  queueChatId: number;
  telegramMessageId: MessageId;
  ordinal: number;
  telegramDate: number;
  editDate?: number;
  snapshot: StoredMessageSnapshot;
};

export type ClaimedItem = {
  item: QueueItemRecord;
  operationId: string;
  capturedContentVersion: number;
  capturedSourceGeneration: number;
};

const optionalNumber = (value: number | null): number | undefined => value === null ? undefined : value;
const optionalString = (value: string | null): string | undefined => value === null ? undefined : value;

const rowToItem = (row: QueueRow): QueueItemRecord => {
  const item: QueueItemRecord = {
    id: row.id,
    logicalSequence: row.logical_sequence,
    queueChatId: row.queue_chat_id,
    firstMessageId: row.first_message_id as MessageId,
    contentType: row.content_type,
    origin: validateSemanticOrigin(JSON.parse(row.origin_json) as unknown),
    status: row.status,
    maintenanceStatus: row.maintenance_status,
    contentVersion: row.content_version,
    sourceGeneration: row.source_generation,
    attempts: row.attempts,
    enqueuedAt: row.enqueued_at,
    physicalCreatedAt: row.physical_created_at,
    destinationMessageIds: row.destination_message_ids_json ? validateOrderedMessageIds(JSON.parse(row.destination_message_ids_json) as unknown, "destinationMessageIds") : [],
  };
  if (row.media_group_id !== null) item.mediaGroupId = row.media_group_id;
  for (const [key, value] of [
    ["lastRenewedAt", optionalNumber(row.last_renewed_at)],
    ["retryNotBefore", optionalNumber(row.retry_not_before)],
    ["claimedAt", optionalNumber(row.claimed_at)],
    ["albumQuietDeadline", optionalNumber(row.album_quiet_deadline)],
    ["albumMaxDeadline", optionalNumber(row.album_max_deadline)],
    ["publishedAt", optionalNumber(row.published_at)],
    ["completedAt", optionalNumber(row.completed_at)],
    ["maintenanceRetryNotBefore", optionalNumber(row.maintenance_retry_not_before)],
  ] as const) if (value !== undefined) item[key as keyof QueueItemRecord] = value as never;
  const stringFields = [
    ["lastErrorCode", optionalString(row.last_error_code)],
    ["lastError", optionalString(row.last_error)],
    ["claimedOperationId", optionalString(row.claimed_operation_id)],
  ] as const;
  for (const [key, value] of stringFields) if (value !== undefined) item[key as keyof QueueItemRecord] = value as never;
  const maintenanceOperationId = optionalString(row.maintenance_operation_id);
  if (maintenanceOperationId !== undefined) item.maintenanceOperationId = maintenanceOperationId;
  return item;
};

const messageRowToRecord = (row: QueueMessageRow): QueueMessageRecord => {
  const result: QueueMessageRecord = {
    itemId: row.item_id,
    sourceGeneration: row.source_generation,
    queueChatId: row.queue_chat_id,
    telegramMessageId: row.telegram_message_id as MessageId,
    ordinal: row.ordinal,
    telegramDate: row.telegram_date,
    snapshot: validateStoredMessageSnapshot(JSON.parse(row.snapshot_json) as unknown),
  };
  if (row.edit_date !== null) result.editDate = row.edit_date;
  return result;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const originKey = (origin: SemanticOrigin): string => stableJson(origin);

export type QueueRepository = ReturnType<typeof createQueueRepository>;

export const createQueueRepository = (database: AppDatabase, options: { bootId?: string } = {}) => {
  let currentBootId = options.bootId;
  const conflict = (message: string): OperationConflictError => new OperationConflictError(message);
  const setBootId = (bootId: string): void => { currentBootId = bootId; };
  const heartbeatOperations = (now: number, bootId = currentBootId): number => {
    if (bootId === undefined) return 0;
    return Number(database.raw.query("UPDATE operations SET lease_expires_at = ?, updated_at = ? WHERE boot_id = ? AND state IN ('running','outputs_recorded','cleanup_pending')").run(now + 300_000, now, bootId).changes);
  };
  const findItemById = (id: number): QueueItemRecord | undefined => {
    const row = database.raw.query("SELECT * FROM queue_items WHERE id = ?").get(id) as QueueRow | null;
    return row ? rowToItem(row) : undefined;
  };

  const findBySource = (queueChatId: number, messageId: number): QueueItemRecord | undefined => {
    const row = database.raw.query("SELECT qi.* FROM queue_items qi JOIN queue_messages qm ON qm.item_id = qi.id WHERE qm.queue_chat_id = ? AND qm.telegram_message_id = ? AND qm.source_generation = qi.source_generation").get(queueChatId, messageId) as QueueRow | null;
    return row ? rowToItem(row) : undefined;
  };

  const findCollectingAlbum = (queueChatId: number, mediaGroupId: string): QueueItemRecord | undefined => {
    const row = database.raw.query("SELECT * FROM queue_items WHERE queue_chat_id = ? AND media_group_id = ? AND status = 'collecting' LIMIT 1").get(queueChatId, mediaGroupId) as QueueRow | null;
    return row ? rowToItem(row) : undefined;
  };

  const findAlbum = (queueChatId: number, mediaGroupId: string): QueueItemRecord | undefined => {
    const row = database.raw.query("SELECT * FROM queue_items WHERE queue_chat_id = ? AND media_group_id = ? AND status NOT IN ('done','deleted','deleted_external') ORDER BY logical_sequence LIMIT 1").get(queueChatId, mediaGroupId) as QueueRow | null;
    return row ? rowToItem(row) : undefined;
  };

  const getMessages = (itemId: number, generation?: number): QueueMessageRecord[] => {
    const item = findItemById(itemId);
    const selectedGeneration = generation ?? item?.sourceGeneration;
    if (selectedGeneration === undefined) return [];
    const rows = database.raw.query("SELECT * FROM queue_messages WHERE item_id = ? AND source_generation = ? ORDER BY ordinal, telegram_message_id").all(itemId, selectedGeneration) as QueueMessageRow[];
    return rows.map(messageRowToRecord);
  };

  const insertSnapshot = (itemId: number, generation: number, snapshot: StoredMessageSnapshot): void => {
    database.raw.query(`INSERT INTO queue_messages (item_id, source_generation, queue_chat_id, telegram_message_id, ordinal, telegram_date, edit_date, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      itemId,
      generation,
      snapshot.chatId,
      snapshot.messageId,
      snapshot.ordinal,
      snapshot.telegramDate,
      snapshot.editDate ?? null,
      JSON.stringify(snapshot),
    );
  };

  const observeQueueSnapshot = (snapshot: StoredMessageSnapshot, now: number): { item: QueueItemRecord; inserted: boolean } => {
    snapshot = validateStoredMessageSnapshot(snapshot);
    return database.transaction(() => {
      const existing = findBySource(snapshot.chatId, snapshot.messageId);
      if (existing) {
        const currentSnapshot = getMessages(existing.id).find((message) => message.telegramMessageId === snapshot.messageId)?.snapshot;
        if (currentSnapshot && stableJson({ ...currentSnapshot, editDate: undefined }) !== stableJson({ ...snapshot, editDate: undefined })) {
          throw new Error(`Conflicting duplicate update for ${snapshot.chatId}:${snapshot.messageId}`);
        }
        return { item: existing, inserted: false };
      }
      const isAlbum = snapshot.mediaGroupId !== undefined;
      const lastSequence = database.raw.query("SELECT COALESCE(MAX(logical_sequence), 0) AS value FROM queue_items").get() as { value: number };
      const status: QueueItemStatus = isAlbum ? "collecting" : "queued";
      const quietDeadline = isAlbum ? now + 2_000 : null;
      const maxDeadline = isAlbum ? now + 10_000 : null;
      const result = database.raw.query(`INSERT INTO queue_items (logical_sequence, queue_chat_id, media_group_id, first_message_id, content_type, origin_json, status, enqueued_at, physical_created_at, album_quiet_deadline, album_max_deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        lastSequence.value + 1,
        snapshot.chatId,
        snapshot.mediaGroupId ?? null,
        snapshot.messageId,
        snapshot.contentType,
        JSON.stringify(snapshot.origin),
        status,
        now,
        snapshot.telegramDate,
        quietDeadline,
        maxDeadline,
      );
      const itemId = Number(result.lastInsertRowid);
      insertSnapshot(itemId, 0, snapshot);
      const item = findItemById(itemId);
      if (!item) throw new Error("Queue item disappeared after insert");
      return { item, inserted: true };
    });
  };

  const addAlbumMember = (itemId: number, snapshot: StoredMessageSnapshot, now: number): QueueItemRecord => {
    snapshot = validateStoredMessageSnapshot(snapshot);
    return database.transaction(() => {
      const item = findItemById(itemId);
      if (!item || item.status !== "collecting") throw new Error("Album is no longer collecting");
      if (item.mediaGroupId !== snapshot.mediaGroupId) throw new Error("Album media group does not match");
      if (!findBySource(snapshot.chatId, snapshot.messageId)) insertSnapshot(itemId, item.sourceGeneration, snapshot);
      database.raw.query("UPDATE queue_items SET album_quiet_deadline = MIN(COALESCE(album_max_deadline, ?), ?) WHERE id = ? AND status = 'collecting'").run(now + 10_000, now + 2_000, itemId);
      const updated = findItemById(itemId);
      if (!updated) throw new Error("Album disappeared after member insert");
      return updated;
    });
  };

  const addLateAlbumMember = (itemId: number, snapshot: StoredMessageSnapshot): QueueItemRecord => {
    snapshot = validateStoredMessageSnapshot(snapshot);
    return database.transaction(() => {
    const item = findItemById(itemId);
    if (!item || item.mediaGroupId !== snapshot.mediaGroupId || !isSourceBearing(item.status)) throw new Error("Album cannot accept a late member");
    if (!findBySource(snapshot.chatId, snapshot.messageId)) insertSnapshot(itemId, item.sourceGeneration, snapshot);
    database.raw.query("UPDATE queue_items SET status = 'needs_review', content_version = content_version + 1 WHERE id = ?").run(itemId);
    const updated = findItemById(itemId);
    if (!updated) throw new Error("Album disappeared after late member insert");
    return updated;
    });
  };

  const insertRecoveredSnapshots = (snapshots: readonly StoredMessageSnapshot[], now: number): QueueItemRecord => database.transaction(() => {
    snapshots = snapshots.map((snapshot) => validateStoredMessageSnapshot(snapshot));
    if (snapshots.length < 1 || snapshots.length > 10) throw new Error("Recovered item must contain 1–10 snapshots");
    const first = snapshots[0]!;
    if (snapshots.some((snapshot, ordinal) => snapshot.chatId !== first.chatId || snapshot.ordinal !== ordinal || originKey(snapshot.origin) !== originKey(first.origin))) throw new Error("Recovered snapshots are not a compatible ordered album");
    for (const snapshot of snapshots) if (findBySource(snapshot.chatId, snapshot.messageId)) throw new Error(`Queue message ${snapshot.messageId} is already known`);
    const lastSequence = database.raw.query("SELECT COALESCE(MAX(logical_sequence), 0) AS value FROM queue_items").get() as { value: number };
    const mediaGroupId = snapshots.length > 1 ? first.mediaGroupId ?? `recovery:${first.messageId}` : undefined;
    const result = database.raw.query("INSERT INTO queue_items (logical_sequence, queue_chat_id, media_group_id, first_message_id, content_type, origin_json, status, enqueued_at, physical_created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)").run(lastSequence.value + 1, first.chatId, mediaGroupId ?? null, first.messageId, first.contentType, JSON.stringify(first.origin), now, first.telegramDate);
    const itemId = Number(result.lastInsertRowid);
    for (const snapshot of snapshots) insertSnapshot(itemId, 0, snapshot);
    const item = findItemById(itemId);
    if (!item) throw new Error("Recovered queue item disappeared after insert");
    return item;
  });

  const finalizeAlbums = (now: number): QueueItemRecord[] => database.transaction(() => {
    const rows = database.raw.query("SELECT * FROM queue_items WHERE status = 'collecting' AND (album_quiet_deadline <= ? OR album_max_deadline <= ?)").all(now, now) as QueueRow[];
    const finalized: QueueItemRecord[] = [];
    for (const row of rows) {
      const messages = getMessages(row.id).sort((a, b) => a.telegramMessageId - b.telegramMessageId);
      let status: QueueItemStatus = "queued";
      if (messages.length < 2 || messages.length > 10) status = "needs_review";
      if (messages.some((message) => originKey(message.snapshot.origin) !== originKey(messages[0]!.snapshot.origin))) status = "needs_review";
      for (const [ordinal, message] of messages.entries()) {
        database.raw.query("UPDATE queue_messages SET ordinal = ? WHERE item_id = ? AND source_generation = ? AND telegram_message_id = ?").run(ordinal, row.id, row.source_generation, message.telegramMessageId);
      }
      database.raw.query("UPDATE queue_items SET status = ?, album_quiet_deadline = NULL, album_max_deadline = NULL WHERE id = ? AND status = 'collecting'").run(status, row.id);
      const item = findItemById(row.id);
      if (item) finalized.push(item);
    }
    return finalized;
  });

  const updateSnapshot = (chatId: number, messageId: number, snapshot: StoredMessageSnapshot): QueueItemRecord | undefined => {
    snapshot = validateStoredMessageSnapshot(snapshot);
    return database.transaction(() => {
    const item = findBySource(chatId, messageId);
    if (!item || !isSourceBearing(item.status)) return item;
    // Once destination transfer has begun, the captured contract owns the
    // operation. An edit update must not change the version that a cleanup
    // CAS will later compare against.
    if (item.status === "publishing" || item.status === "published_cleanup_pending") {
      database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES ('source_edit_ignored_after_publication_transfer', 'system', ?, ?, ?, ?)").run(item.id, item.claimedOperationId ?? null, JSON.stringify({ chatId, messageId, contentVersion: item.contentVersion, sourceGeneration: item.sourceGeneration }), Date.now());
      return item;
    }
    const current = getMessages(item.id).find((message) => message.telegramMessageId === messageId);
    if (!current) return item;
    if (current.editDate !== undefined && snapshot.editDate !== undefined && snapshot.editDate <= current.editDate) return item;
    const persistedSnapshot = { ...snapshot, origin: current.snapshot.origin };
    if (stableJson(current.snapshot) === stableJson(persistedSnapshot)) return item;
    database.raw.query("UPDATE queue_messages SET telegram_date = ?, edit_date = ?, snapshot_json = ? WHERE item_id = ? AND source_generation = ? AND telegram_message_id = ?").run(persistedSnapshot.telegramDate, persistedSnapshot.editDate ?? null, JSON.stringify(persistedSnapshot), item.id, item.sourceGeneration, messageId);
    database.raw.query("UPDATE queue_items SET content_version = content_version + 1, content_type = ? WHERE id = ?").run(persistedSnapshot.contentType, item.id);
    return findItemById(item.id);
    });
  };

  const listActive = (limit = 100, offset = 0): QueueItemRecord[] => {
    const rows = database.raw.query("SELECT * FROM queue_items WHERE status NOT IN ('done','deleted','deleted_external') ORDER BY logical_sequence LIMIT ? OFFSET ?").all(limit, offset) as QueueRow[];
    return rows.map(rowToItem);
  };

  const getHead = (): QueueItemRecord | undefined => {
    const row = database.raw.query("SELECT * FROM queue_items WHERE status NOT IN ('done','deleted','deleted_external') ORDER BY logical_sequence LIMIT 1").get() as QueueRow | null;
    return row ? rowToItem(row) : undefined;
  };

  const claimPublication = (operationId: string, type: "publish" | "manual_publish", now: number, bootId?: string): ClaimedItem | undefined => database.transaction(() => {
    const head = getHead();
    if (!head || head.status !== "queued" || head.maintenanceStatus !== "idle" || (head.retryNotBefore !== undefined && head.retryNotBefore > now)) return undefined;
    const changed = database.raw.query("UPDATE queue_items SET status = 'publishing', claimed_operation_id = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued' AND maintenance_status = 'idle' AND content_version = ? AND source_generation = ?").run(operationId, now, head.id, head.contentVersion, head.sourceGeneration);
    if (Number(changed.changes) !== 1) return undefined;
    database.raw.query("INSERT INTO operations (id, type, item_id, state, phase, boot_id, return_item_status, captured_content_version, captured_source_generation, lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, 'running', 'claimed', ?, ?, ?, ?, ?, ?, ?, ?)").run(operationId, type, head.id, currentBootId ?? bootId ?? operationId, head.status, head.contentVersion, head.sourceGeneration, operationId, now + 300_000, now, now);
    const claimed = findItemById(head.id);
    if (!claimed) throw new Error("Queue item disappeared during claim");
    return { item: claimed, operationId, capturedContentVersion: head.contentVersion, capturedSourceGeneration: head.sourceGeneration };
  });

  const claimRenewal = (operationId: string, now: number, eligibleBefore: number, bootId?: string): ClaimedItem | undefined => database.transaction(() => {
    const row = database.raw.query("SELECT * FROM queue_items WHERE status NOT IN ('done','deleted','deleted_external','collecting','publishing','published_cleanup_pending') AND maintenance_status = 'idle' AND physical_created_at <= ? AND (maintenance_retry_not_before IS NULL OR maintenance_retry_not_before <= ?) ORDER BY physical_created_at, logical_sequence LIMIT 1").get(eligibleBefore, now) as QueueRow | null;
    if (!row) return undefined;
    const item = rowToItem(row);
    const changed = database.raw.query("UPDATE queue_items SET maintenance_status = 'renewing', maintenance_operation_id = ?, maintenance_retry_not_before = NULL, attempts = attempts + 1 WHERE id = ? AND status = ? AND maintenance_status = 'idle' AND source_generation = ? AND content_version = ?").run(operationId, item.id, item.status, item.sourceGeneration, item.contentVersion);
    if (Number(changed.changes) !== 1) return undefined;
    const sourceIds = currentSourceIds(item.id);
    database.raw.query("INSERT INTO operations (id, type, item_id, state, phase, boot_id, return_item_status, expected_source_count, captured_content_version, captured_source_generation, source_ids_json, lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, 'renew', ?, 'running', 'claimed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(operationId, item.id, currentBootId ?? bootId ?? operationId, item.status, sourceIds.length, item.contentVersion, item.sourceGeneration, JSON.stringify(sourceIds), operationId, now + 300_000, now, now);
    const claimed = findItemById(item.id);
    if (!claimed) throw new Error("Queue item disappeared during renewal claim");
    return { item: claimed, operationId, capturedContentVersion: item.contentVersion, capturedSourceGeneration: item.sourceGeneration };
  });

  const transition = (itemId: number, from: QueueItemStatus, to: QueueItemStatus, now: number, errorCode?: string, errorText?: string): QueueItemRecord => database.transaction(() => {
    assertStatusTransition(from, to);
    const item = findItemById(itemId);
    if (!item || item.status !== from) throw new Error("Queue state changed before transition");
    database.raw.query("UPDATE queue_items SET status = ?, last_error_code = ?, last_error = ?, claimed_operation_id = NULL, claimed_at = NULL, completed_at = CASE WHEN ? IN ('done','deleted','deleted_external') THEN ? ELSE completed_at END WHERE id = ? AND status = ?").run(to, errorCode ?? null, errorText ?? null, to, now, itemId, from);
    const updated = findItemById(itemId);
    if (!updated) throw new Error("Queue item disappeared after transition");
    return updated;
  });

  const setOperationState = (operationId: string, state: OperationState | string, now: number, errorCode?: string, errorJson?: string): void => {
    database.raw.query("UPDATE operations SET state = ?, error_code = ?, error_json = ?, updated_at = ? WHERE id = ?").run(state, errorCode ?? null, errorJson ?? null, now, operationId);
  };

  const setOperationPhase = (operationId: string, phase: OperationPhase, now: number, errorCode?: string, errorJson?: string): void => {
    database.raw.query("UPDATE operations SET phase = ?, error_code = ?, error_json = ?, updated_at = ? WHERE id = ?").run(phase, errorCode ?? null, errorJson ?? null, now, operationId);
  };

  const setRenewalUncertain = (itemId: number, operationId: string, now: number, errorCode: string, errorText: string): void => database.transaction(() => {
    const result = database.raw.query("UPDATE queue_items SET maintenance_status = 'uncertain_renewal', last_error_code = ?, last_error = ? WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewing'").run(errorCode, errorText, itemId, operationId);
    if (Number(result.changes) !== 1) throw new Error("Renewal uncertainty guard conflict");
    setOperationState(operationId, "uncertain", now, errorCode, JSON.stringify({ message: errorText }));
    setOperationPhase(operationId, "uncertain", now, errorCode, JSON.stringify({ message: errorText }));
  });

  const failRenewal = (itemId: number, operationId: string, now: number, errorCode: string, errorText: string): void => database.transaction(() => {
    const result = database.raw.query("UPDATE queue_items SET maintenance_status = 'idle', maintenance_operation_id = NULL, last_error_code = ?, last_error = ? WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewing'").run(errorCode, errorText, itemId, operationId);
    if (Number(result.changes) !== 1) throw new Error("Renewal failure guard conflict");
    setOperationState(operationId, "failed", now, errorCode, JSON.stringify({ message: errorText }));
    setOperationPhase(operationId, "failed", now, errorCode, JSON.stringify({ message: errorText }));
  });

  const operationForItem = (itemId: number): { id: string; state: string; type: string; phase: string; returnItemStatus?: QueueItemStatus; capturedContentVersion: number; capturedSourceGeneration: number } | undefined => {
    const row = database.raw.query("SELECT id, state, type, phase, return_item_status, captured_content_version, captured_source_generation FROM operations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1").get(itemId) as { id: string; state: string; type: string; phase: string; return_item_status: QueueItemStatus | null; captured_content_version: number; captured_source_generation: number } | null;
    if (!row) return undefined;
    const result: { id: string; state: string; type: string; phase: string; returnItemStatus?: QueueItemStatus; capturedContentVersion: number; capturedSourceGeneration: number } = { id: row.id, state: row.state, type: row.type, phase: row.phase, capturedContentVersion: row.captured_content_version, capturedSourceGeneration: row.captured_source_generation };
    if (row.return_item_status !== null) result.returnItemStatus = row.return_item_status;
    return result;
  };

  const operationOutputIds = (operationId: string, role: "destination" | "replacement" | "temporary_preview" | OperationOutputRole): MessageId[] => {
    const useKind = role === "destination" || role === "temporary_preview";
    const column = useKind ? "kind" : "role";
    const value = role === "destination" ? "destination" : role;
    return (database.raw.query(`SELECT telegram_message_id FROM operation_outputs WHERE operation_id = ? AND ${column} = ? ORDER BY ordinal, telegram_message_id`).all(operationId, value) as Array<{ telegram_message_id: number }>).map((row) => row.telegram_message_id as MessageId);
  };

  const operationSourceIds = (operationId: string): MessageId[] => {
    const row = database.raw.query("SELECT source_ids_json FROM operations WHERE id = ?").get(operationId) as { source_ids_json: string | null } | null;
    if (!row?.source_ids_json) return [];
    try {
      const parsed = JSON.parse(row.source_ids_json) as unknown;
      return validateOrderedMessageIds(parsed, "operation.sourceIds");
    } catch {
      return [];
    }
  };

  const recoverExpiredOperations = (now: number, bootId?: string): number[] => database.transaction(() => {
    const rows = database.raw.query("SELECT id, item_id, type, phase, state, expected_output_count, expected_source_count, captured_content_version, captured_source_generation, created_at FROM operations WHERE state IN ('running','outputs_recorded','cleanup_pending') AND ((lease_expires_at IS NULL OR lease_expires_at <= ?) OR (? IS NOT NULL AND (boot_id IS NULL OR boot_id <> ?)))").all(now, bootId ?? null, bootId ?? null) as Array<{ id: string; item_id: number; type: string; phase: string; state: string; expected_output_count: number | null; expected_source_count: number | null; captured_content_version: number; captured_source_generation: number; created_at: number }>;
    const recovered: number[] = [];
    const markRenewalUncertain = (itemId: number, operationId: string): void => {
      database.raw.query("UPDATE queue_items SET maintenance_status = 'uncertain_renewal', last_error_code = 'startup_recovery', last_error = 'Renewal requires explicit physical resolution' WHERE id = ? AND maintenance_operation_id = ?").run(itemId, operationId);
      setOperationPhase(operationId, "uncertain", now, "startup_recovery");
      setOperationState(operationId, "uncertain", now, "startup_recovery");
    };
    const markLegacyPublicationUncertain = (itemId: number, operationId: string): void => {
      database.raw.query("UPDATE queue_items SET status = CASE WHEN status IN ('done','deleted','deleted_external') THEN status ELSE 'needs_review' END, claimed_operation_id = NULL, claimed_at = NULL, last_error_code = 'startup_recovery', last_error = 'Legacy publication operation requires explicit review' WHERE id = ?").run(itemId);
      database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES ('legacy_operation_quarantined', 'startup_recovery', ?, ?, ?, ?)").run(itemId, operationId, JSON.stringify({ reason: "nonterminal_legacy_publication" }), now);
      setOperationPhase(operationId, "uncertain", now, "startup_recovery");
      setOperationState(operationId, "uncertain", now, "startup_recovery");
    };
    for (const row of rows) {
      const item = findItemById(row.item_id);
      if (!item) continue;
      if (row.type === "renew") {
        if (row.phase === "claimed") {
          database.raw.query("UPDATE queue_items SET maintenance_status = 'idle', maintenance_operation_id = NULL WHERE id = ? AND maintenance_operation_id = ?").run(item.id, row.id);
          setOperationPhase(row.id, "failed", now, "startup_recovery");
          setOperationState(row.id, "failed", now, "startup_recovery");
        } else if (row.phase === "replacement_outputs_recorded") {
          const oldMessages = getMessages(item.id, row.captured_source_generation).sort((left, right) => left.ordinal - right.ordinal);
          let replacementIds: MessageId[] | undefined;
          try { replacementIds = validateOrderedMessageIds(operationOutputIds(row.id, "replacement"), "renewal replacement IDs"); }
          catch { replacementIds = undefined; }
          const sourceIds = operationSourceIds(row.id);
          const sourceEvidenceMatches = sourceIds.length === oldMessages.length && sourceIds.every((messageId, index) => messageId === oldMessages[index]?.telegramMessageId);
          const exactCount = replacementIds !== undefined && row.expected_source_count !== null && row.expected_source_count === oldMessages.length && row.expected_source_count === replacementIds.length && sourceEvidenceMatches;
          const guardMatches = item.maintenanceStatus === "renewing" && item.maintenanceOperationId === row.id && item.contentVersion === row.captured_content_version && item.sourceGeneration === row.captured_source_generation;
          if (!exactCount || !guardMatches) {
            markRenewalUncertain(item.id, row.id);
          } else {
            const nextGeneration = row.captured_source_generation + 1;
            for (const [ordinal, message] of oldMessages.entries()) {
              const { editDate: _editDate, ...withoutEditDate } = message.snapshot;
              insertSnapshot(item.id, nextGeneration, { ...withoutEditDate, messageId: replacementIds![ordinal]!, ordinal, telegramDate: row.created_at });
            }
            const installed = database.raw.query("UPDATE queue_items SET source_generation = ?, physical_created_at = ?, last_renewed_at = ?, maintenance_status = 'renewal_cleanup_pending', last_error_code = NULL, last_error = NULL WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewing' AND content_version = ? AND source_generation = ?").run(nextGeneration, row.created_at, now, item.id, row.id, row.captured_content_version, row.captured_source_generation);
            if (Number(installed.changes) !== 1) {
              markRenewalUncertain(item.id, row.id);
            } else {
              setOperationPhase(row.id, "generation_installed", now, "startup_recovery");
              setOperationState(row.id, "cleanup_pending", now, "startup_recovery");
            }
          }
        } else if (row.phase === "generation_installed" || row.phase === "old_source_cleanup_pending") {
          database.raw.query("UPDATE queue_items SET maintenance_status = 'renewal_cleanup_pending' WHERE id = ? AND maintenance_operation_id = ? AND source_generation = ?").run(item.id, row.id, row.captured_source_generation + 1);
          setOperationPhase(row.id, "old_source_cleanup_pending", now, "startup_recovery");
          setOperationState(row.id, "cleanup_pending", now, "startup_recovery");
        } else {
          markRenewalUncertain(item.id, row.id);
        }
        recovered.push(item.id);
        continue;
      }
      if (row.phase === "claimed" && item.status === "publishing") {
        database.raw.query("UPDATE queue_items SET status = 'queued', claimed_operation_id = NULL, claimed_at = NULL, last_error_code = 'startup_recovery' WHERE id = ? AND claimed_operation_id = ?").run(item.id, row.id);
        setOperationPhase(row.id, "failed", now, "startup_recovery");
        setOperationState(row.id, "failed", now, "startup_recovery");
      } else if (item.status !== "publishing" && item.status !== "published_cleanup_pending") {
        if (item.status === "done" || item.status === "deleted" || item.status === "deleted_external") {
          setOperationPhase(row.id, "failed", now, "startup_recovery");
          setOperationState(row.id, "failed", now, "startup_recovery");
        } else {
          markLegacyPublicationUncertain(item.id, row.id);
        }
      } else if (row.phase === "output_complete" || row.phase === "source_cleanup_pending" || item.status === "published_cleanup_pending") {
        database.raw.query("UPDATE queue_items SET status = 'published_cleanup_pending', claimed_at = NULL WHERE id = ? AND claimed_operation_id = ?").run(item.id, row.id);
        setOperationPhase(row.id, "source_cleanup_pending", now, "startup_recovery");
        setOperationState(row.id, "cleanup_pending", now, "startup_recovery");
      } else {
        database.raw.query("UPDATE queue_items SET status = 'uncertain_publish', claimed_operation_id = NULL, claimed_at = NULL, last_error_code = 'startup_recovery', last_error = 'Publication output is not durably complete' WHERE id = ? AND claimed_operation_id = ?").run(item.id, row.id);
        setOperationPhase(row.id, "uncertain", now, "startup_recovery");
        setOperationState(row.id, "uncertain", now, "startup_recovery");
      }
      recovered.push(item.id);
    }
    return recovered;
  });

  const recordOutput = (operationId: string, role: OperationOutputRole | "destination" | "temporary_preview", chatId: number, messageId: number, ordinal: number, now: number): void => {
    if (!Number.isSafeInteger(chatId)) throw new InvalidTelegramOutputError("Invalid numeric Telegram output chat ID");
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new InvalidTelegramOutputError("Invalid numeric Telegram output ID");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new InvalidTelegramOutputError("Invalid numeric Telegram output ordinal");
    const kind = role === "replacement" ? "replacement" : role === "temporary_preview" ? "temporary_preview" : "destination";
    const normalizedRole = role === "destination" ? "transferred" : role;
    const result = database.raw.query("INSERT OR IGNORE INTO operation_outputs (operation_id, kind, role, chat_id, telegram_message_id, ordinal, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(operationId, kind, normalizedRole, chatId, messageId, ordinal, now);
    if (Number(result.changes) === 1) return;
    const existing = database.raw.query("SELECT operation_id, kind, role, ordinal FROM operation_outputs WHERE chat_id = ? AND telegram_message_id = ?").get(chatId, messageId) as { operation_id: string; kind: string; role: string; ordinal: number } | null;
    if (existing?.operation_id === operationId && existing.kind === kind && existing.role === normalizedRole && existing.ordinal === ordinal) return;
    throw conflict(`Telegram output ${chatId}/${messageId} already belongs to another operation`);
  };

  const recordReplacementOutput = (operationId: string, chatId: number, messageId: number, ordinal: number, now: number): void => database.transaction(() => {
    recordOutput(operationId, "replacement", chatId, messageId, ordinal, now);
    database.raw.query("INSERT OR REPLACE INTO generated_messages (chat_id, message_id, operation_id, kind, created_at, consumed_at) VALUES (?, ?, ?, 'renewal', ?, NULL)").run(chatId, messageId, operationId, now);
  });

  const persistPublicationContract = (operationId: string, contract: PublicationContract, now: number): void => database.transaction(() => {
    const validated = validatePublicationContract(contract);
    const result = database.raw.query("UPDATE operations SET return_item_status = ?, expected_source_count = ?, expected_output_count = ?, source_ids_json = ?, plan_json = ?, phase = 'claimed', updated_at = ? WHERE id = ? AND item_id IN (SELECT id FROM queue_items WHERE claimed_operation_id = ? AND content_version = ? AND source_generation = ?)").run(
      validated.capturedLogicalStatus,
      validated.sourceIds.length,
      validated.expectedOutputMessageCount,
      JSON.stringify(validated.sourceIds),
      JSON.stringify(validated),
      now,
      operationId,
      operationId,
      validated.capturedContentVersion,
      validated.capturedSourceGeneration,
    );
    if (Number(result.changes) !== 1) throw conflict("Publication contract guard conflict");
  });

  const beginPublicationTransfer = (guard: OperationGuard, now: number): void => {
    const result = database.raw.query("UPDATE operations SET phase = 'transfer_pending', updated_at = ? WHERE id = ? AND item_id = ? AND captured_content_version = ? AND captured_source_generation = ? AND phase = 'claimed' AND EXISTS (SELECT 1 FROM queue_items WHERE id = ? AND status = 'publishing' AND claimed_operation_id = ? AND content_version = ? AND source_generation = ?)").run(now, guard.operationId, guard.itemId, guard.capturedContentVersion, guard.capturedSourceGeneration, guard.itemId, guard.operationId, guard.capturedContentVersion, guard.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Publication transfer guard conflict");
  };

  const markPartialCleanupPending = (guard: OperationGuard, now: number, errorCode: string, errorText: string): void => {
    const result = database.raw.query("UPDATE operations SET state = 'cleanup_pending', phase = 'partial_cleanup_pending', error_code = ?, error_json = ?, updated_at = ? WHERE id = ? AND item_id = ? AND captured_content_version = ? AND captured_source_generation = ? AND phase IN ('transfer_pending','attribution_pending')").run(errorCode, JSON.stringify({ message: errorText }), now, guard.operationId, guard.itemId, guard.capturedContentVersion, guard.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Partial cleanup phase guard conflict");
  };

  const guardRow = (guard: OperationGuard): { phase: string; type: string; maintenanceStatus: MaintenanceStatus; status: QueueItemStatus } | undefined => {
    const row = database.raw.query("SELECT o.phase, o.type, qi.status, qi.maintenance_status FROM operations o JOIN queue_items qi ON qi.id = o.item_id WHERE o.id = ? AND o.item_id = ? AND o.captured_content_version = ? AND o.captured_source_generation = ?").get(guard.operationId, guard.itemId, guard.capturedContentVersion, guard.capturedSourceGeneration) as { phase: string; type: string; status: QueueItemStatus; maintenance_status: MaintenanceStatus } | null;
    if (!row) return undefined;
    return { phase: row.phase, type: row.type, status: row.status, maintenanceStatus: row.maintenance_status };
  };

  const recordCompleteBaseOutputs = (guard: OperationGuard, outputs: readonly { chatId: number; messageId: number; ordinal: number }[], now: number): void => database.transaction(() => {
    const operation = guardRow(guard);
    if (!operation || operation.type === "renew" || operation.phase !== "transfer_pending" || operation.status !== "publishing") throw conflict("Publication transfer guard conflict");
    for (const output of outputs) recordOutput(guard.operationId, "transferred", output.chatId, output.messageId, output.ordinal, now);
    const expected = database.raw.query("SELECT expected_source_count FROM operations WHERE id = ?").get(guard.operationId) as { expected_source_count: number | null } | null;
    if (!expected || expected.expected_source_count !== outputs.length) throw new Error("Publication output count does not match contract");
    const result = database.raw.query("UPDATE operations SET state = 'outputs_recorded', phase = 'base_outputs_recorded', updated_at = ? WHERE id = ? AND item_id = ? AND captured_content_version = ? AND captured_source_generation = ? AND phase = 'transfer_pending'").run(now, guard.operationId, guard.itemId, guard.capturedContentVersion, guard.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Publication phase changed before base outputs were recorded");
  });

  const markAttributionPending = (guard: OperationGuard, now: number): void => {
    const result = database.raw.query("UPDATE operations SET phase = 'attribution_pending', updated_at = ? WHERE id = ? AND item_id = ? AND captured_content_version = ? AND captured_source_generation = ? AND phase = 'base_outputs_recorded'").run(now, guard.operationId, guard.itemId, guard.capturedContentVersion, guard.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Publication attribution guard conflict");
  };

  const markPublicationOutputComplete = (guard: OperationGuard, destinationIds: readonly number[], now: number): void => database.transaction(() => {
    const operation = guardRow(guard);
    if (!operation || operation.type === "renew" || operation.status !== "publishing" || !["base_outputs_recorded", "attribution_pending"].includes(operation.phase)) throw conflict("Publication output completion guard conflict");
    const expected = database.raw.query("SELECT expected_output_count FROM operations WHERE id = ?").get(guard.operationId) as { expected_output_count: number | null } | null;
    if (!expected || expected.expected_output_count !== destinationIds.length) throw new Error("Publication output count does not match contract");
    const result = database.raw.query("UPDATE queue_items SET destination_message_ids_json = ? WHERE id = ? AND status = 'publishing' AND claimed_operation_id = ? AND content_version = ? AND source_generation = ?").run(JSON.stringify(destinationIds), guard.itemId, guard.operationId, guard.capturedContentVersion, guard.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Publication output completion item guard conflict");
    setOperationState(guard.operationId, "outputs_recorded", now, undefined, undefined);
    setOperationPhase(guard.operationId, "output_complete", now);
  });

  const markSourceCleanupPending = (guard: OperationGuard, now: number): void => database.transaction(() => {
    const result = database.raw.query("UPDATE queue_items SET status = 'published_cleanup_pending', claimed_at = ? WHERE id = ? AND status = 'publishing' AND claimed_operation_id = ? AND content_version = ? AND source_generation = ?").run(now, guard.itemId, guard.operationId, guard.capturedContentVersion, guard.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Publication cleanup guard conflict");
    setOperationState(guard.operationId, "cleanup_pending", now);
    setOperationPhase(guard.operationId, "source_cleanup_pending", now);
  });

  const setDestinationMessageIds = (itemId: number, operationId: string, messageIds: readonly number[], now: number): void => database.transaction(() => {
    const item = findItemById(itemId);
    if (!item || item.claimedOperationId !== operationId) throw new Error("Publication operation lease is no longer owned");
    database.raw.query("UPDATE queue_items SET destination_message_ids_json = ? WHERE id = ? AND claimed_operation_id = ? AND content_version = ? AND source_generation = ?").run(JSON.stringify(messageIds), itemId, operationId, item.contentVersion, item.sourceGeneration);
    setOperationState(operationId, "outputs_recorded", now);
    setOperationPhase(operationId, "output_complete", now);
    database.raw.query("UPDATE queue_items SET status = 'published_cleanup_pending' WHERE id = ? AND claimed_operation_id = ?").run(itemId, operationId);
    setOperationState(operationId, "cleanup_pending", now);
    setOperationPhase(operationId, "source_cleanup_pending", now);
  });

  const markReplacementOutputsRecorded = (guard: OperationGuard, now: number): void => database.transaction(() => {
    const operation = guardRow(guard);
    if (!operation || operation.type !== "renew" || operation.maintenanceStatus !== "renewing" || operation.phase !== "replacement_pending") throw conflict("Renewal replacement guard conflict");
    const expected = database.raw.query("SELECT expected_source_count FROM operations WHERE id = ?").get(guard.operationId) as { expected_source_count: number | null } | null;
    const actual = operationOutputIds(guard.operationId, "replacement").length;
    if (!expected || expected.expected_source_count !== actual) throw new Error("Renewal output count does not match contract");
    setOperationState(guard.operationId, "outputs_recorded", now);
    setOperationPhase(guard.operationId, "replacement_outputs_recorded", now);
  });

  const installRenewedGeneration = (guardOrItemId: OperationGuard | number, operationIdOrSnapshots: string | readonly StoredMessageSnapshot[], snapshotsOrNow: readonly StoredMessageSnapshot[] | number, maybeNow?: number, maybeSourceCreatedAt?: number): number => database.transaction(() => {
    const guard: OperationGuard = typeof guardOrItemId === "number"
      ? (() => {
        const item = findItemById(guardOrItemId);
        if (!item || typeof operationIdOrSnapshots !== "string") throw new Error("Renewal operation lease is no longer owned");
        return { operationId: operationIdOrSnapshots, itemId: guardOrItemId, capturedContentVersion: item.contentVersion, capturedSourceGeneration: item.sourceGeneration };
      })()
      : guardOrItemId;
    const replacementSnapshots = (typeof guardOrItemId === "number" ? snapshotsOrNow : operationIdOrSnapshots) as readonly StoredMessageSnapshot[];
    const now = (typeof guardOrItemId === "number" ? maybeNow : snapshotsOrNow) as number;
    const sourceCreatedAt = (typeof guardOrItemId === "number" ? maybeSourceCreatedAt : maybeNow) ?? now;
    const operation = guardRow(guard);
    if (!operation || operation.type !== "renew" || operation.maintenanceStatus !== "renewing" || !["replacement_outputs_recorded", "claimed"].includes(operation.phase)) throw conflict("Renewal generation guard conflict");
    const item = findItemById(guard.itemId);
    if (!item || item.maintenanceOperationId !== guard.operationId || item.contentVersion !== guard.capturedContentVersion || item.sourceGeneration !== guard.capturedSourceGeneration) throw conflict("Renewal generation CAS conflict");
    const nextGeneration = item.sourceGeneration + 1;
    for (const snapshot of replacementSnapshots) insertSnapshot(item.id, nextGeneration, snapshot);
    const result = database.raw.query("UPDATE queue_items SET source_generation = ?, physical_created_at = ?, last_renewed_at = ?, maintenance_status = 'renewal_cleanup_pending' WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewing' AND content_version = ? AND source_generation = ?").run(nextGeneration, sourceCreatedAt, now, item.id, guard.operationId, guard.capturedContentVersion, guard.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Renewal generation install lost its lease");
    setOperationState(guard.operationId, "cleanup_pending", now);
    setOperationPhase(guard.operationId, "generation_installed", now);
    return nextGeneration;
  });

  const setRetry = (itemId: number, operationId: string, now: number, retryNotBefore: number, errorCode: string, errorText: string): void => database.transaction(() => {
    const operation = database.raw.query("SELECT type, return_item_status FROM operations WHERE id = ? AND item_id = ?").get(operationId, itemId) as { type: string; return_item_status: QueueItemStatus | null } | null;
    if (!operation) throw new Error("Operation not found for retry");
    if (operation.type === "renew") {
      const result = database.raw.query("UPDATE queue_items SET maintenance_status = 'idle', maintenance_operation_id = NULL, maintenance_retry_not_before = ?, last_error_code = ?, last_error = ? WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewing'").run(retryNotBefore, errorCode, errorText, itemId, operationId);
      if (Number(result.changes) !== 1) throw new Error("Renewal retry guard conflict");
    } else {
      const result = database.raw.query("UPDATE queue_items SET status = 'queued', retry_not_before = ?, last_error_code = ?, last_error = ?, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ? AND claimed_operation_id = ? AND status = 'publishing'").run(retryNotBefore, errorCode, errorText, itemId, operationId);
      if (Number(result.changes) !== 1) throw new Error("Publication retry guard conflict");
    }
    setOperationPhase(operationId, "failed", now, errorCode, JSON.stringify({ message: errorText }));
    setOperationState(operationId, "failed", now, errorCode, JSON.stringify({ message: errorText }));
  });

  const markCompleted = (itemId: number, operationId: string, now: number): void => database.transaction(() => {
    const result = database.raw.query("UPDATE queue_items SET status = 'done', published_at = COALESCE(published_at, ?), completed_at = ?, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ? AND claimed_operation_id = ? AND status = 'published_cleanup_pending'").run(now, now, itemId, operationId);
    if (Number(result.changes) !== 1) throw new Error("Publication completion guard conflict");
    setOperationState(operationId, "done", now);
    setOperationPhase(operationId, "completed", now);
  });

  const completeRenewalWithOrphans = (guard: OperationGuard, orphanIds: readonly number[], now: number, reason = "old_generation_cleanup_failed"): void => database.transaction(() => {
    const operation = guardRow(guard);
    if (!operation || operation.type !== "renew" || !["generation_installed", "old_source_cleanup_pending"].includes(operation.phase)) throw new Error("Renewal cleanup guard conflict");
    const item = findItemById(guard.itemId);
    if (!item || item.maintenanceOperationId !== guard.operationId || item.contentVersion !== guard.capturedContentVersion || item.sourceGeneration !== guard.capturedSourceGeneration + 1) throw new Error("Renewal completion CAS conflict");
    const terminal = reason === "telegram_age_limit";
    const nextAttemptAt = reason === "permission_denied" ? now + 6 * 60 * 60_000 : now;
    const orphanInsert = database.raw.query("INSERT OR IGNORE INTO orphaned_sources (item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, resolved_at, attempt_count, next_attempt_at, terminal_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const id of orphanIds) orphanInsert.run(item.id, guard.capturedSourceGeneration, item.queueChatId, id, reason, now, now, null, terminal ? 1 : 0, terminal ? null : nextAttemptAt, terminal ? reason : null);
    const result = database.raw.query("UPDATE queue_items SET maintenance_status = 'idle', maintenance_operation_id = NULL, maintenance_retry_not_before = NULL WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewal_cleanup_pending' AND content_version = ? AND source_generation = ?").run(item.id, guard.operationId, guard.capturedContentVersion, guard.capturedSourceGeneration + 1);
    if (Number(result.changes) !== 1) throw new Error("Renewal maintenance cleanup guard conflict");
    setOperationState(guard.operationId, "done", now, orphanIds.length > 0 ? reason : undefined);
    setOperationPhase(guard.operationId, "completed", now, orphanIds.length > 0 ? reason : undefined);
  });

  const markRenewedCleanupComplete = (itemId: number, operationId: string, now: number): void => {
    const item = findItemById(itemId);
    if (!item) throw new Error("Queue item not found for renewal cleanup");
    completeRenewalWithOrphans({ operationId, itemId, capturedContentVersion: item.contentVersion, capturedSourceGeneration: item.sourceGeneration - 1 }, [], now);
  };

  const markMissing = (itemId: number, operationId: string | undefined, now: number): void => database.transaction(() => {
    const operation = operationId ? database.raw.query("SELECT type, phase FROM operations WHERE id = ? AND item_id = ?").get(operationId, itemId) as { type: string; phase: string } | null : null;
    const publishedOutputWasComplete = operation !== null && (operation.phase === "source_cleanup_pending" || operation.phase === "completed");
    if (publishedOutputWasComplete) {
      database.raw.query("UPDATE queue_items SET status = 'done', published_at = COALESCE(published_at, ?), completed_at = ?, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ?").run(now, now, itemId);
      if (operationId) database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES ('source_already_absent_after_publication', 'system', ?, ?, ?, ?)").run(itemId, operationId, JSON.stringify({ sourceCleanup: "confirmed_absent" }), now);
    } else {
      database.raw.query("UPDATE queue_items SET status = 'deleted_external', completed_at = ?, claimed_operation_id = NULL, claimed_at = NULL, maintenance_status = 'idle', maintenance_operation_id = NULL WHERE id = ?").run(now, itemId);
    }
    if (operationId) {
      setOperationState(operationId, "done", now, "source_missing");
      setOperationPhase(operationId, "completed", now, "source_missing");
    }
  });

  const markAdminDeleted = (itemId: number, now: number): void => {
    database.raw.query("UPDATE queue_items SET status = 'deleted', completed_at = ?, claimed_operation_id = NULL, claimed_at = NULL, maintenance_status = 'idle', maintenance_operation_id = NULL WHERE id = ? AND status NOT IN ('done','deleted','deleted_external')").run(now, itemId);
  };

  const retryItem = (itemId: number, now: number): void => {
    database.raw.query("UPDATE queue_items SET status = 'queued', retry_not_before = NULL, last_error_code = NULL, last_error = NULL, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ? AND maintenance_status = 'idle' AND status IN ('blocked','needs_edit','needs_review','delete_blocked')").run(itemId);
  };

  const operationEvidence = (itemId: number): {
    operationId: string;
    type: string;
    errorCode?: string;
    expectedSourceCount?: number;
    phase: string;
    expectedOutputCount?: number;
    sourceIds: MessageId[];
    knownDestinationIds: MessageId[];
    knownReplacementIds: MessageId[];
    capturedContentVersion: number;
    capturedSourceGeneration: number;
  } | undefined => {
    const operation = database.raw.query("SELECT id, type, phase, error_code, expected_source_count, expected_output_count, captured_content_version, captured_source_generation FROM operations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1").get(itemId) as { id: string; type: string; phase: string; error_code: string | null; expected_source_count: number | null; expected_output_count: number | null; captured_content_version: number; captured_source_generation: number } | null;
    if (!operation) return undefined;
    const result: {
      operationId: string;
      type: string;
      errorCode?: string;
      expectedSourceCount?: number;
      phase: string;
      expectedOutputCount?: number;
      sourceIds: MessageId[];
      knownDestinationIds: MessageId[];
      knownReplacementIds: MessageId[];
      capturedContentVersion: number;
      capturedSourceGeneration: number;
    } = {
      operationId: operation.id,
      type: operation.type,
      phase: operation.phase,
      sourceIds: operationSourceIds(operation.id),
      knownDestinationIds: operationOutputIds(operation.id, "destination"),
      knownReplacementIds: operationOutputIds(operation.id, "replacement"),
      capturedContentVersion: operation.captured_content_version,
      capturedSourceGeneration: operation.captured_source_generation,
    };
    if (operation.error_code !== null) result.errorCode = operation.error_code;
    if (operation.expected_source_count !== null) result.expectedSourceCount = operation.expected_source_count;
    if (operation.expected_output_count !== null) result.expectedOutputCount = operation.expected_output_count;
    return result;
  };

  const requeueUncertainPublication = (itemId: number, operationId: string, contentVersion: number, sourceGeneration: number, now: number, reason: string): void => database.transaction(() => {
    const result = database.raw.query("UPDATE queue_items SET status = 'queued', retry_not_before = NULL, last_error_code = ?, last_error = ?, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ? AND status = 'uncertain_publish' AND content_version = ? AND source_generation = ?").run(reason, reason, itemId, contentVersion, sourceGeneration);
    if (Number(result.changes) !== 1) throw new Error("Uncertain publication resolution is stale");
    const operation = database.raw.query("UPDATE operations SET state = 'failed', phase = 'failed', error_code = ?, updated_at = ? WHERE id = ? AND item_id = ? AND phase = 'uncertain' AND captured_content_version = ? AND captured_source_generation = ?").run(reason, now, operationId, itemId, contentVersion, sourceGeneration);
    if (Number(operation.changes) !== 1) throw new Error("Uncertain publication operation resolution is stale");
    database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES ('uncertain_publication_retry_confirmed', 'admin', ?, ?, ?, ?)").run(itemId, operationId, JSON.stringify({ reason, duplicateRisk: true }), now);
  });

  const adoptConfirmedPublicationOutputs = (itemId: number, operationId: string, contentVersion: number, sourceGeneration: number, destinationChatId: number, destinationIds: readonly number[], now: number): void => database.transaction(() => {
    const validatedDestinationIds = validateOrderedMessageIds(destinationIds, "destinationMessageIds");
    const operation = database.raw.query("SELECT expected_output_count FROM operations WHERE id = ? AND item_id = ? AND phase = 'uncertain' AND captured_content_version = ? AND captured_source_generation = ?").get(operationId, itemId, contentVersion, sourceGeneration) as { expected_output_count: number | null } | null;
    if (!operation || operation.expected_output_count === null || operation.expected_output_count !== validatedDestinationIds.length) throw conflict("Confirmed destination output count does not match the captured contract");
    const item = findItemById(itemId);
    if (!item || item.status !== "uncertain_publish" || item.contentVersion !== contentVersion || item.sourceGeneration !== sourceGeneration) throw conflict("Uncertain publication resolution is stale");
    for (const [ordinal, messageId] of validatedDestinationIds.entries()) recordOutput(operationId, ordinal === validatedDestinationIds.length - 1 && validatedDestinationIds.length > inputExpectedTransferred(operationId) ? "separate_byline" : "transferred", destinationChatId, messageId, ordinal, now);
    const itemResult = database.raw.query("UPDATE queue_items SET status = 'published_cleanup_pending', destination_message_ids_json = ?, claimed_operation_id = ?, claimed_at = ? WHERE id = ? AND status = 'uncertain_publish' AND content_version = ? AND source_generation = ?").run(JSON.stringify(validatedDestinationIds), operationId, now, itemId, contentVersion, sourceGeneration);
    if (Number(itemResult.changes) !== 1) throw conflict("Confirmed destination output adoption lost its item guard");
    setOperationState(operationId, "cleanup_pending", now);
    setOperationPhase(operationId, "source_cleanup_pending", now);
    database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES ('uncertain_publication_destination_confirmed', 'admin', ?, ?, ?, ?)").run(itemId, operationId, JSON.stringify({ destinationIds }), now);
  });

  const inputExpectedTransferred = (operationId: string): number => {
    const row = database.raw.query("SELECT expected_source_count FROM operations WHERE id = ?").get(operationId) as { expected_source_count: number | null } | null;
    return row?.expected_source_count ?? Number.MAX_SAFE_INTEGER;
  };

  const resolveUncertainRenewal = (itemId: number, operationId: string, contentVersion: number, sourceGeneration: number, now: number, orphanIds: readonly number[], mode: "no_replacement" | "manual_cleanup"): void => database.transaction(() => {
    const validatedOrphanIds = orphanIds.length === 0 ? [] : validateOrderedMessageIds(orphanIds, "orphanMessageIds");
    const itemResult = database.raw.query("UPDATE queue_items SET maintenance_status = 'idle', maintenance_operation_id = NULL, maintenance_retry_not_before = NULL, last_error_code = ?, last_error = ? WHERE id = ? AND maintenance_status = 'uncertain_renewal' AND maintenance_operation_id = ? AND content_version = ? AND source_generation = ?").run(mode, mode, itemId, operationId, contentVersion, sourceGeneration);
    if (Number(itemResult.changes) !== 1) throw conflict("Uncertain renewal resolution is stale");
    const item = findItemById(itemId);
    if (!item) throw new Error("Queue item disappeared during renewal resolution");
    const orphanInsert = database.raw.query("INSERT OR IGNORE INTO orphaned_sources (item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, resolved_at, attempt_count, next_attempt_at, terminal_reason) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL)");
    for (const messageId of validatedOrphanIds) orphanInsert.run(itemId, sourceGeneration, item.queueChatId, messageId, "admin_manual_cleanup", now, now, now);
    database.raw.query("UPDATE pending_queue_updates SET state = 'discarded', last_error = ? WHERE candidate_operation_id = ? AND state = 'quarantined_renewal_candidate'").run(`renewal_resolution:${mode}`, operationId);
    database.raw.query("UPDATE operations SET state = 'failed', phase = 'failed', error_code = ?, updated_at = ? WHERE id = ? AND item_id = ? AND phase = 'uncertain' AND captured_content_version = ? AND captured_source_generation = ?").run(mode, now, operationId, itemId, contentVersion, sourceGeneration);
    database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES ('uncertain_renewal_resolved', 'admin', ?, ?, ?, ?)").run(itemId, operationId, JSON.stringify({ mode, orphanIds: validatedOrphanIds }), now);
  });

  const adoptUncertainRenewalGeneration = (guard: OperationGuard, replacementIds: readonly number[], now: number): number => database.transaction(() => {
    const validatedReplacementIds = validateOrderedMessageIds(replacementIds, "replacementMessageIds");
    const operation = database.raw.query("SELECT type, phase, expected_source_count FROM operations WHERE id = ? AND item_id = ? AND captured_content_version = ? AND captured_source_generation = ?").get(guard.operationId, guard.itemId, guard.capturedContentVersion, guard.capturedSourceGeneration) as { type: string; phase: string; expected_source_count: number | null } | null;
    if (!operation || operation.type !== "renew" || operation.phase !== "uncertain" || operation.expected_source_count !== validatedReplacementIds.length) throw conflict("Uncertain renewal adoption contract is stale");
    const item = findItemById(guard.itemId);
    if (!item || item.maintenanceStatus !== "uncertain_renewal" || item.maintenanceOperationId !== guard.operationId || item.contentVersion !== guard.capturedContentVersion || item.sourceGeneration !== guard.capturedSourceGeneration) throw conflict("Uncertain renewal adoption guard conflict");
    const originals = getMessages(item.id, guard.capturedSourceGeneration).sort((left, right) => left.ordinal - right.ordinal);
    if (originals.length !== validatedReplacementIds.length) throw conflict("Uncertain renewal adoption source count does not match the captured contract");
    const knownReplacementIds = operationOutputIds(guard.operationId, "replacement");
    let nextKnownIndex = 0;
    const knownOrdinals = new Map<number, number>();
    for (const messageId of knownReplacementIds) {
      while (nextKnownIndex < validatedReplacementIds.length && validatedReplacementIds[nextKnownIndex] !== messageId) nextKnownIndex += 1;
      if (nextKnownIndex >= validatedReplacementIds.length) throw conflict("Known partial replacement IDs conflict with the entered complete set; explicitly delete the known replacements or resolve them before adoption");
      knownOrdinals.set(messageId, nextKnownIndex);
      nextKnownIndex += 1;
    }
    for (const messageId of validatedReplacementIds) {
      const outputOwner = database.raw.query("SELECT operation_id FROM operation_outputs WHERE chat_id = ? AND telegram_message_id = ?").get(item.queueChatId, messageId) as { operation_id: string } | null;
      if (outputOwner && outputOwner.operation_id !== guard.operationId) throw conflict("A replacement message belongs to another operation");
      const generatedOwner = database.raw.query("SELECT operation_id FROM generated_messages WHERE chat_id = ? AND message_id = ?").get(item.queueChatId, messageId) as { operation_id: string } | null;
      if (generatedOwner && generatedOwner.operation_id !== guard.operationId) throw conflict("A replacement message is already registered to another operation");
    }
    for (const [messageId, ordinal] of knownOrdinals) {
      database.raw.query("UPDATE operation_outputs SET ordinal = ? WHERE operation_id = ? AND kind = 'replacement' AND chat_id = ? AND telegram_message_id = ?").run(ordinal, guard.operationId, item.queueChatId, messageId);
    }
    for (const [ordinal, messageId] of validatedReplacementIds.entries()) {
      recordOutput(guard.operationId, "replacement", item.queueChatId, messageId, ordinal, now);
      database.raw.query("INSERT OR IGNORE INTO generated_messages (chat_id, message_id, operation_id, kind, created_at, consumed_at) VALUES (?, ?, ?, 'renewal', ?, NULL)").run(item.queueChatId, messageId, guard.operationId, now);
    }
    const recordedIds = operationOutputIds(guard.operationId, "replacement");
    if (recordedIds.length !== validatedReplacementIds.length || recordedIds.some((messageId, index) => messageId !== validatedReplacementIds[index])) throw conflict("Replacement output evidence changed during adoption");
    const nextGeneration = guard.capturedSourceGeneration + 1;
    for (const [ordinal, message] of originals.entries()) {
      const { editDate: _editDate, ...withoutEditDate } = message.snapshot;
      insertSnapshot(item.id, nextGeneration, { ...withoutEditDate, messageId: validatedReplacementIds[ordinal]!, ordinal, telegramDate: now });
    }
    const result = database.raw.query("UPDATE queue_items SET source_generation = ?, physical_created_at = ?, last_renewed_at = ?, maintenance_status = 'renewal_cleanup_pending', last_error_code = NULL, last_error = NULL WHERE id = ? AND maintenance_status = 'uncertain_renewal' AND maintenance_operation_id = ? AND content_version = ? AND source_generation = ?").run(nextGeneration, now, now, item.id, guard.operationId, guard.capturedContentVersion, guard.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Uncertain renewal adoption lost its item guard");
    setOperationState(guard.operationId, "cleanup_pending", now);
    setOperationPhase(guard.operationId, "generation_installed", now);
    database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES ('uncertain_renewal_replacements_adopted', 'admin', ?, ?, ?, ?)").run(item.id, guard.operationId, JSON.stringify({ replacementIds: validatedReplacementIds }), now);
    return nextGeneration;
  });

  const moveToEnd = (itemId: number, now: number): void => database.transaction(() => {
    const nextSequence = database.raw.query("SELECT COALESCE(MAX(logical_sequence), 0) + 1 AS value FROM queue_items").get() as { value: number };
    database.raw.query("UPDATE queue_items SET logical_sequence = ?, last_error_code = 'moved_to_end', last_error = NULL WHERE id = ? AND status NOT IN ('done','deleted','deleted_external')").run(nextSequence.value, itemId);
  });

  const statusCounts = (): Record<string, number> => {
    const counts: Record<string, number> = {};
    const rows = database.raw.query("SELECT status, COUNT(*) AS count FROM queue_items GROUP BY status").all() as Array<{ status: string; count: number }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  };

  const currentSourceIds = (itemId: number): MessageId[] => getMessages(itemId).map((message) => message.telegramMessageId);

  const getCurrentSnapshotSet = (itemId: number): StoredMessageSnapshot[] => getMessages(itemId).map((message) => message.snapshot);

  const cloneSnapshotsWithIds = (itemId: number, messageIds: readonly MessageId[]): StoredMessageSnapshot[] => {
    const originals = getCurrentSnapshotSet(itemId);
    if (originals.length !== messageIds.length) throw new Error("Replacement message count does not match source count");
    return originals.map((snapshot, index) => {
      const { editDate: _editDate, ...withoutEditDate } = snapshot;
      return { ...withoutEditDate, messageId: messageIds[index]!, ordinal: index, telegramDate: Date.now() };
    });
  };

  const listRenewalAges = (now: number): Array<{ item: QueueItemRecord; ageMs: number; sourceIds: MessageId[] }> =>
    listActive(10_000).filter((item) => isSourceBearing(item.status) && item.status !== "collecting").map((item) => ({ item, ageMs: now - item.physicalCreatedAt, sourceIds: currentSourceIds(item.id) }));

  const listRecentlyDeletedExternal = (since: number, limit = 500): QueueItemRecord[] => {
    const rows = database.raw.query("SELECT * FROM queue_items WHERE status = 'deleted_external' AND completed_at >= ? ORDER BY completed_at DESC LIMIT ?").all(since, limit) as QueueRow[];
    return rows.map(rowToItem);
  };

  const renewalCandidateOperation = (queueChatId: number): { operationId: string; itemId: number } | undefined => {
    const row = database.raw.query("SELECT o.id AS operation_id, qi.id AS item_id FROM operations o JOIN queue_items qi ON qi.id = o.item_id WHERE o.type = 'renew' AND qi.queue_chat_id = ? AND qi.maintenance_status IN ('renewing','renewal_cleanup_pending','uncertain_renewal') AND o.phase NOT IN ('completed','failed') ORDER BY o.created_at LIMIT 1").get(queueChatId) as { operation_id: string; item_id: number } | null;
    return row ? { operationId: row.operation_id, itemId: row.item_id } : undefined;
  };

  const redactCompletedBefore = (before: number, now: number): { items: number; messages: number } => database.transaction(() => {
    const rows = database.raw.query("SELECT id FROM queue_items WHERE status IN ('done','deleted','deleted_external') AND completed_at IS NOT NULL AND completed_at < ? AND NOT EXISTS (SELECT 1 FROM orphaned_sources os WHERE os.item_id = queue_items.id AND os.resolved_at IS NULL) AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.item_id = queue_items.id AND o.state NOT IN ('done','failed')) AND NOT EXISTS (SELECT 1 FROM admin_alerts aa WHERE aa.resolved_at IS NULL AND (aa.dedupe_key = 'uncertain_publish:' || queue_items.id OR aa.dedupe_key = 'uncertain_renewal:' || queue_items.id OR aa.dedupe_key = 'renewal_warning:' || queue_items.id OR aa.dedupe_key = 'renewal_critical:' || queue_items.id))").all(before) as Array<{ id: number }>;
    let messages = 0;
    for (const row of rows) {
      const snapshots = database.raw.query("SELECT source_generation, telegram_message_id, snapshot_json FROM queue_messages WHERE item_id = ?").all(row.id) as Array<{ source_generation: number; telegram_message_id: number; snapshot_json: string }>;
      for (const snapshot of snapshots) {
        try {
          const value = JSON.parse(snapshot.snapshot_json) as Record<string, unknown>;
          for (const key of ["text", "entities", "caption", "captionEntities"]) delete value[key];
          database.raw.query("UPDATE queue_messages SET snapshot_json = ? WHERE item_id = ? AND source_generation = ? AND telegram_message_id = ?").run(JSON.stringify(value), row.id, snapshot.source_generation, snapshot.telegram_message_id);
          messages += 1;
        } catch {
          // Invalid terminal JSON is already non-actionable; leave it for the
          // health/quarantine path rather than failing unrelated retention.
        }
      }
    }
    if (rows.length > 0) database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('retention_redacted', 'retention', ?, ?)").run(JSON.stringify({ itemCount: rows.length, messageCount: messages, before }), now);
    return { items: rows.length, messages };
  });

  return {
    findItemById,
    findBySource,
    findCollectingAlbum,
    findAlbum,
    getMessages,
    observeQueueSnapshot,
    addAlbumMember,
    addLateAlbumMember,
    insertRecoveredSnapshots,
    finalizeAlbums,
    updateSnapshot,
    listActive,
    getHead,
    claimPublication,
    claimRenewal,
    transition,
    setOperationState,
    setOperationPhase,
    setRenewalUncertain,
    failRenewal,
    operationForItem,
    operationOutputIds,
    operationSourceIds,
    recoverExpiredOperations,
    recordOutput,
    recordReplacementOutput,
    persistPublicationContract,
    beginPublicationTransfer,
    markPartialCleanupPending,
    recordCompleteBaseOutputs,
    markAttributionPending,
    markPublicationOutputComplete,
    markSourceCleanupPending,
    markReplacementOutputsRecorded,
    setDestinationMessageIds,
    installRenewedGeneration,
    setRetry,
    markCompleted,
    completeRenewalWithOrphans,
    markRenewedCleanupComplete,
    markMissing,
    markAdminDeleted,
    retryItem,
    operationEvidence,
    requeueUncertainPublication,
    adoptConfirmedPublicationOutputs,
    resolveUncertainRenewal,
    adoptUncertainRenewalGeneration,
    moveToEnd,
    statusCounts,
    currentSourceIds,
    getCurrentSnapshotSet,
    cloneSnapshotsWithIds,
    listRenewalAges,
    listRecentlyDeletedExternal,
    renewalCandidateOperation,
    setBootId,
    heartbeatOperations,
    redactCompletedBefore,
  };
};

export type PolicyRepository = ReturnType<typeof createPolicyRepository>;

export const createPolicyRepository = (database: AppDatabase) => {
  const isChannelWhitelisted = (chatId: number): boolean => Boolean(database.raw.query("SELECT 1 AS value FROM channel_whitelist WHERE chat_id = ?").get(chatId));

  const upsertChannel = (chatId: number, username: string | undefined, title: string | undefined, adminId: number, now: number): void => database.transaction(() => {
    database.raw.query("INSERT INTO channel_whitelist (chat_id, username, title, added_at, added_by_admin_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, title = excluded.title, updated_at = excluded.updated_at").run(chatId, username ?? null, title ?? null, now, adminId, now);
    database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('whitelist_channel_upserted', ?, ?, ?)").run(String(adminId), JSON.stringify({ chatId, username, title }), now);
  });

  const removeChannel = (chatId: number, adminId: number, now: number): void => database.transaction(() => {
    const result = database.raw.query("DELETE FROM channel_whitelist WHERE chat_id = ?").run(chatId);
    if (Number(result.changes) === 1) database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('whitelist_channel_removed', ?, ?, ?)").run(String(adminId), JSON.stringify({ chatId }), now);
  });

  const listChannels = (): Array<{ chatId: number; username?: string; title?: string }> => {
    const rows = database.raw.query("SELECT chat_id, username, title FROM channel_whitelist ORDER BY chat_id").all() as Array<{ chat_id: number; username: string | null; title: string | null }>;
    return rows.map((row) => {
      const result: { chatId: number; username?: string; title?: string } = { chatId: row.chat_id };
      if (row.username !== null) result.username = row.username;
      if (row.title !== null) result.title = row.title;
      return result;
    });
  };

  const observeAuthor = (origin: SemanticOrigin, now: number): void => {
    if (origin.kind === "hidden_user") {
      database.raw.query(`INSERT INTO known_hidden_authors (sender_name, first_seen_at, last_seen_at)
        VALUES (?, ?, ?) ON CONFLICT(sender_name) DO UPDATE SET last_seen_at = MAX(known_hidden_authors.last_seen_at, excluded.last_seen_at)`)
        .run(origin.senderUserName, now, now);
      return;
    }
    if (origin.kind !== "user") return;
    const normalizedUsername = origin.username?.toLowerCase();
    database.transaction(() => {
      if (normalizedUsername) database.raw.query("UPDATE known_authors SET normalized_username = NULL WHERE normalized_username = ? AND user_id <> ?").run(normalizedUsername, origin.userId);
      database.raw.query("INSERT INTO known_authors (user_id, username, normalized_username, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, normalized_username = excluded.normalized_username, display_name = excluded.display_name, last_seen_at = excluded.last_seen_at").run(origin.userId, origin.username ?? null, normalizedUsername ?? null, origin.displayName, now, now);
    });
  };

  const resolveAuthorId = (userIdOrUsername: number | string): number | undefined => {
    if (typeof userIdOrUsername === "number") {
      const row = database.raw.query("SELECT user_id FROM known_authors WHERE user_id = ?").get(userIdOrUsername) as { user_id: number } | null;
      return row?.user_id;
    }
    const normalized = userIdOrUsername.replace(/^@/, "").toLowerCase();
    const row = database.raw.query("SELECT user_id FROM known_authors WHERE normalized_username = ?").get(normalized) as { user_id: number } | null;
    return row?.user_id;
  };

  const aliasForOrigin = (origin: SemanticOrigin): string | undefined => {
    if (origin.kind === "hidden_user") {
      const row = database.raw.query("SELECT haa.nickname FROM hidden_author_aliases haa JOIN known_hidden_authors kha ON kha.id = haa.hidden_author_id WHERE kha.sender_name = ? COLLATE BINARY").get(origin.senderUserName) as { nickname: string } | null;
      return row?.nickname;
    }
    if (origin.kind !== "user") return undefined;
    const byId = database.raw.query("SELECT nickname FROM author_aliases WHERE user_id = ?").get(origin.userId) as { nickname: string } | null;
    if (byId) return byId.nickname;
    if (!origin.username) return undefined;
    const byUsername = database.raw.query("SELECT aa.nickname FROM author_aliases aa JOIN known_authors ka ON ka.user_id = aa.user_id WHERE ka.normalized_username = ?").get(origin.username.toLowerCase()) as { nickname: string } | null;
    return byUsername?.nickname;
  };

  const updateIdentifiableAuthorItems = (userId: number, revision: number): void => {
    database.raw.query(`UPDATE queue_items
      SET nickname_revision_wanted = ?,
          preparation_state = CASE WHEN representation_kind = 'prepared' AND json_extract(attribution_json, '$.ownership') = 'bot' THEN 'refresh_pending' ELSE preparation_state END
      WHERE status NOT IN ('done','deleted','deleted_external')
        AND json_extract(origin_json, '$.kind') = 'user'
        AND (json_extract(origin_json, '$.userId') = ? OR lower(json_extract(origin_json, '$.username')) = (SELECT normalized_username FROM known_authors WHERE user_id = ?))`)
      .run(revision, userId, userId);
  };

  const setAlias = (userIdOrUsername: number | string, nickname: string, adminId: number, now: number): void => database.transaction(() => {
    const userId = resolveAuthorId(userIdOrUsername);
    if (userId === undefined) throw new Error("Author must be observed before an alias can be set");
    const previous = database.raw.query("SELECT nickname FROM author_aliases WHERE user_id = ?").get(userId) as { nickname: string } | null;
    database.raw.query("INSERT INTO author_aliases (user_id, nickname, updated_at, updated_by_admin_id) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at, updated_by_admin_id = excluded.updated_by_admin_id").run(userId, nickname, now, adminId);
    if (previous?.nickname !== nickname) {
      const revision = (database.raw.query("SELECT alias_revision FROM known_authors WHERE user_id = ?").get(userId) as { alias_revision: number }).alias_revision + 1;
      database.raw.query("UPDATE known_authors SET alias_revision = ? WHERE user_id = ?").run(revision, userId);
      updateIdentifiableAuthorItems(userId, revision);
    }
    database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('author_alias_set', ?, ?, ?)").run(String(adminId), JSON.stringify({ userId, nickname }), now);
  });

  const removeAlias = (userIdOrUsername: number | string, adminId: number, now: number): void => database.transaction(() => {
    const userId = resolveAuthorId(userIdOrUsername);
    if (userId === undefined) return;
    const result = database.raw.query("DELETE FROM author_aliases WHERE user_id = ?").run(userId);
    if (Number(result.changes) === 1) {
      const revision = (database.raw.query("SELECT alias_revision FROM known_authors WHERE user_id = ?").get(userId) as { alias_revision: number }).alias_revision + 1;
      database.raw.query("UPDATE known_authors SET alias_revision = ? WHERE user_id = ?").run(revision, userId);
      updateIdentifiableAuthorItems(userId, revision);
      database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('author_alias_removed', ?, ?, ?)").run(String(adminId), JSON.stringify({ userId, revision }), now);
    }
  });

  const listAuthors = (): Array<{ userId: number; username?: string; displayName: string; alias?: string; lastSeenAt: number }> => {
    const rows = database.raw.query("SELECT ka.user_id, ka.username, ka.display_name, ka.last_seen_at, aa.nickname FROM known_authors ka LEFT JOIN author_aliases aa ON aa.user_id = ka.user_id ORDER BY ka.last_seen_at DESC").all() as Array<{ user_id: number; username: string | null; display_name: string; last_seen_at: number; nickname: string | null }>;
    return rows.map((row) => {
      const result: { userId: number; username?: string; displayName: string; alias?: string; lastSeenAt: number } = { userId: row.user_id, displayName: row.display_name, lastSeenAt: row.last_seen_at };
      if (row.username !== null) result.username = row.username;
      if (row.nickname !== null) result.alias = row.nickname;
      return result;
    });
  };

  const listHiddenAuthors = (limit = 20, offset = 0): Array<{ hiddenAuthorId: number; senderName: string; alias?: string; lastSeenAt: number; aliasRevision: number }> => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid hidden-author page");
    const rows = database.raw.query(`SELECT kha.id, kha.sender_name, kha.last_seen_at, kha.alias_revision, haa.nickname
      FROM known_hidden_authors kha LEFT JOIN hidden_author_aliases haa ON haa.hidden_author_id = kha.id
      ORDER BY kha.last_seen_at DESC, kha.id LIMIT ? OFFSET ?`).all(limit, offset) as Array<{ id: number; sender_name: string; last_seen_at: number; alias_revision: number; nickname: string | null }>;
    return rows.map((row) => ({ hiddenAuthorId: row.id, senderName: row.sender_name, lastSeenAt: row.last_seen_at, aliasRevision: row.alias_revision, ...(row.nickname === null ? {} : { alias: row.nickname }) }));
  };

  const getHiddenAuthor = (hiddenAuthorId: number): { hiddenAuthorId: number; senderName: string; alias?: string; lastSeenAt: number; aliasRevision: number } | undefined => {
    const row = database.raw.query(`SELECT kha.id, kha.sender_name, kha.last_seen_at, kha.alias_revision, haa.nickname
      FROM known_hidden_authors kha LEFT JOIN hidden_author_aliases haa ON haa.hidden_author_id = kha.id WHERE kha.id = ?`).get(hiddenAuthorId) as { id: number; sender_name: string; last_seen_at: number; alias_revision: number; nickname: string | null } | null;
    return row ? { hiddenAuthorId: row.id, senderName: row.sender_name, lastSeenAt: row.last_seen_at, aliasRevision: row.alias_revision, ...(row.nickname === null ? {} : { alias: row.nickname }) } : undefined;
  };

  const countHiddenAuthors = (): number => (database.raw.query("SELECT COUNT(*) AS count FROM known_hidden_authors").get() as { count: number }).count;

  const updateHiddenAuthorItems = (hiddenAuthorId: number, revision: number): void => {
    database.raw.query(`UPDATE queue_items
      SET nickname_revision_wanted = ?,
          preparation_state = CASE WHEN representation_kind = 'prepared' AND json_extract(attribution_json, '$.ownership') = 'bot' THEN 'refresh_pending' ELSE preparation_state END
      WHERE status NOT IN ('done','deleted','deleted_external')
        AND json_extract(origin_json, '$.kind') = 'hidden_user'
        AND json_extract(origin_json, '$.senderUserName') = (SELECT sender_name FROM known_hidden_authors WHERE id = ?)`)
      .run(revision, hiddenAuthorId);
  };

  const setHiddenAlias = (hiddenAuthorId: number, nickname: string, adminId: number, now: number): void => database.transaction(() => {
    const row = database.raw.query("SELECT id, sender_name, alias_revision FROM known_hidden_authors WHERE id = ?").get(hiddenAuthorId) as { id: number; sender_name: string; alias_revision: number } | null;
    if (!row) throw new Error("Hidden sender must be observed before a nickname can be set");
    const previous = database.raw.query("SELECT nickname FROM hidden_author_aliases WHERE hidden_author_id = ?").get(hiddenAuthorId) as { nickname: string } | null;
    database.raw.query(`INSERT INTO hidden_author_aliases (hidden_author_id, nickname, updated_at, updated_by_admin_id)
      VALUES (?, ?, ?, ?) ON CONFLICT(hidden_author_id) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at, updated_by_admin_id = excluded.updated_by_admin_id`)
      .run(hiddenAuthorId, nickname, now, adminId);
    if (previous?.nickname === nickname) return;
    const revision = row.alias_revision + 1;
    database.raw.query("UPDATE known_hidden_authors SET alias_revision = ? WHERE id = ?").run(revision, hiddenAuthorId);
    updateHiddenAuthorItems(hiddenAuthorId, revision);
    database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('hidden_author_alias_set', ?, ?, ?)").run(String(adminId), JSON.stringify({ hiddenAuthorId, senderName: row.sender_name, nickname, revision }), now);
  });

  const removeHiddenAlias = (hiddenAuthorId: number, adminId: number, now: number): void => database.transaction(() => {
    const row = database.raw.query("SELECT id, sender_name, alias_revision FROM known_hidden_authors WHERE id = ?").get(hiddenAuthorId) as { id: number; sender_name: string; alias_revision: number } | null;
    if (!row) return;
    const result = database.raw.query("DELETE FROM hidden_author_aliases WHERE hidden_author_id = ?").run(hiddenAuthorId);
    if (Number(result.changes) === 0) return;
    const revision = row.alias_revision + 1;
    database.raw.query("UPDATE known_hidden_authors SET alias_revision = ? WHERE id = ?").run(revision, hiddenAuthorId);
    updateHiddenAuthorItems(hiddenAuthorId, revision);
    database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('hidden_author_alias_removed', ?, ?, ?)").run(String(adminId), JSON.stringify({ hiddenAuthorId, senderName: row.sender_name, revision }), now);
  });

  return { isChannelWhitelisted, upsertChannel, removeChannel, listChannels, observeAuthor, resolveAuthorId, aliasForOrigin, setAlias, removeAlias, listAuthors, listHiddenAuthors, getHiddenAuthor, countHiddenAuthors, setHiddenAlias, removeHiddenAlias };
};

export type GeneratedMessageRepository = ReturnType<typeof createGeneratedMessageRepository>;

export const createGeneratedMessageRepository = (database: AppDatabase) => {
  const register = (chatId: number, messageIds: readonly number[], operationId: string, kind: "renewal" | "recovery_preview", now: number): void => {
    const statement = database.raw.query("INSERT OR REPLACE INTO generated_messages (chat_id, message_id, operation_id, kind, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, NULL)");
    for (const messageId of messageIds) statement.run(chatId, messageId, operationId, kind, now);
  };
  const consume = (chatId: number, messageId: number): { operationId: string; kind: string } | undefined => {
    const row = database.raw.query("SELECT operation_id, kind FROM generated_messages WHERE chat_id = ? AND message_id = ? AND consumed_at IS NULL").get(chatId, messageId) as { operation_id: string; kind: string } | null;
    if (!row) return undefined;
    database.raw.query("UPDATE generated_messages SET consumed_at = ? WHERE chat_id = ? AND message_id = ? AND consumed_at IS NULL").run(Date.now(), chatId, messageId);
    return { operationId: row.operation_id, kind: row.kind };
  };
  const purge = (before: number): void => { database.raw.query("DELETE FROM generated_messages WHERE created_at < ?").run(before); };
  return { register, consume, purge };
};

export type ScheduleRepository = ReturnType<typeof createScheduleRepository>;

export const createScheduleRepository = (database: AppDatabase) => {
  const slots = (): number[] => (database.raw.query("SELECT minute_of_day FROM schedule_slots ORDER BY minute_of_day").all() as Array<{ minute_of_day: number }>).map((row) => row.minute_of_day);
  const enabled = (): boolean => {
    const row = database.raw.query("SELECT value_json FROM settings WHERE key = 'schedule_enabled'").get() as { value_json: string } | null;
    return row ? JSON.parse(row.value_json) === true : false;
  };
  const setEnabled = (value: boolean, adminId: number, now: number): void => database.transaction(() => {
    validateSlotCount(slots(), value);
    database.raw.query("INSERT INTO settings (key, value_json, updated_at, updated_by_admin_id) VALUES ('schedule_enabled', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by_admin_id = excluded.updated_by_admin_id").run(JSON.stringify(value), now, adminId);
    // Pausing and resuming establish a new scheduler cursor. This prevents a
    // pause or a just-created slot from manufacturing an old missed run.
    database.raw.query("UPDATE app_state SET last_scheduler_scan_at = ? WHERE id = 1").run(now);
    database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('schedule_enabled_changed', ?, ?, ?)").run(String(adminId), JSON.stringify({ enabled: value }), now);
  });
  const addSlot = (minuteOfDay: number, adminId: number, now: number): void => database.transaction(() => {
    validateSlotCount([...slots(), minuteOfDay], enabled());
    if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 1440) throw new Error("Publication slot is out of range");
    const result = database.raw.query("INSERT OR IGNORE INTO schedule_slots (minute_of_day, created_at, created_by_admin_id, effective_at) VALUES (?, ?, ?, ?)").run(minuteOfDay, now, adminId, now);
    if (Number(result.changes) === 1) {
      database.raw.query("INSERT INTO schedule_slot_history (minute_of_day, effective_from, effective_until, actor_admin_id) VALUES (?, ?, NULL, ?)").run(minuteOfDay, now, adminId);
      database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('schedule_slot_added', ?, ?, ?)").run(String(adminId), JSON.stringify({ minuteOfDay }), now);
    }
  });
  const removeSlot = (minuteOfDay: number, adminId = 0, now = Date.now()): void => database.transaction(() => {
    const result = database.raw.query("DELETE FROM schedule_slots WHERE minute_of_day = ?").run(minuteOfDay);
    if (Number(result.changes) === 1) {
      database.raw.query("UPDATE schedule_slot_history SET effective_until = ? WHERE minute_of_day = ? AND effective_until IS NULL").run(now, minuteOfDay);
      database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('schedule_slot_removed', ?, ?, ?)").run(String(adminId), JSON.stringify({ minuteOfDay }), now);
    }
  });
  const materialize = (occurrenceAt: number): boolean => {
    const date = new Date(occurrenceAt);
    const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
    const slot = database.raw.query("SELECT effective_at FROM schedule_slots WHERE minute_of_day = ? AND effective_at < ?").get(minuteOfDay, occurrenceAt) as { effective_at: number } | null;
    if (!slot) return false;
    const result = database.raw.query("INSERT OR IGNORE INTO schedule_runs (occurrence_at, status) VALUES (?, 'pending')").run(occurrenceAt);
    return Number(result.changes) > 0;
  };
  const run = (occurrenceAt: number): { status: string; itemId?: number; operationId?: string } | undefined => {
    const row = database.raw.query("SELECT status, item_id, operation_id FROM schedule_runs WHERE occurrence_at = ?").get(occurrenceAt) as { status: string; item_id: number | null; operation_id: string | null } | null;
    if (!row) return undefined;
    const result: { status: string; itemId?: number; operationId?: string } = { status: row.status };
    if (row.item_id !== null) result.itemId = row.item_id;
    if (row.operation_id !== null) result.operationId = row.operation_id;
    return result;
  };
  const markRun = (occurrenceAt: number, status: string, now: number, itemId?: number, operationId?: string, errorCode?: string): void => {
    database.raw.query("UPDATE schedule_runs SET status = ?, item_id = ?, operation_id = ?, completed_at = ?, error_code = ? WHERE occurrence_at = ? AND status IN ('pending','running')").run(status, itemId ?? null, operationId ?? null, now, errorCode ?? null, occurrenceAt);
  };
  const markRunning = (occurrenceAt: number, now: number): boolean => {
    const result = database.raw.query("UPDATE schedule_runs SET status = 'running', operation_id = NULL, started_at = ? WHERE occurrence_at = ? AND status = 'pending'").run(now, occurrenceAt);
    return Number(result.changes) === 1;
  };
  const recoverInterruptedRuns = (now: number): number => {
    const rows = database.raw.query("SELECT sr.occurrence_at, sr.item_id, sr.operation_id, o.state, o.phase FROM schedule_runs sr LEFT JOIN operations o ON o.id = sr.operation_id WHERE sr.status = 'running'").all() as Array<{ occurrence_at: number; item_id: number | null; operation_id: string | null; state: string | null; phase: string | null }>;
    for (const row of rows) {
      if (row.operation_id !== null && row.state === "done" && row.phase === "completed") {
        markRun(row.occurrence_at, "published", now, row.item_id ?? undefined, row.operation_id);
      } else if (row.operation_id !== null && (row.phase === "output_complete" || row.phase === "source_cleanup_pending")) {
        markRun(row.occurrence_at, "published", now, row.item_id ?? undefined, row.operation_id, "cleanup_pending");
      } else if (row.operation_id !== null && row.phase === "uncertain") {
        markRun(row.occurrence_at, "failed", now, row.item_id ?? undefined, row.operation_id, "uncertain_publish");
      } else {
        markRun(row.occurrence_at, "failed", now, row.item_id ?? undefined, row.operation_id ?? undefined, "startup_recovery");
      }
    }
    return rows.length;
  };
  const lastScan = (): number | undefined => {
    const row = database.raw.query("SELECT last_scheduler_scan_at FROM app_state WHERE id = 1").get() as { last_scheduler_scan_at: number | null };
    return row.last_scheduler_scan_at ?? undefined;
  };
  const setLastScan = (now: number): void => { database.raw.query("UPDATE app_state SET last_scheduler_scan_at = ? WHERE id = 1").run(now); };
  return { slots, enabled, setEnabled, addSlot, removeSlot, materialize, run, markRun, markRunning, recoverInterruptedRuns, lastScan, setLastScan };
};

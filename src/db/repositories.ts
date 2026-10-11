import type { AppDatabase } from "./database";
import { assertStatusTransition, isSourceBearing, type QueueItemRecord } from "../domain/queue-item";
import type { MessageId, QueueItemStatus, SemanticOrigin, StoredMessageSnapshot } from "../types";

type QueueRow = {
  id: number;
  logical_sequence: number;
  queue_chat_id: number;
  media_group_id: string | null;
  first_message_id: number;
  content_type: StoredMessageSnapshot["contentType"];
  origin_json: string;
  status: QueueItemStatus;
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
    origin: JSON.parse(row.origin_json) as SemanticOrigin,
    status: row.status,
    contentVersion: row.content_version,
    sourceGeneration: row.source_generation,
    attempts: row.attempts,
    enqueuedAt: row.enqueued_at,
    physicalCreatedAt: row.physical_created_at,
    destinationMessageIds: row.destination_message_ids_json ? JSON.parse(row.destination_message_ids_json) as MessageId[] : [],
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
  ] as const) if (value !== undefined) item[key as keyof QueueItemRecord] = value as never;
  const stringFields = [
    ["lastErrorCode", optionalString(row.last_error_code)],
    ["lastError", optionalString(row.last_error)],
    ["claimedOperationId", optionalString(row.claimed_operation_id)],
  ] as const;
  for (const [key, value] of stringFields) if (value !== undefined) item[key as keyof QueueItemRecord] = value as never;
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
    snapshot: JSON.parse(row.snapshot_json) as StoredMessageSnapshot,
  };
  if (row.edit_date !== null) result.editDate = row.edit_date;
  return result;
};

const originKey = (origin: SemanticOrigin): string => JSON.stringify(origin);

export type QueueRepository = ReturnType<typeof createQueueRepository>;

export const createQueueRepository = (database: AppDatabase) => {
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
    return database.transaction(() => {
      const existing = findBySource(snapshot.chatId, snapshot.messageId);
      if (existing) {
        const currentSnapshot = getMessages(existing.id).find((message) => message.telegramMessageId === snapshot.messageId)?.snapshot;
        if (currentSnapshot && JSON.stringify({ ...currentSnapshot, editDate: undefined }) !== JSON.stringify({ ...snapshot, editDate: undefined })) {
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

  const addLateAlbumMember = (itemId: number, snapshot: StoredMessageSnapshot): QueueItemRecord => database.transaction(() => {
    const item = findItemById(itemId);
    if (!item || item.mediaGroupId !== snapshot.mediaGroupId || !isSourceBearing(item.status)) throw new Error("Album cannot accept a late member");
    if (!findBySource(snapshot.chatId, snapshot.messageId)) insertSnapshot(itemId, item.sourceGeneration, snapshot);
    database.raw.query("UPDATE queue_items SET status = 'needs_review', content_version = content_version + 1 WHERE id = ?").run(itemId);
    const updated = findItemById(itemId);
    if (!updated) throw new Error("Album disappeared after late member insert");
    return updated;
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

  const updateSnapshot = (chatId: number, messageId: number, snapshot: StoredMessageSnapshot): QueueItemRecord | undefined => database.transaction(() => {
    const item = findBySource(chatId, messageId);
    if (!item || !isSourceBearing(item.status)) return item;
    const current = getMessages(item.id).find((message) => message.telegramMessageId === messageId);
    if (!current) return item;
    database.raw.query("UPDATE queue_messages SET telegram_date = ?, edit_date = ?, snapshot_json = ? WHERE item_id = ? AND source_generation = ? AND telegram_message_id = ?").run(snapshot.telegramDate, snapshot.editDate ?? null, JSON.stringify(snapshot), item.id, item.sourceGeneration, messageId);
    database.raw.query("UPDATE queue_items SET content_version = content_version + 1, content_type = ?, origin_json = ? WHERE id = ?").run(snapshot.contentType, JSON.stringify(snapshot.origin), item.id);
    return findItemById(item.id);
  });

  const listActive = (limit = 100, offset = 0): QueueItemRecord[] => {
    const rows = database.raw.query("SELECT * FROM queue_items WHERE status NOT IN ('done','deleted','deleted_external') ORDER BY logical_sequence LIMIT ? OFFSET ?").all(limit, offset) as QueueRow[];
    return rows.map(rowToItem);
  };

  const getHead = (): QueueItemRecord | undefined => {
    const row = database.raw.query("SELECT * FROM queue_items WHERE status NOT IN ('done','deleted','deleted_external') ORDER BY logical_sequence LIMIT 1").get() as QueueRow | null;
    return row ? rowToItem(row) : undefined;
  };

  const claimPublication = (operationId: string, type: "publish" | "manual_publish", now: number): ClaimedItem | undefined => database.transaction(() => {
    const head = getHead();
    if (!head || head.status !== "queued" || (head.retryNotBefore !== undefined && head.retryNotBefore > now)) return undefined;
    database.raw.query("UPDATE queue_items SET status = 'publishing', claimed_operation_id = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'").run(operationId, now, head.id);
    database.raw.query("INSERT INTO operations (id, type, item_id, state, captured_content_version, captured_source_generation, lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)").run(operationId, type, head.id, head.contentVersion, head.sourceGeneration, operationId, now + 300_000, now, now);
    const claimed = findItemById(head.id);
    if (!claimed) throw new Error("Queue item disappeared during claim");
    return { item: claimed, operationId, capturedContentVersion: head.contentVersion, capturedSourceGeneration: head.sourceGeneration };
  });

  const claimRenewal = (operationId: string, now: number, eligibleBefore: number): ClaimedItem | undefined => database.transaction(() => {
    const row = database.raw.query("SELECT * FROM queue_items WHERE status NOT IN ('done','deleted','deleted_external','collecting','publishing','renewing','published_cleanup_pending','renewed_cleanup_pending') AND physical_created_at <= ? ORDER BY physical_created_at, logical_sequence LIMIT 1").get(eligibleBefore) as QueueRow | null;
    if (!row) return undefined;
    const item = rowToItem(row);
    database.raw.query("UPDATE queue_items SET status = 'renewing', claimed_operation_id = ?, claimed_at = ?, attempts = attempts + 1 WHERE id = ? AND status = ? AND source_generation = ?").run(operationId, now, item.id, item.status, item.sourceGeneration);
    database.raw.query("INSERT INTO operations (id, type, item_id, state, captured_content_version, captured_source_generation, lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, 'renew', ?, 'running', ?, ?, ?, ?, ?, ?)").run(operationId, item.id, item.contentVersion, item.sourceGeneration, operationId, now + 300_000, now, now);
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

  const setOperationState = (operationId: string, state: string, now: number, errorCode?: string, errorJson?: string): void => {
    database.raw.query("UPDATE operations SET state = ?, error_code = ?, error_json = ?, updated_at = ? WHERE id = ?").run(state, errorCode ?? null, errorJson ?? null, now, operationId);
  };

  const operationForItem = (itemId: number): { id: string; state: string; type: string } | undefined => {
    const row = database.raw.query("SELECT id, state, type FROM operations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1").get(itemId) as { id: string; state: string; type: string } | null;
    return row ?? undefined;
  };

  const operationOutputIds = (operationId: string, kind: "destination" | "replacement" | "temporary_preview"): MessageId[] =>
    (database.raw.query("SELECT telegram_message_id FROM operation_outputs WHERE operation_id = ? AND kind = ? ORDER BY ordinal, telegram_message_id").all(operationId, kind) as Array<{ telegram_message_id: number }>).map((row) => row.telegram_message_id as MessageId);

  const recordOutput = (operationId: string, kind: "destination" | "replacement" | "temporary_preview", chatId: number, messageId: number, ordinal: number, now: number): void => {
    database.raw.query("INSERT OR IGNORE INTO operation_outputs (operation_id, kind, chat_id, telegram_message_id, ordinal, recorded_at) VALUES (?, ?, ?, ?, ?, ?)").run(operationId, kind, chatId, messageId, ordinal, now);
  };

  const setDestinationMessageIds = (itemId: number, operationId: string, messageIds: readonly number[], now: number): void => database.transaction(() => {
    const item = findItemById(itemId);
    if (!item || item.claimedOperationId !== operationId) throw new Error("Publication operation lease is no longer owned");
    database.raw.query("UPDATE queue_items SET destination_message_ids_json = ?, status = 'published_cleanup_pending', claimed_at = ? WHERE id = ? AND claimed_operation_id = ?").run(JSON.stringify(messageIds), now, itemId, operationId);
    setOperationState(operationId, "outputs_recorded", now);
  });

  const installRenewedGeneration = (itemId: number, operationId: string, replacementSnapshots: readonly StoredMessageSnapshot[], now: number): number => database.transaction(() => {
    const item = findItemById(itemId);
    if (!item || item.claimedOperationId !== operationId || item.status !== "renewing") throw new Error("Renewal operation lease is no longer owned");
    const nextGeneration = item.sourceGeneration + 1;
    for (const snapshot of replacementSnapshots) insertSnapshot(itemId, nextGeneration, snapshot);
    database.raw.query("UPDATE queue_items SET source_generation = ?, physical_created_at = ?, last_renewed_at = ?, status = 'renewed_cleanup_pending' WHERE id = ? AND claimed_operation_id = ? AND source_generation = ?").run(nextGeneration, now, now, itemId, operationId, item.sourceGeneration);
    setOperationState(operationId, "outputs_recorded", now);
    return nextGeneration;
  });

  const setRetry = (itemId: number, operationId: string, now: number, retryNotBefore: number, errorCode: string, errorText: string): void => database.transaction(() => {
    database.raw.query("UPDATE queue_items SET status = 'queued', retry_not_before = ?, last_error_code = ?, last_error = ?, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ? AND claimed_operation_id = ?").run(retryNotBefore, errorCode, errorText, itemId, operationId);
    setOperationState(operationId, "failed", now, errorCode, JSON.stringify({ message: errorText }));
  });

  const markCompleted = (itemId: number, operationId: string, now: number): void => database.transaction(() => {
    database.raw.query("UPDATE queue_items SET status = 'done', published_at = COALESCE(published_at, ?), completed_at = ?, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ? AND claimed_operation_id = ? AND status = 'published_cleanup_pending'").run(now, now, itemId, operationId);
    setOperationState(operationId, "done", now);
  });

  const markRenewedCleanupComplete = (itemId: number, operationId: string, now: number): void => database.transaction(() => {
    database.raw.query("UPDATE queue_items SET status = 'queued', claimed_operation_id = NULL, claimed_at = NULL, retry_not_before = NULL WHERE id = ? AND claimed_operation_id = ? AND status = 'renewed_cleanup_pending'").run(itemId, operationId);
    setOperationState(operationId, "done", now);
  });

  const markMissing = (itemId: number, operationId: string | undefined, now: number): void => database.transaction(() => {
    database.raw.query("UPDATE queue_items SET status = 'deleted_external', completed_at = ?, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ?").run(now, itemId);
    if (operationId) setOperationState(operationId, "done", now, "source_missing");
  });

  const markAdminDeleted = (itemId: number, now: number): void => {
    database.raw.query("UPDATE queue_items SET status = 'deleted', completed_at = ?, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ? AND status NOT IN ('done','deleted','deleted_external')").run(now, itemId);
  };

  const retryItem = (itemId: number, now: number): void => {
    database.raw.query("UPDATE queue_items SET status = 'queued', retry_not_before = NULL, last_error_code = NULL, last_error = NULL, claimed_operation_id = NULL, claimed_at = NULL WHERE id = ? AND status IN ('blocked','needs_edit','needs_review','uncertain_publish','uncertain_renewal','delete_blocked')").run(itemId);
  };

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

  return {
    findItemById,
    findBySource,
    findCollectingAlbum,
    findAlbum,
    getMessages,
    observeQueueSnapshot,
    addAlbumMember,
    addLateAlbumMember,
    finalizeAlbums,
    updateSnapshot,
    listActive,
    getHead,
    claimPublication,
    claimRenewal,
    transition,
    setOperationState,
    operationForItem,
    operationOutputIds,
    recordOutput,
    setDestinationMessageIds,
    installRenewedGeneration,
    setRetry,
    markCompleted,
    markRenewedCleanupComplete,
    markMissing,
    markAdminDeleted,
    retryItem,
    moveToEnd,
    statusCounts,
    currentSourceIds,
    getCurrentSnapshotSet,
    cloneSnapshotsWithIds,
    listRenewalAges,
  };
};

export type PolicyRepository = ReturnType<typeof createPolicyRepository>;

export const createPolicyRepository = (database: AppDatabase) => {
  const isChannelWhitelisted = (chatId: number): boolean => Boolean(database.raw.query("SELECT 1 AS value FROM channel_whitelist WHERE chat_id = ?").get(chatId));

  const upsertChannel = (chatId: number, username: string | undefined, title: string | undefined, adminId: number, now: number): void => {
    database.raw.query("INSERT INTO channel_whitelist (chat_id, username, title, added_at, added_by_admin_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, title = excluded.title, updated_at = excluded.updated_at").run(chatId, username ?? null, title ?? null, now, adminId, now);
  };

  const removeChannel = (chatId: number): void => { database.raw.query("DELETE FROM channel_whitelist WHERE chat_id = ?").run(chatId); };

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
    if (origin.kind !== "user") return undefined;
    const byId = database.raw.query("SELECT nickname FROM author_aliases WHERE user_id = ?").get(origin.userId) as { nickname: string } | null;
    if (byId) return byId.nickname;
    if (!origin.username) return undefined;
    const byUsername = database.raw.query("SELECT aa.nickname FROM author_aliases aa JOIN known_authors ka ON ka.user_id = aa.user_id WHERE ka.normalized_username = ?").get(origin.username.toLowerCase()) as { nickname: string } | null;
    return byUsername?.nickname;
  };

  const setAlias = (userIdOrUsername: number | string, nickname: string, adminId: number, now: number): void => {
    const userId = resolveAuthorId(userIdOrUsername);
    if (userId === undefined) throw new Error("Author must be observed before an alias can be set");
    database.raw.query("INSERT INTO author_aliases (user_id, nickname, updated_at, updated_by_admin_id) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at, updated_by_admin_id = excluded.updated_by_admin_id").run(userId, nickname, now, adminId);
  };

  const removeAlias = (userIdOrUsername: number | string): void => {
    const userId = resolveAuthorId(userIdOrUsername);
    if (userId !== undefined) database.raw.query("DELETE FROM author_aliases WHERE user_id = ?").run(userId);
  };

  const listAuthors = (): Array<{ userId: number; username?: string; displayName: string; alias?: string; lastSeenAt: number }> => {
    const rows = database.raw.query("SELECT ka.user_id, ka.username, ka.display_name, ka.last_seen_at, aa.nickname FROM known_authors ka LEFT JOIN author_aliases aa ON aa.user_id = ka.user_id ORDER BY ka.last_seen_at DESC").all() as Array<{ user_id: number; username: string | null; display_name: string; last_seen_at: number; nickname: string | null }>;
    return rows.map((row) => {
      const result: { userId: number; username?: string; displayName: string; alias?: string; lastSeenAt: number } = { userId: row.user_id, displayName: row.display_name, lastSeenAt: row.last_seen_at };
      if (row.username !== null) result.username = row.username;
      if (row.nickname !== null) result.alias = row.nickname;
      return result;
    });
  };

  return { isChannelWhitelisted, upsertChannel, removeChannel, listChannels, observeAuthor, resolveAuthorId, aliasForOrigin, setAlias, removeAlias, listAuthors };
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
  const setEnabled = (value: boolean, adminId: number, now: number): void => {
    database.raw.query("INSERT INTO settings (key, value_json, updated_at, updated_by_admin_id) VALUES ('schedule_enabled', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by_admin_id = excluded.updated_by_admin_id").run(JSON.stringify(value), now, adminId);
  };
  const addSlot = (minuteOfDay: number, adminId: number, now: number): void => {
    database.raw.query("INSERT OR IGNORE INTO schedule_slots (minute_of_day, created_at, created_by_admin_id) VALUES (?, ?, ?)").run(minuteOfDay, now, adminId);
  };
  const removeSlot = (minuteOfDay: number): void => { database.raw.query("DELETE FROM schedule_slots WHERE minute_of_day = ?").run(minuteOfDay); };
  const materialize = (occurrenceAt: number): boolean => {
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
  const markRunning = (occurrenceAt: number, operationId: string, now: number): boolean => {
    const result = database.raw.query("UPDATE schedule_runs SET status = 'running', operation_id = ?, started_at = ? WHERE occurrence_at = ? AND status = 'pending'").run(operationId, now, occurrenceAt);
    return Number(result.changes) === 1;
  };
  const lastScan = (): number | undefined => {
    const row = database.raw.query("SELECT last_scheduler_scan_at FROM app_state WHERE id = 1").get() as { last_scheduler_scan_at: number | null };
    return row.last_scheduler_scan_at ?? undefined;
  };
  const setLastScan = (now: number): void => { database.raw.query("UPDATE app_state SET last_scheduler_scan_at = ? WHERE id = 1").run(now); };
  return { slots, enabled, setEnabled, addSlot, removeSlot, materialize, run, markRun, markRunning, lastScan, setLastScan };
};

import type { AppDatabase } from "./database";
import { randomUUID } from "node:crypto";
import { assertStatusTransition, isSourceBearing, type QueueItemRecord } from "../domain/queue-item";
import { validateSlotCount } from "../domain/schedule";
import { validateAttributionDescriptor, validateOrderedMessageIds, validatePreparedMember, validatePreparedPublicationContractV2, validatePreparedRenewalContractV2, validatePublicationContract, validateRenewalExecutionProgress, validateSemanticOrigin, validateStoredMessageSnapshot } from "../domain/validation";
import { inspectInlineCreditEdit } from "../domain/attribution";
import { InvalidTelegramOutputError, OperationConflictError } from "../errors";
import type { DeliveryMode, MaintenanceStatus, MessageId, OperationGuard, OperationOutputRole, OperationPhase, OperationState, PreparedMember, PreparedPublicationContractV2, PreparedRenewalContractV2, PublicationContract, QueueItemStatus, RenewalExecutionGuard, RenewalExecutionProgress, SemanticOrigin, StoredMessageSnapshot } from "../types";

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
  preparation_state: "unprepared" | "preparing" | "ready" | "refresh_pending" | "refreshing" | "failed" | "uncertain";
  representation_kind: "raw" | "prepared";
  delivery_mode: DeliveryMode | null;
  policy_captured_at: number | null;
  prepared_at: number | null;
  preparation_operation_id: string | null;
  nickname_revision_wanted: number;
  nickname_revision_applied: number;
  nickname_revision_wanted_key: string | null;
  nickname_revision_applied_key: string | null;
  editorial_frozen_at: number | null;
  editorial_freeze_reason: "admin_edit" | "admin_delete" | "legacy_edit_evidence" | "legacy_unverified" | null;
  editorial_freeze_message_id: number | null;
  editorial_freeze_update_id: number | null;
  attribution_json: string | null;
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
  member_key: string | null;
  member_role: "content" | "credit";
  member_delivery_mode: DeliveryMode | null;
  album_key: string | null;
  removed_at: number | null;
  removal_reason: string | null;
};

export type QueueMessageRecord = {
  itemId: number;
  sourceGeneration: number;
  queueChatId: number;
  telegramMessageId: MessageId;
  ordinal: number;
  telegramDate: number;
  editDate?: number;
  memberKey?: string;
  memberRole?: "content" | "credit";
  memberDeliveryMode?: DeliveryMode;
  albumKey?: string;
  removedAt?: number;
  removalReason?: string;
  snapshot: StoredMessageSnapshot;
};

export type ClaimedItem = {
  item: QueueItemRecord;
  operationId: string;
  capturedContentVersion: number;
  capturedSourceGeneration: number;
};

export type ResolvedNicknamePolicy = { revisionKey: string; revision: number };
export type UnmatchedEditProvenance = { receivedAt: number; updateId?: number };

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
  if (row.preparation_state !== "unprepared") item.preparationState = row.preparation_state;
  if (row.representation_kind !== "raw") item.representationKind = row.representation_kind;
  if (row.delivery_mode !== null) item.deliveryMode = row.delivery_mode;
  if (row.policy_captured_at !== null) item.policyCapturedAt = row.policy_captured_at;
  if (row.prepared_at !== null) item.preparedAt = row.prepared_at;
  if (row.preparation_operation_id !== null) item.preparationOperationId = row.preparation_operation_id;
  if (row.nickname_revision_wanted > 0) item.nicknameRevisionWanted = row.nickname_revision_wanted;
  if (row.nickname_revision_applied > 0) item.nicknameRevisionApplied = row.nickname_revision_applied;
  if (row.nickname_revision_wanted_key !== null) item.nicknameRevisionWantedKey = row.nickname_revision_wanted_key;
  if (row.nickname_revision_applied_key !== null) item.nicknameRevisionAppliedKey = row.nickname_revision_applied_key;
  if (row.editorial_frozen_at !== null) {
    if (!Number.isSafeInteger(row.editorial_frozen_at) || row.editorial_frozen_at < 0) throw new Error("Stored editorial freeze timestamp is invalid");
    item.editorialFrozenAt = row.editorial_frozen_at;
  }
  if (row.editorial_freeze_reason !== null) item.editorialFreezeReason = row.editorial_freeze_reason;
  if (row.editorial_freeze_message_id !== null) {
    if (!Number.isSafeInteger(row.editorial_freeze_message_id) || row.editorial_freeze_message_id <= 0) throw new Error("Stored editorial freeze message ID is invalid");
    item.editorialFreezeMessageId = row.editorial_freeze_message_id as MessageId;
  }
  if (row.editorial_freeze_update_id !== null) {
    if (!Number.isSafeInteger(row.editorial_freeze_update_id) || row.editorial_freeze_update_id < 0) throw new Error("Stored editorial freeze update ID is invalid");
    item.editorialFreezeUpdateId = row.editorial_freeze_update_id;
  }
  if (row.attribution_json !== null) item.attribution = validateAttributionDescriptor(JSON.parse(row.attribution_json) as unknown);
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
  if (row.member_key !== null) result.memberKey = row.member_key;
  result.memberRole = row.member_role;
  if (row.member_delivery_mode !== null) result.memberDeliveryMode = row.member_delivery_mode;
  if (row.album_key !== null) result.albumKey = row.album_key;
  if (row.removed_at !== null) result.removedAt = row.removed_at;
  if (row.removal_reason !== null) result.removalReason = row.removal_reason;
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
    const nativeOrigin = snapshot.nativeOrigin ?? snapshot.origin;
    const mode: DeliveryMode = nativeOrigin.kind === "absent" ? "copy" : "forward";
    database.raw.query(`INSERT INTO queue_messages (item_id, source_generation, queue_chat_id, telegram_message_id, ordinal, telegram_date, edit_date, snapshot_json, member_key, member_role, member_delivery_mode, album_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'content', ?, ?)`).run(
      itemId,
      generation,
      snapshot.chatId,
      snapshot.messageId,
      snapshot.ordinal,
      snapshot.telegramDate,
      snapshot.editDate ?? null,
      JSON.stringify(snapshot),
      `legacy:${snapshot.messageId}`,
      mode,
      snapshot.mediaGroupId ?? null,
    );
  };

  const insertPreparedMember = (itemId: number, generation: number, value: PreparedMember): void => {
    const member = validatePreparedMember(value, "renewal.member");
    const snapshot = validateStoredMessageSnapshot(member.snapshot);
    database.raw.query(`INSERT INTO queue_messages (item_id, source_generation, queue_chat_id, telegram_message_id, ordinal, telegram_date, edit_date, snapshot_json, member_key, member_role, member_delivery_mode, album_key, removed_at, removal_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(
      itemId, generation, snapshot.chatId, member.messageId, snapshot.ordinal, snapshot.telegramDate, snapshot.editDate ?? null,
      JSON.stringify(snapshot), member.memberKey, member.role, member.deliveryMode, member.albumKey ?? null,
    );
  };

  const toPreparedMember = (message: QueueMessageRecord): PreparedMember => {
    if (!message.memberKey) throw new Error(`Queue member ${message.telegramMessageId} has no stable member key`);
    const nativeOrigin = message.snapshot.nativeOrigin ?? message.snapshot.origin;
    const member: PreparedMember = {
      memberKey: message.memberKey,
      messageId: message.telegramMessageId,
      role: message.memberRole ?? "content",
      deliveryMode: message.memberDeliveryMode ?? (nativeOrigin.kind === "absent" ? "copy" : "forward"),
      snapshot: message.snapshot,
    };
    if (message.albumKey !== undefined) member.albumKey = message.albumKey;
    return member;
  };

  const getCurrentMembers = (itemId: number): PreparedMember[] => {
    const item = findItemById(itemId);
    if (!item) return [];
    return getMessages(itemId, item.sourceGeneration).filter((message) => message.removedAt === undefined).map(toPreparedMember);
  };

  const getCapturedMembers = (itemId: number, generation: number, capturedMessageIds: readonly number[]): PreparedMember[] => {
    if (capturedMessageIds.length === 0) return [];
    if (capturedMessageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Captured message IDs must be positive safe integers");
    const placeholders = capturedMessageIds.map(() => "?").join(",");
    const rows = database.raw.query(`SELECT * FROM queue_messages WHERE item_id = ? AND source_generation = ? AND telegram_message_id IN (${placeholders}) ORDER BY ordinal, telegram_message_id`).all(itemId, generation, ...capturedMessageIds) as QueueMessageRow[];
    if (rows.length !== new Set(capturedMessageIds).size) throw new Error("A captured queue member is missing");
    return rows.map(messageRowToRecord).map(toPreparedMember);
  };

  const findKnownSource = (queueChatId: number, messageId: number): { itemId: number; generation: number; current: boolean; removed: boolean } | undefined => {
    const row = database.raw.query(`SELECT qm.item_id, qm.source_generation, qm.removed_at, qi.source_generation AS current_generation
      FROM queue_messages qm JOIN queue_items qi ON qi.id = qm.item_id
      WHERE qm.queue_chat_id = ? AND qm.telegram_message_id = ?`)
      .get(queueChatId, messageId) as { item_id: number; source_generation: number; removed_at: number | null; current_generation: number } | null;
    return row ? { itemId: row.item_id, generation: row.source_generation, current: row.source_generation === row.current_generation, removed: row.removed_at !== null } : undefined;
  };

  const observeQueueSnapshot = (
    snapshot: StoredMessageSnapshot,
    now: number,
    deliveryMode?: DeliveryMode,
    policyCapturedAt?: number,
    resolveInitialPolicy?: () => ResolvedNicknamePolicy,
    unmatchedEdit?: UnmatchedEditProvenance,
  ): { item: QueueItemRecord; inserted: boolean } => {
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
      const policy = resolveInitialPolicy?.();
      const defaultKey = snapshot.origin.kind === "user" || snapshot.origin.kind === "hidden_user" ? null : "none";
      const result = database.raw.query(`INSERT INTO queue_items (
        logical_sequence, queue_chat_id, media_group_id, first_message_id, content_type, origin_json, status,
        enqueued_at, physical_created_at, album_quiet_deadline, album_max_deadline, delivery_mode, policy_captured_at,
        nickname_revision_wanted, nickname_revision_wanted_key, editorial_frozen_at, editorial_freeze_reason,
        editorial_freeze_message_id, editorial_freeze_update_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
        deliveryMode ?? null,
        deliveryMode === undefined ? null : (policyCapturedAt ?? now),
        policy?.revision ?? 0,
        policy?.revisionKey ?? defaultKey,
        unmatchedEdit?.receivedAt ?? null,
        unmatchedEdit === undefined ? null : "admin_edit",
        unmatchedEdit === undefined ? null : snapshot.messageId,
        unmatchedEdit?.updateId ?? null,
      );
      const itemId = Number(result.lastInsertRowid);
      insertSnapshot(itemId, 0, snapshot);
      if (unmatchedEdit) database.raw.query("UPDATE pending_queue_updates SET state = 'ingested', candidate_operation_id = NULL, last_error = NULL WHERE queue_chat_id = ? AND telegram_message_id = ? AND state IN ('pending','quarantined_renewal_candidate')").run(snapshot.chatId, snapshot.messageId);
      const item = findItemById(itemId);
      if (!item) throw new Error("Queue item disappeared after insert");
      return { item, inserted: true };
    });
  };

  const addAlbumMember = (itemId: number, snapshot: StoredMessageSnapshot, now: number, resolveInitialPolicy?: () => ResolvedNicknamePolicy): QueueItemRecord => {
    snapshot = validateStoredMessageSnapshot(snapshot);
    return database.transaction(() => {
      const item = findItemById(itemId);
      if (!item || item.status !== "collecting") throw new Error("Album is no longer collecting");
      if (item.mediaGroupId !== snapshot.mediaGroupId) throw new Error("Album media group does not match");
      if (!findBySource(snapshot.chatId, snapshot.messageId)) {
        insertSnapshot(itemId, item.sourceGeneration, snapshot);
        const policy = resolveInitialPolicy?.();
        if (policy && item.editorialFrozenAt === undefined) database.raw.query("UPDATE queue_items SET nickname_revision_wanted = CASE WHEN nickname_revision_wanted_key = ? THEN MAX(nickname_revision_wanted, ?) ELSE ? END, nickname_revision_wanted_key = ? WHERE id = ? AND editorial_frozen_at IS NULL").run(policy.revisionKey, policy.revision, policy.revision, policy.revisionKey, itemId);
      }
      database.raw.query("UPDATE queue_items SET album_quiet_deadline = MIN(COALESCE(album_max_deadline, ?), ?) WHERE id = ? AND status = 'collecting'").run(now + 10_000, now + 2_000, itemId);
      const updated = findItemById(itemId);
      if (!updated) throw new Error("Album disappeared after member insert");
      return updated;
    });
  };

  const reconcileNicknamePolicy = (itemId: number, policy: ResolvedNicknamePolicy): QueueItemRecord | undefined => {
    if (!policy.revisionKey || !Number.isSafeInteger(policy.revision) || policy.revision < 0) throw new Error("Resolved nickname policy is invalid");
    return database.transaction(() => {
      database.raw.query(`UPDATE queue_items SET
        nickname_revision_wanted = CASE WHEN nickname_revision_wanted_key = ? THEN MAX(nickname_revision_wanted, ?) ELSE ? END,
        nickname_revision_wanted_key = ?,
        preparation_state = CASE WHEN representation_kind = 'prepared' AND json_extract(attribution_json, '$.ownership') = 'bot'
          AND (COALESCE(nickname_revision_applied_key, '') <> ? OR nickname_revision_applied <> ?) THEN 'refresh_pending' ELSE preparation_state END
        WHERE id = ? AND status NOT IN ('done','deleted','deleted_external') AND editorial_frozen_at IS NULL`)
        .run(policy.revisionKey, policy.revision, policy.revision, policy.revisionKey, policy.revisionKey, policy.revision, itemId);
      return findItemById(itemId);
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

  const insertRecoveredSnapshots = (snapshots: readonly StoredMessageSnapshot[], now: number, options: { creditLast?: boolean } = {}): QueueItemRecord => database.transaction(() => {
    snapshots = snapshots.map((snapshot) => validateStoredMessageSnapshot(snapshot));
    if (snapshots.length < 1 || snapshots.length > 10) throw new Error("Recovered item must contain 1–10 snapshots");
    const first = snapshots[0]!;
    if (snapshots.some((snapshot, ordinal) => snapshot.chatId !== first.chatId || snapshot.ordinal !== ordinal)) throw new Error("Recovered snapshots are not an ordered queue bundle");
    if (options.creditLast && (snapshots.length < 2 || snapshots.at(-1)?.contentType !== "text" || snapshots.at(-1)?.text === undefined || snapshots.at(-1)?.mediaGroupId !== undefined)) throw new Error("A separate recovered credit must be a standalone text message after its content");
    for (const snapshot of snapshots) if (findBySource(snapshot.chatId, snapshot.messageId)) throw new Error(`Queue message ${snapshot.messageId} is already known`);
    const lastSequence = database.raw.query("SELECT COALESCE(MAX(logical_sequence), 0) AS value FROM queue_items").get() as { value: number };
    const sameOrigin = snapshots.every((snapshot) => originKey(snapshot.origin) === originKey(first.origin));
    const itemOrigin = sameOrigin ? first.origin : { kind: "absent" as const };
    const sharedAlbum = snapshots.length > 1 && first.mediaGroupId !== undefined && snapshots.every((snapshot) => snapshot.mediaGroupId === first.mediaGroupId);
    const mediaGroupId = sharedAlbum ? first.mediaGroupId : undefined;
    const preparedMembers = options.creditLast ? snapshots.slice(0, -1) : snapshots;
    const result = database.raw.query(`INSERT INTO queue_items (logical_sequence, queue_chat_id, media_group_id, first_message_id, content_type, origin_json, status, enqueued_at, physical_created_at, preparation_state, representation_kind, delivery_mode, policy_captured_at, prepared_at, attribution_json)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 'ready', 'prepared', 'copy', ?, ?, '{"ownership":"none"}')`)
      .run(lastSequence.value + 1, first.chatId, mediaGroupId ?? null, preparedMembers[0]!.messageId, preparedMembers[0]!.contentType, JSON.stringify(itemOrigin), now, first.telegramDate, now, now);
    const itemId = Number(result.lastInsertRowid);
    for (const snapshot of snapshots) insertSnapshot(itemId, 0, snapshot);
    if (options.creditLast) {
      const credit = snapshots.at(-1)!;
      database.raw.query("UPDATE queue_messages SET member_role = 'credit', member_delivery_mode = 'copy', album_key = NULL WHERE item_id = ? AND source_generation = 0 AND telegram_message_id = ?").run(itemId, credit.messageId);
      database.raw.query("UPDATE queue_items SET attribution_json = ? WHERE id = ?").run(JSON.stringify({ ownership: "admin", previousMemberKey: `legacy:${credit.messageId}` }), itemId);
    }
    const item = findItemById(itemId);
    if (!item) throw new Error("Recovered queue item disappeared after insert");
    return item;
  });

  const reprocessRecoveredItem = (itemId: number, deliveryMode: DeliveryMode, policyCapturedAt: number, now: number): void => database.transaction(() => {
    const result = database.raw.query(`UPDATE queue_items SET representation_kind = 'raw', preparation_state = 'unprepared', delivery_mode = ?, policy_captured_at = ?, prepared_at = NULL,
      content_version = content_version + 1, last_error_code = NULL, last_error = NULL
      WHERE id = ? AND status = 'queued' AND representation_kind = 'prepared' AND editorial_frozen_at IS NULL AND preparation_operation_id IS NULL AND claimed_operation_id IS NULL AND maintenance_status = 'idle'
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.item_id = queue_items.id AND o.state IN ('running','outputs_recorded','cleanup_pending','uncertain'))`)
      .run(deliveryMode, policyCapturedAt, itemId);
    if (Number(result.changes) !== 1) throw conflict("Recovered item changed or is currently owned by another operation");
    database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, metadata_json, created_at) VALUES ('recovered_item_preparation_requested', 'admin', ?, ?, ?)").run(itemId, JSON.stringify({ deliveryMode, policyCapturedAt }), now);
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

  type AdminEditAcceptance =
    | { kind: "accepted"; item: QueueItemRecord }
    | { kind: "collision"; item: QueueItemRecord; operationId?: string }
    | { kind: "stale"; item: QueueItemRecord }
    | { kind: "obsolete"; itemId: number }
    | { kind: "unknown" };

  const acceptAdminQueueEdit = (input: { chatId: number; messageId: number; snapshot: StoredMessageSnapshot; updateId?: number; receivedAt: number; pendingUpdate?: boolean }): AdminEditAcceptance => {
    const snapshot = validateStoredMessageSnapshot(input.snapshot);
    if (!Number.isSafeInteger(input.chatId) || !Number.isSafeInteger(input.messageId) || input.messageId <= 0 || !Number.isSafeInteger(input.receivedAt) || input.receivedAt < 0) throw new Error("Admin edit identity or timestamp is invalid");
    if (Number(snapshot.chatId) !== input.chatId || Number(snapshot.messageId) !== input.messageId) throw new Error("Admin edit snapshot does not match its source identity");
    const updateId = input.updateId ?? snapshot.telegramUpdateId;
    if (updateId !== undefined && (!Number.isSafeInteger(updateId) || updateId < 0)) throw new Error("Admin edit update ID is invalid");
    return database.transaction(() => {
      const known = findKnownSource(input.chatId, input.messageId);
      if (!known) return { kind: "unknown" };
      if (!known.current || known.removed) return { kind: "obsolete", itemId: known.itemId };
      const item = findItemById(known.itemId);
      const current = getMessages(known.itemId, known.generation).find((message) => message.telegramMessageId === input.messageId);
      if (!item || !current || !isSourceBearing(item.status)) return { kind: "obsolete", itemId: known.itemId };
      const priorUpdateId = current.snapshot.telegramUpdateId;
      if (current.editDate !== undefined && snapshot.editDate !== undefined) {
        if (snapshot.editDate < current.editDate) return { kind: "stale", item };
        if (snapshot.editDate === current.editDate && updateId !== undefined && priorUpdateId !== undefined && updateId <= priorUpdateId) return { kind: "stale", item };
        if (snapshot.editDate === current.editDate && (updateId === undefined || priorUpdateId === undefined)) return { kind: "stale", item };
      }
      if (updateId !== undefined && priorUpdateId !== undefined && updateId <= priorUpdateId) return { kind: "stale", item };

      const persistedSnapshot = validateStoredMessageSnapshot({ ...snapshot, origin: current.snapshot.origin, ...(updateId === undefined ? {} : { telegramUpdateId: updateId }) });
      let attribution = item.attribution ?? { ownership: "none" as const };
      if (attribution.ownership === "bot" && attribution.memberKey === current.memberKey) {
        if (attribution.placement === "separate") {
          if (persistedSnapshot.text !== attribution.generatedText) attribution = { ownership: "admin", previousMemberKey: attribution.memberKey };
        } else {
          const latest = attribution.placement === "inline_text" ? persistedSnapshot.text : persistedSnapshot.caption;
          const inspected = inspectInlineCreditEdit(attribution, latest);
          const generatedStart = (latest?.length ?? 0) - attribution.generatedText.length;
          const entities = attribution.placement === "inline_text" ? persistedSnapshot.entities : persistedSnapshot.captionEntities;
          const generatedFormattingChanged = inspected.decision === "preserve_bot_ownership" && entities?.some((entity) => entity.offset + entity.length > generatedStart);
          attribution = generatedFormattingChanged ? { ownership: "admin", previousMemberKey: attribution.memberKey } : inspected.attribution;
        }
      }

      const preparation = item.preparationOperationId === undefined ? null : database.raw.query("SELECT id, phase, state FROM queue_preparation_operations WHERE id = ? AND item_id = ?").get(item.preparationOperationId, item.id) as { id: string; phase: string; state: string } | null;
      const preparedOutputCount = preparation ? (database.raw.query("SELECT COUNT(*) AS count FROM queue_preparation_outputs WHERE operation_id = ?").get(preparation.id) as { count: number }).count : 0;
      const requestMayHaveStarted = preparation && (preparedOutputCount > 0 || ["transfer_pending","attribution_pending","source_cleanup_pending"].includes(preparation.phase)
        || Boolean(database.raw.query("SELECT 1 AS found FROM operation_request_attempts WHERE operation_id = ? AND state IN ('in_flight','accepted','unknown') LIMIT 1").get(preparation.id)));
      const publication = item.claimedOperationId === undefined ? null : database.raw.query("SELECT id, state, phase FROM operations WHERE id = ? AND item_id = ?").get(item.claimedOperationId, item.id) as { id: string; state: string; phase: string } | null;
      const publicationMayHaveStarted = publication && (publication.phase !== "claimed" || publication.state === "outputs_recorded" || publication.state === "cleanup_pending"
        || Boolean(database.raw.query("SELECT 1 AS found FROM operation_request_attempts WHERE operation_id = ? AND state IN ('in_flight','accepted','unknown') LIMIT 1").get(publication.id)));
      const renewal = item.maintenanceOperationId === undefined ? null : database.raw.query("SELECT id, state, phase FROM operations WHERE id = ? AND item_id = ? AND type = 'renew'").get(item.maintenanceOperationId, item.id) as { id: string; state: string; phase: string } | null;
      const renewalMayHaveStarted = renewal && (renewal.phase !== "claimed" || renewal.state === "outputs_recorded" || renewal.state === "cleanup_pending" || renewal.state === "uncertain"
        || Boolean(database.raw.query("SELECT 1 AS found FROM operation_outputs WHERE operation_id = ? LIMIT 1").get(renewal.id))
        || Boolean(database.raw.query("SELECT 1 AS found FROM operation_request_attempts WHERE operation_id = ? AND state IN ('in_flight','accepted','unknown') LIMIT 1").get(renewal.id)));
      const collision = Boolean(requestMayHaveStarted || publicationMayHaveStarted || renewalMayHaveStarted);

      database.raw.query("UPDATE queue_messages SET telegram_date = ?, edit_date = ?, snapshot_json = ? WHERE item_id = ? AND source_generation = ? AND telegram_message_id = ? AND removed_at IS NULL")
        .run(persistedSnapshot.telegramDate, persistedSnapshot.editDate ?? null, JSON.stringify(persistedSnapshot), item.id, item.sourceGeneration, input.messageId);
      database.raw.query(`UPDATE queue_generated_events SET state = 'obsolete', matched_at = ?
        WHERE chat_id = ? AND message_id = ? AND event_kind = 'edit' AND state = 'pending'`)
        .run(input.receivedAt, input.chatId, input.messageId);

      let operationId: string | undefined;
      if (preparation) {
        operationId = preparation.id;
        if (collision) {
          database.raw.query("UPDATE queue_preparation_operations SET state = 'uncertain', phase = 'admin_edit_collision', error_code = 'admin_edit_collision', error_json = ?, updated_at = ? WHERE id = ? AND state IN ('running','outputs_recorded','cleanup_pending')")
            .run(JSON.stringify({ messageId: input.messageId }), input.receivedAt, preparation.id);
        } else {
          database.raw.query("UPDATE queue_preparation_operations SET state = 'failed', phase = 'admin_edit_superseded', error_code = 'admin_edit_superseded', error_json = ?, updated_at = ? WHERE id = ? AND state IN ('running','outputs_recorded')")
            .run(JSON.stringify({ messageId: input.messageId }), input.receivedAt, preparation.id);
        }
      }
      if (publication && collision) {
        operationId = publication.id;
        database.raw.query("UPDATE operations SET state = 'uncertain', phase = 'admin_edit_collision', error_code = 'admin_edit_collision', error_json = ?, updated_at = ? WHERE id = ? AND state IN ('running','outputs_recorded','cleanup_pending')")
          .run(JSON.stringify({ messageId: input.messageId }), input.receivedAt, publication.id);
      } else if (publication) {
        operationId = publication.id;
        database.raw.query("UPDATE operations SET state = 'failed', phase = 'admin_edit_superseded', error_code = 'admin_edit_superseded', error_json = ?, updated_at = ? WHERE id = ? AND state = 'running'")
          .run(JSON.stringify({ messageId: input.messageId }), input.receivedAt, publication.id);
      }
      if (renewal && renewalMayHaveStarted) {
        operationId = renewal.id;
        database.raw.query("UPDATE operations SET state = 'uncertain', phase = 'admin_edit_collision', error_code = 'admin_edit_collision', error_json = ?, updated_at = ? WHERE id = ? AND state IN ('running','outputs_recorded','cleanup_pending')")
          .run(JSON.stringify({ messageId: input.messageId }), input.receivedAt, renewal.id);
      } else if (renewal) {
        operationId = renewal.id;
        database.raw.query("UPDATE operations SET state = 'failed', phase = 'admin_edit_superseded', error_code = 'admin_edit_superseded', error_json = ?, updated_at = ? WHERE id = ? AND state = 'running'")
          .run(JSON.stringify({ messageId: input.messageId }), input.receivedAt, renewal.id);
      }

      const frozenAt = item.editorialFrozenAt ?? input.receivedAt;
      const nextStatus: QueueItemStatus = collision ? "needs_review" : ["blocked","needs_edit","needs_review","publishing"].includes(item.status) ? "queued" : item.status;
      const nextPreparationState = collision ? "uncertain" : item.representationKind === "prepared" ? "ready" : "unprepared";
      const changed = database.raw.query(`UPDATE queue_items SET content_version = content_version + 1, content_type = ?, status = ?,
        preparation_state = ?, preparation_operation_id = NULL, claimed_operation_id = CASE WHEN ? = 1 THEN claimed_operation_id ELSE NULL END,
        maintenance_status = CASE WHEN ? = 1 AND ? IS NOT NULL THEN 'uncertain_renewal' WHEN ? IS NOT NULL THEN 'idle' ELSE maintenance_status END,
        maintenance_operation_id = CASE WHEN ? = 1 AND ? IS NOT NULL THEN maintenance_operation_id WHEN ? IS NOT NULL THEN NULL ELSE maintenance_operation_id END,
        editorial_frozen_at = COALESCE(editorial_frozen_at, ?),
        editorial_freeze_reason = COALESCE(editorial_freeze_reason, 'admin_edit'),
        editorial_freeze_message_id = COALESCE(editorial_freeze_message_id, ?),
        editorial_freeze_update_id = COALESCE(editorial_freeze_update_id, ?),
        attribution_json = ?, retry_not_before = NULL, last_error_code = ?, last_error = ?
        WHERE id = ? AND source_generation = ? AND content_version = ?`)
        .run(persistedSnapshot.contentType, nextStatus, nextPreparationState, collision ? 1 : 0,
          renewalMayHaveStarted ? 1 : 0, renewal ? 1 : null, renewal ? 1 : null,
          renewalMayHaveStarted ? 1 : 0, renewal ? 1 : null, renewal ? 1 : null,
          frozenAt, input.messageId, updateId ?? null, JSON.stringify(attribution), collision ? "admin_edit_collision" : null, collision ? "An admin edit collided with a started remote operation; review the preserved output evidence" : null,
          item.id, item.sourceGeneration, item.contentVersion);
      if (Number(changed.changes) !== 1) return { kind: "stale", item: findItemById(item.id) ?? item };
      if (input.pendingUpdate) database.raw.query("UPDATE pending_queue_updates SET state = 'ingested', candidate_operation_id = NULL, last_error = NULL WHERE queue_chat_id = ? AND telegram_message_id = ? AND state IN ('pending','quarantined_renewal_candidate')").run(input.chatId, input.messageId);
      database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES (?, 'admin', ?, ?, ?, ?)")
        .run(collision ? "admin_edit_operation_collision" : "admin_queue_edit_accepted", item.id, operationId ?? null, JSON.stringify({ messageId: input.messageId, updateId, freezeReason: item.editorialFreezeReason ?? "admin_edit" }), input.receivedAt);
      const updated = findItemById(item.id);
      if (!updated) throw new Error("Edited queue item disappeared after acceptance");
      return collision ? { kind: "collision", item: updated, ...(operationId === undefined ? {} : { operationId }) } : { kind: "accepted", item: updated };
    });
  };

  const updateSnapshot = (chatId: number, messageId: number, snapshot: StoredMessageSnapshot): QueueItemRecord | undefined => {
    const result = acceptAdminQueueEdit({ chatId, messageId, snapshot, receivedAt: snapshot.editDate ?? Date.now(), ...(snapshot.telegramUpdateId === undefined ? {} : { updateId: snapshot.telegramUpdateId }) });
    return "item" in result ? result.item : undefined;
  };

  const acceptProvisionalPreparationEdit = (input: { chatId: number; messageId: number; snapshot: StoredMessageSnapshot; receivedAt: number; updateId?: number; pendingUpdate?: boolean }): { kind: "collision" | "unknown"; itemId?: number; operationId?: string } => {
    const snapshot = validateStoredMessageSnapshot(input.snapshot);
    if (!Number.isSafeInteger(input.chatId) || !Number.isSafeInteger(input.messageId) || input.messageId <= 0 || !Number.isSafeInteger(input.receivedAt) || input.receivedAt < 0) throw new Error("Provisional edit identity or timestamp is invalid");
    const updateId = input.updateId ?? snapshot.telegramUpdateId;
    if (updateId !== undefined && (!Number.isSafeInteger(updateId) || updateId < 0)) throw new Error("Provisional edit update ID is invalid");
    return database.transaction(() => {
      const row = database.raw.query(`SELECT qpo.id AS operation_id, qpo.item_id, qpo.state AS operation_state, qi.editorial_frozen_at
        FROM queue_preparation_outputs po JOIN queue_preparation_operations qpo ON qpo.id = po.operation_id
        JOIN queue_items qi ON qi.id = qpo.item_id
        WHERE po.chat_id = ? AND po.telegram_message_id = ?
          AND qpo.state IN ('running','outputs_recorded','cleanup_pending','uncertain')
          AND qi.status NOT IN ('done','deleted','deleted_external') LIMIT 1`)
        .get(input.chatId, input.messageId) as { operation_id: string; item_id: number; operation_state: string; editorial_frozen_at: number | null } | null;
      if (!row) return { kind: "unknown" };
      const currentOutput = database.raw.query("SELECT snapshot_json FROM queue_preparation_outputs WHERE operation_id = ? AND chat_id = ? AND telegram_message_id = ?").get(row.operation_id, input.chatId, input.messageId) as { snapshot_json: string | null } | null;
      if (currentOutput?.snapshot_json) {
        try {
          const prior = validateStoredMessageSnapshot(JSON.parse(currentOutput.snapshot_json) as unknown);
          if (prior.editDate !== undefined && snapshot.editDate !== undefined && snapshot.editDate < prior.editDate) return { kind: "unknown" };
          if (prior.editDate === snapshot.editDate && prior.telegramUpdateId !== undefined && updateId !== undefined && updateId <= prior.telegramUpdateId) return { kind: "unknown" };
        } catch {
          // The incoming validated edit is still retained as collision evidence.
        }
      }
      const persisted = validateStoredMessageSnapshot({ ...snapshot, ...(updateId === undefined ? {} : { telegramUpdateId: updateId }) });
      database.raw.query("UPDATE queue_preparation_outputs SET snapshot_json = ? WHERE operation_id = ? AND chat_id = ? AND telegram_message_id = ?")
        .run(JSON.stringify(persisted), row.operation_id, input.chatId, input.messageId);
      database.raw.query("UPDATE queue_preparation_operations SET state = 'uncertain', phase = 'admin_edit_collision', error_code = 'admin_edit_collision', error_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ messageId: input.messageId }), input.receivedAt, row.operation_id);
      database.raw.query(`UPDATE queue_items SET status = 'needs_review', preparation_state = 'uncertain', preparation_operation_id = NULL,
        content_version = content_version + 1, editorial_frozen_at = COALESCE(editorial_frozen_at, ?),
        editorial_freeze_reason = COALESCE(editorial_freeze_reason, 'admin_edit'),
        editorial_freeze_message_id = COALESCE(editorial_freeze_message_id, ?),
        editorial_freeze_update_id = COALESCE(editorial_freeze_update_id, ?), last_error_code = 'admin_edit_collision',
        last_error = 'An admin edit collided with a provisional prepared output; review the preserved message evidence'
        WHERE id = ? AND status NOT IN ('done','deleted','deleted_external')`)
        .run(input.receivedAt, input.messageId, updateId ?? null, row.item_id);
      database.raw.query("UPDATE queue_generated_events SET state = 'obsolete', matched_at = ? WHERE chat_id = ? AND message_id = ? AND event_kind = 'edit' AND state = 'pending'")
        .run(input.receivedAt, input.chatId, input.messageId);
      if (input.pendingUpdate) database.raw.query("UPDATE pending_queue_updates SET state = 'ingested', candidate_operation_id = ?, last_error = NULL WHERE queue_chat_id = ? AND telegram_message_id = ? AND state IN ('pending','quarantined_renewal_candidate')").run(row.operation_id, input.chatId, input.messageId);
      database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES ('admin_edit_provisional_output_collision', 'admin', ?, ?, ?, ?)")
        .run(row.item_id, row.operation_id, JSON.stringify({ messageId: input.messageId, updateId }), input.receivedAt);
      return { kind: "collision", itemId: row.item_id, operationId: row.operation_id };
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

  const readyPublicationQuery = (now: number, excludedIds: readonly number[] = []): { sql: string; args: number[] } => {
    const excluded = excludedIds.length > 0 ? ` AND qi.id NOT IN (${excludedIds.map(() => "?").join(",")})` : "";
    return {
      sql: `SELECT qi.* FROM queue_items qi
        WHERE qi.status = 'queued' AND qi.preparation_state = 'ready' AND qi.representation_kind = 'prepared'
          AND qi.preparation_operation_id IS NULL AND qi.maintenance_status = 'idle'
          AND (qi.retry_not_before IS NULL OR qi.retry_not_before <= ?)
          AND (qi.editorial_frozen_at IS NOT NULL OR
            (qi.nickname_revision_wanted_key IS NOT NULL AND qi.nickname_revision_applied_key = qi.nickname_revision_wanted_key AND qi.nickname_revision_applied = qi.nickname_revision_wanted) OR
            (qi.nickname_revision_wanted_key IS NULL AND qi.nickname_revision_applied_key IS NULL AND qi.nickname_revision_applied = qi.nickname_revision_wanted) OR
            COALESCE(json_extract(qi.attribution_json, '$.ownership'), 'none') <> 'bot')
          AND EXISTS (SELECT 1 FROM queue_messages qm WHERE qm.item_id = qi.id AND qm.source_generation = qi.source_generation AND qm.removed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.item_id = qi.id AND o.state IN ('running','outputs_recorded','cleanup_pending','uncertain'))
          AND NOT EXISTS (SELECT 1 FROM queue_preparation_operations po WHERE po.item_id = qi.id AND po.state IN ('running','outputs_recorded','cleanup_pending','uncertain'))${excluded}
        ORDER BY qi.logical_sequence LIMIT 1`,
      args: [now, ...excludedIds],
    };
  };

  const peekNextReady = (now: number, excludedIds: readonly number[] = []): QueueItemRecord | undefined => {
    const query = readyPublicationQuery(now, excludedIds);
    const row = database.raw.query(query.sql).get(...query.args) as QueueRow | null;
    return row ? rowToItem(row) : undefined;
  };

  const claimReadyPublication = (operationId: string, type: "publish" | "manual_publish", now: number, expected?: { itemId: number; contentVersion: number; sourceGeneration: number }, bootId?: string, excludedIds: readonly number[] = [], scheduled?: { occurrenceAt: number; deadlineAt: number; claimToken: string }): ClaimedItem | undefined => database.transaction(() => {
    if (scheduled) {
      const run = database.raw.query(`SELECT sr.retry_deadline_at, sr.claim_token, sr.cancelled_at
        FROM schedule_runs sr JOIN settings s ON s.key = 'schedule_enabled'
        WHERE sr.occurrence_at = ? AND sr.status = 'running' AND sr.claim_token = ? AND sr.cancelled_at IS NULL
          AND json_extract(s.value_json, '$') = 1`).get(scheduled.occurrenceAt, scheduled.claimToken) as { retry_deadline_at: number | null; claim_token: string; cancelled_at: number | null } | null;
      if (!run || run.retry_deadline_at === null || run.retry_deadline_at !== scheduled.deadlineAt || now >= run.retry_deadline_at) return undefined;
      const unsafeAttempt = database.raw.query(`SELECT 1 AS found FROM schedule_publication_attempts spa
        LEFT JOIN operation_outputs oo ON oo.operation_id = spa.operation_id AND oo.kind = 'destination'
        LEFT JOIN operation_request_attempts ora ON ora.operation_id = spa.operation_id AND ora.state IN ('in_flight','accepted','unknown')
        WHERE spa.occurrence_at = ? AND (oo.operation_id IS NOT NULL OR ora.operation_id IS NOT NULL) LIMIT 1`).get(scheduled.occurrenceAt);
      if (unsafeAttempt) return undefined;
    }
    const query = readyPublicationQuery(now, excludedIds);
    const candidate = database.raw.query(query.sql).get(...query.args) as QueueRow | null;
    if (!candidate) return undefined;
    const ready = rowToItem(candidate);
    if (expected && (ready.id !== expected.itemId || ready.contentVersion !== expected.contentVersion || ready.sourceGeneration !== expected.sourceGeneration)) return undefined;
    const changed = database.raw.query(`UPDATE queue_items SET status = 'publishing', claimed_operation_id = ?, claimed_at = ?, attempts = attempts + 1
      WHERE id = ? AND status = 'queued' AND preparation_state = 'ready' AND representation_kind = 'prepared'
        AND preparation_operation_id IS NULL AND maintenance_status = 'idle' AND content_version = ? AND source_generation = ?
        AND (retry_not_before IS NULL OR retry_not_before <= ?)
        AND (editorial_frozen_at IS NOT NULL OR
          (nickname_revision_wanted_key IS NOT NULL AND nickname_revision_applied_key = nickname_revision_wanted_key AND nickname_revision_applied = nickname_revision_wanted) OR
          (nickname_revision_wanted_key IS NULL AND nickname_revision_applied_key IS NULL AND nickname_revision_applied = nickname_revision_wanted) OR
          COALESCE(json_extract(attribution_json, '$.ownership'), 'none') <> 'bot')
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.item_id = queue_items.id AND o.state IN ('running','outputs_recorded','cleanup_pending','uncertain'))
        AND NOT EXISTS (SELECT 1 FROM queue_preparation_operations po WHERE po.item_id = queue_items.id AND po.state IN ('running','outputs_recorded','cleanup_pending','uncertain'))`).run(operationId, now, ready.id, ready.contentVersion, ready.sourceGeneration, now);
    if (Number(changed.changes) !== 1) return undefined;
    database.raw.query("INSERT INTO operations (id, type, item_id, state, phase, boot_id, return_item_status, captured_content_version, captured_source_generation, lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, 'running', 'claimed', ?, 'queued', ?, ?, ?, ?, ?, ?)").run(operationId, type, ready.id, currentBootId ?? bootId ?? operationId, ready.contentVersion, ready.sourceGeneration, operationId, now + 300_000, now, now);
    if (scheduled) {
      const run = database.raw.query("SELECT attempt_count FROM schedule_runs WHERE occurrence_at = ? AND status = 'running' AND claim_token = ? AND cancelled_at IS NULL").get(scheduled.occurrenceAt, scheduled.claimToken) as { attempt_count: number } | null;
      if (!run) throw new Error("Scheduled publication claim was lost before operation association");
      const attemptNo = run.attempt_count + 1;
      database.raw.query("INSERT INTO schedule_publication_attempts (occurrence_at, attempt_no, operation_id, item_id, created_at) VALUES (?, ?, ?, ?, ?)").run(scheduled.occurrenceAt, attemptNo, operationId, ready.id, now);
      const associated = database.raw.query("UPDATE schedule_runs SET attempt_count = ?, operation_id = ?, item_id = ? WHERE occurrence_at = ? AND status = 'running' AND claim_token = ? AND cancelled_at IS NULL AND retry_deadline_at = ? AND ? < retry_deadline_at").run(attemptNo, operationId, ready.id, scheduled.occurrenceAt, scheduled.claimToken, scheduled.deadlineAt, now);
      if (Number(associated.changes) !== 1) throw new Error("Scheduled publication could not bind its operation");
    }
    const claimed = findItemById(ready.id);
    if (!claimed) throw new Error("Queue item disappeared during prepared publication claim");
    return { item: claimed, operationId, capturedContentVersion: ready.contentVersion, capturedSourceGeneration: ready.sourceGeneration };
  });

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
    const row = database.raw.query(`SELECT * FROM queue_items qi WHERE status NOT IN ('done','deleted','deleted_external','collecting','publishing','published_cleanup_pending')
      AND maintenance_status = 'idle' AND preparation_operation_id IS NULL AND physical_created_at <= ?
      AND (maintenance_retry_not_before IS NULL OR maintenance_retry_not_before <= ?)
      AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.item_id = qi.id AND o.state IN ('running','outputs_recorded','cleanup_pending','uncertain'))
      AND NOT EXISTS (SELECT 1 FROM queue_preparation_operations p WHERE p.item_id = qi.id AND p.state IN ('running','outputs_recorded','cleanup_pending','uncertain'))
      ORDER BY physical_created_at, logical_sequence LIMIT 1`).get(eligibleBefore, now) as QueueRow | null;
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
    const rows = database.raw.query("SELECT id, item_id, type, phase, state, expected_output_count, expected_source_count, captured_content_version, captured_source_generation, created_at, plan_json, progress_json FROM operations WHERE state IN ('running','outputs_recorded','cleanup_pending') AND ((lease_expires_at IS NULL OR lease_expires_at <= ?) OR (? IS NOT NULL AND (boot_id IS NULL OR boot_id <> ?)))").all(now, bootId ?? null, bootId ?? null) as Array<{ id: string; item_id: number; type: string; phase: string; state: string; expected_output_count: number | null; expected_source_count: number | null; captured_content_version: number; captured_source_generation: number; created_at: number; plan_json: string | null; progress_json: string | null }>;
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
          if (row.plan_json?.includes('"kind":"prepared_renewal"')) {
            try {
              const contract = validatePreparedRenewalContractV2(JSON.parse(row.plan_json) as unknown);
              const progress = row.progress_json ? validateRenewalExecutionProgress(JSON.parse(row.progress_json) as unknown) : undefined;
              const oldMessages = getMessages(item.id, row.captured_source_generation).sort((left, right) => left.ordinal - right.ordinal);
              const activeAtClaim = oldMessages.filter((message) => message.removedAt === undefined);
              const sourceEvidenceMatches = contract.sourceIds.length === activeAtClaim.length && contract.sourceIds.every((messageId, index) => messageId === activeAtClaim[index]?.telegramMessageId)
                && operationSourceIds(row.id).join(",") === contract.sourceIds.join(",");
              const expectedVersion = progress?.effectiveContentVersion;
              const guardMatches = progress !== undefined && item.maintenanceStatus === "renewing" && item.maintenanceOperationId === row.id && item.contentVersion === expectedVersion && item.sourceGeneration === row.captured_source_generation;
              const complete = progress !== undefined && progress.members.length === contract.expectedReplacementMessageCount && progress.members.every((member) => member.outcome !== "pending");
              const sent = progress?.members.filter((member) => member.outcome === "sent") ?? [];
              const outputs = replacementOutputs(row.id);
              const outputByMember = new Map(outputs.filter((output) => output.sourceMemberKey !== undefined).map((output) => [output.sourceMemberKey!, output]));
              const associationsMatch = outputs.length === sent.length && outputByMember.size === sent.length && sent.every((member) => member.outputIds.length === 1 && outputByMember.get(member.memberKey)?.messageId === member.outputIds[0]);
              const memberStatusMatches = progress !== undefined && progress.members.every((member) => {
                const source = oldMessages.find((candidate) => candidate.memberKey === member.memberKey);
                return source !== undefined && (member.outcome === "confirmed_missing" ? source.removedAt !== undefined : source.removedAt === undefined);
              });
              if (!progress || !sourceEvidenceMatches || !guardMatches || !complete || !associationsMatch || !memberStatusMatches) {
                markRenewalUncertain(item.id, row.id);
              } else {
                const planned = contract.steps.flatMap((step) => step.members.map((member) => ({ member, grouped: step.grouped })));
                const nextGeneration = row.captured_source_generation + 1;
                const outputMembers = planned.filter(({ member }) => progress.members.some((state) => state.memberKey === member.memberKey && state.outcome === "sent"));
                for (const [ordinal, entry] of outputMembers.entries()) {
                  const outputId = outputByMember.get(entry.member.memberKey)!.messageId;
                  const { editDate: _editDate, mediaGroupId: _oldMediaGroupId, ...snapshotFields } = entry.member.snapshot;
                  const snapshot = validateStoredMessageSnapshot({
                    ...snapshotFields,
                    chatId: item.queueChatId,
                    messageId: outputId,
                    ordinal,
                    telegramDate: row.created_at,
                    nativeOrigin: entry.member.deliveryMode === "copy" ? { kind: "absent" } : (entry.member.snapshot.nativeOrigin ?? entry.member.snapshot.origin),
                  });
                  const replacement: PreparedMember = { ...entry.member, messageId: outputId, snapshot };
                  if (!entry.grouped) delete replacement.albumKey;
                  insertPreparedMember(item.id, nextGeneration, replacement);
                }
                const newStatus = item.representationKind === "prepared" && item.attribution?.ownership === "bot" && (item.nicknameRevisionApplied ?? 0) !== (item.nicknameRevisionWanted ?? 0) ? "refresh_pending" : item.preparationState ?? "unprepared";
                const firstId = outputMembers[0] ? outputByMember.get(outputMembers[0].member.memberKey)!.messageId : null;
                const installed = database.raw.query("UPDATE queue_items SET source_generation = ?, first_message_id = COALESCE(?, first_message_id), physical_created_at = ?, last_renewed_at = ?, maintenance_status = 'renewal_cleanup_pending', preparation_state = ?, last_error_code = NULL, last_error = NULL WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewing' AND content_version = ? AND source_generation = ?")
                  .run(nextGeneration, firstId, row.created_at, now, newStatus, item.id, row.id, expectedVersion, row.captured_source_generation);
                if (Number(installed.changes) !== 1) markRenewalUncertain(item.id, row.id);
                else {
                  setOperationPhase(row.id, "generation_installed", now, "startup_recovery");
                  setOperationState(row.id, "cleanup_pending", now, "startup_recovery");
                }
              }
            } catch {
              markRenewalUncertain(item.id, row.id);
            }
          } else {
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

  const recordOutput = (operationId: string, role: OperationOutputRole | "destination" | "temporary_preview", chatId: number, messageId: number, ordinal: number, now: number, association?: { stepKey?: string; sourceMemberKey?: string }): void => {
    if (!Number.isSafeInteger(chatId)) throw new InvalidTelegramOutputError("Invalid numeric Telegram output chat ID");
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new InvalidTelegramOutputError("Invalid numeric Telegram output ID");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new InvalidTelegramOutputError("Invalid numeric Telegram output ordinal");
    const kind = role === "replacement" ? "replacement" : role === "temporary_preview" ? "temporary_preview" : "destination";
    const normalizedRole = role === "destination" ? "transferred" : role;
    const result = database.raw.query("INSERT OR IGNORE INTO operation_outputs (operation_id, kind, role, chat_id, telegram_message_id, ordinal, recorded_at, step_key, source_member_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(operationId, kind, normalizedRole, chatId, messageId, ordinal, now, association?.stepKey ?? null, association?.sourceMemberKey ?? null);
    if (Number(result.changes) === 1) return;
    const existing = database.raw.query("SELECT operation_id, kind, role, ordinal, step_key, source_member_key FROM operation_outputs WHERE chat_id = ? AND telegram_message_id = ?").get(chatId, messageId) as { operation_id: string; kind: string; role: string; ordinal: number; step_key: string | null; source_member_key: string | null } | null;
    if (existing?.operation_id === operationId && existing.kind === kind && existing.role === normalizedRole && existing.ordinal === ordinal
      && (association?.stepKey === undefined || existing.step_key === association.stepKey)
      && (association?.sourceMemberKey === undefined || existing.source_member_key === association.sourceMemberKey)) return;
    throw conflict(`Telegram output ${chatId}/${messageId} already belongs to another operation`);
  };

  const recordReplacementOutput = (operationId: string, chatId: number, messageId: number, ordinal: number, now: number, association?: { stepKey?: string; sourceMemberKey?: string }): void => database.transaction(() => {
    recordOutput(operationId, "replacement", chatId, messageId, ordinal, now, association);
    database.raw.query("INSERT OR REPLACE INTO generated_messages (chat_id, message_id, operation_id, kind, created_at, consumed_at) VALUES (?, ?, ?, 'renewal', ?, NULL)").run(chatId, messageId, operationId, now);
  });

  const persistPreparedRenewalContract = (guard: OperationGuard, contract: PreparedRenewalContractV2, now: number): void => database.transaction(() => {
    const validated = validatePreparedRenewalContractV2(contract);
    const operation = database.raw.query("SELECT phase, type, item_id, captured_content_version, captured_source_generation FROM operations WHERE id = ?").get(guard.operationId) as { phase: string; type: string; item_id: number; captured_content_version: number; captured_source_generation: number } | null;
    const item = findItemById(guard.itemId);
    if (!operation || operation.type !== "renew" || operation.phase !== "claimed" || operation.item_id !== guard.itemId || operation.captured_content_version !== guard.capturedContentVersion || operation.captured_source_generation !== guard.capturedSourceGeneration
      || !item || item.maintenanceOperationId !== guard.operationId || item.contentVersion !== guard.capturedContentVersion || item.sourceGeneration !== guard.capturedSourceGeneration) throw conflict("Prepared renewal contract guard conflict");
    if (validated.capturedContentVersion !== guard.capturedContentVersion || validated.capturedSourceGeneration !== guard.capturedSourceGeneration || validated.capturedLogicalStatus !== item.status || validated.sourceIds.join(",") !== currentSourceIds(item.id).join(",")) throw conflict("Prepared renewal source set changed after claim");
    const progress: RenewalExecutionProgress = { version: 1, effectiveContentVersion: guard.capturedContentVersion, members: validated.steps.flatMap((step) => step.members.map((member) => ({ memberKey: member.memberKey, outcome: "pending" as const, outputIds: [] }))) };
    const result = database.raw.query(`UPDATE operations SET expected_source_count = ?, expected_output_count = ?, source_ids_json = ?, plan_json = ?, progress_json = ?, updated_at = ?
      WHERE id = ? AND phase = 'claimed' AND state = 'running' AND item_id = ?`).run(validated.sourceIds.length, validated.expectedReplacementMessageCount, JSON.stringify(validated.sourceIds), JSON.stringify(validated), JSON.stringify(progress), now, guard.operationId, guard.itemId);
    if (Number(result.changes) !== 1) throw conflict("Prepared renewal contract could not be persisted");
  });

  const renewalProgress = (operationId: string): RenewalExecutionProgress | undefined => {
    const row = database.raw.query("SELECT progress_json FROM operations WHERE id = ? AND type = 'renew'").get(operationId) as { progress_json: string | null } | null;
    if (!row?.progress_json) return undefined;
    return validateRenewalExecutionProgress(JSON.parse(row.progress_json) as unknown);
  };

  const markRenewalMemberSent = (guard: RenewalExecutionGuard, memberKey: string, outputId: MessageId, now: number): void => database.transaction(() => {
    const item = database.raw.query("SELECT content_version, source_generation, maintenance_status, maintenance_operation_id FROM queue_items WHERE id = ?").get(guard.itemId) as { content_version: number; source_generation: number; maintenance_status: MaintenanceStatus; maintenance_operation_id: string | null } | null;
    const operation = database.raw.query("SELECT progress_json FROM operations WHERE id = ? AND type = 'renew' AND item_id = ? AND captured_content_version = ? AND captured_source_generation = ? AND state = 'running'").get(guard.operationId, guard.itemId, guard.capturedContentVersion, guard.capturedSourceGeneration) as { progress_json: string | null } | null;
    if (!item || item.maintenance_status !== "renewing" || item.maintenance_operation_id !== guard.operationId || item.content_version !== guard.expectedContentVersion || item.source_generation !== guard.capturedSourceGeneration || !operation?.progress_json) throw conflict("Renewal member completion guard conflict");
    const progress = validateRenewalExecutionProgress(JSON.parse(operation.progress_json) as unknown);
    if (progress.effectiveContentVersion !== guard.expectedContentVersion) throw conflict("Renewal progress version does not match its execution guard");
    const member = progress.members.find((candidate) => candidate.memberKey === memberKey);
    if (!member || member.outcome !== "pending") throw conflict("Renewal member is not awaiting an output");
    const mapped = database.raw.query("SELECT step_key, source_member_key FROM operation_outputs WHERE operation_id = ? AND kind = 'replacement' AND telegram_message_id = ?").get(guard.operationId, outputId) as { step_key: string | null; source_member_key: string | null } | null;
    if (!mapped || mapped.source_member_key !== memberKey) throw conflict("Renewal output has no exact member association");
    const members = progress.members.map((candidate) => candidate.memberKey === memberKey ? { ...candidate, outcome: "sent" as const, outputIds: [outputId] } : candidate);
    const changed = database.raw.query("UPDATE operations SET progress_json = ?, updated_at = ? WHERE id = ? AND state = 'running'").run(JSON.stringify({ ...progress, members }), now, guard.operationId);
    if (Number(changed.changes) !== 1) throw conflict("Renewal progress changed before recording output association");
  });

  const markRenewalMemberMissing = (guard: RenewalExecutionGuard, memberKey: string, evidence: { method: string; code?: number; description: string }, now: number): { remainingCount: number; itemRemoved: boolean; nextGuard: RenewalExecutionGuard } => database.transaction(() => {
    const item = database.raw.query("SELECT content_version, source_generation, maintenance_status, maintenance_operation_id FROM queue_items WHERE id = ?").get(guard.itemId) as { content_version: number; source_generation: number; maintenance_status: MaintenanceStatus; maintenance_operation_id: string | null } | null;
    const operation = database.raw.query("SELECT progress_json FROM operations WHERE id = ? AND type = 'renew' AND item_id = ? AND captured_content_version = ? AND captured_source_generation = ? AND state = 'running'").get(guard.operationId, guard.itemId, guard.capturedContentVersion, guard.capturedSourceGeneration) as { progress_json: string | null } | null;
    if (!item || item.maintenance_status !== "renewing" || item.maintenance_operation_id !== guard.operationId || item.content_version !== guard.expectedContentVersion || item.source_generation !== guard.capturedSourceGeneration || !operation?.progress_json) throw conflict("Renewal missing-member guard conflict");
    const progress = validateRenewalExecutionProgress(JSON.parse(operation.progress_json) as unknown);
    if (progress.effectiveContentVersion !== guard.expectedContentVersion) throw conflict("Renewal progress version does not match its execution guard");
    const member = progress.members.find((candidate) => candidate.memberKey === memberKey);
    if (!member || member.outcome !== "pending") throw conflict("Renewal member is not awaiting a missing-source result");
    const changedMember = database.raw.query(`UPDATE queue_messages SET removed_at = ?, removal_reason = 'confirmed_missing'
      WHERE item_id = ? AND source_generation = ? AND member_key = ? AND removed_at IS NULL`).run(now, guard.itemId, guard.capturedSourceGeneration, memberKey);
    if (Number(changedMember.changes) !== 1) throw conflict("Renewal source member was already removed or replaced");
    const nextVersion = item.content_version + 1;
    const members = progress.members.map((candidate) => candidate.memberKey === memberKey ? { ...candidate, outcome: "confirmed_missing" as const, outputIds: [], missingEvidence: evidence } : candidate);
    const remainingRow = database.raw.query("SELECT COUNT(*) AS count FROM queue_messages WHERE item_id = ? AND source_generation = ? AND removed_at IS NULL").get(guard.itemId, guard.capturedSourceGeneration) as { count: number };
    const remainingCount = Number(remainingRow.count);
    if (remainingCount === 0) {
      const terminalized = database.raw.query(`UPDATE queue_items SET content_version = ?, status = 'deleted_external', completed_at = ?, maintenance_status = 'idle', maintenance_operation_id = NULL, last_error_code = 'source_missing', last_error = ?,
        attribution_json = CASE WHEN json_extract(attribution_json, '$.ownership') = 'bot' AND json_extract(attribution_json, '$.memberKey') = ? THEN json_object('ownership','admin','previousMemberKey',?) ELSE attribution_json END
        WHERE id = ? AND maintenance_operation_id = ? AND content_version = ? AND source_generation = ?`).run(nextVersion, now, evidence.description, memberKey, memberKey, guard.itemId, guard.operationId, item.content_version, guard.capturedSourceGeneration);
      if (Number(terminalized.changes) !== 1) throw conflict("Renewal terminal deletion lost its owner guard");
      database.raw.query("UPDATE operations SET progress_json = ?, state = 'done', phase = 'completed', error_code = 'source_missing', error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...progress, effectiveContentVersion: nextVersion, members }), JSON.stringify(evidence), now, guard.operationId);
      return { remainingCount, itemRemoved: true, nextGuard: { ...guard, expectedContentVersion: nextVersion } };
    }
    const changedItem = database.raw.query(`UPDATE queue_items SET content_version = ?, first_message_id = (SELECT telegram_message_id FROM queue_messages WHERE item_id = ? AND source_generation = ? AND removed_at IS NULL ORDER BY ordinal, telegram_message_id LIMIT 1),
      attribution_json = CASE WHEN json_extract(attribution_json, '$.ownership') = 'bot' AND json_extract(attribution_json, '$.memberKey') = ? THEN json_object('ownership','admin','previousMemberKey',?) ELSE attribution_json END,
      preparation_state = CASE WHEN json_extract(attribution_json, '$.ownership') = 'bot' AND json_extract(attribution_json, '$.memberKey') = ? THEN 'ready' WHEN representation_kind = 'prepared' AND json_extract(attribution_json, '$.ownership') = 'bot' THEN 'refresh_pending' ELSE preparation_state END
      WHERE id = ? AND maintenance_operation_id = ? AND content_version = ? AND source_generation = ?`)
      .run(nextVersion, guard.itemId, guard.capturedSourceGeneration, memberKey, memberKey, memberKey, guard.itemId, guard.operationId, item.content_version, guard.capturedSourceGeneration);
    if (Number(changedItem.changes) !== 1) throw conflict("Renewal source member removal lost its guard");
    const changedProgress = database.raw.query("UPDATE operations SET progress_json = ?, updated_at = ? WHERE id = ? AND state = 'running'").run(JSON.stringify({ ...progress, effectiveContentVersion: nextVersion, members }), now, guard.operationId);
    if (Number(changedProgress.changes) !== 1) throw conflict("Renewal progress changed while recording missing-source evidence");
    return { remainingCount, itemRemoved: false, nextGuard: { ...guard, expectedContentVersion: nextVersion } };
  });

  const replacementOutputs = (operationId: string): Array<{ chatId: number; messageId: MessageId; ordinal: number; stepKey?: string; sourceMemberKey?: string }> => {
    const rows = database.raw.query("SELECT chat_id, telegram_message_id, ordinal, step_key, source_member_key FROM operation_outputs WHERE operation_id = ? AND kind = 'replacement' ORDER BY ordinal, telegram_message_id").all(operationId) as Array<{ chat_id: number; telegram_message_id: number; ordinal: number; step_key: string | null; source_member_key: string | null }>;
    return rows.map((row) => ({ chatId: row.chat_id, messageId: row.telegram_message_id as MessageId, ordinal: row.ordinal, ...(row.step_key === null ? {} : { stepKey: row.step_key }), ...(row.source_member_key === null ? {} : { sourceMemberKey: row.source_member_key }) }));
  };

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

  const persistPreparedPublicationContract = (operationId: string, contract: PreparedPublicationContractV2, now: number): void => database.transaction(() => {
    const validated = validatePreparedPublicationContractV2(contract);
    const item = database.raw.query("SELECT id, queue_chat_id, status, content_version, source_generation FROM queue_items WHERE claimed_operation_id = ? AND status = 'publishing'").get(operationId) as { id: number; queue_chat_id: number; status: QueueItemStatus; content_version: number; source_generation: number } | null;
    if (!item || item.content_version !== validated.capturedContentVersion || item.source_generation !== validated.capturedSourceGeneration) throw conflict("Prepared publication contract guard conflict");
    const currentIds = currentSourceIds(item.id);
    if (currentIds.join(",") !== validated.sourceIds.join(",")) throw conflict("Prepared publication sources changed after claim");
    const result = database.raw.query(`UPDATE operations SET return_item_status = 'queued', expected_source_count = ?, expected_output_count = ?, source_ids_json = ?, plan_json = ?, phase = 'claimed', updated_at = ?
      WHERE id = ? AND item_id = ? AND captured_content_version = ? AND captured_source_generation = ? AND phase = 'claimed'`)
      .run(validated.sourceIds.length, validated.expectedOutputMessageCount, JSON.stringify(validated.sourceIds), JSON.stringify(validated), now, operationId, item.id, validated.capturedContentVersion, validated.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Prepared publication operation changed before its contract was persisted");
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
    const contractRow = database.raw.query("SELECT expected_source_count, plan_json, progress_json FROM operations WHERE id = ?").get(guard.operationId) as { expected_source_count: number | null; plan_json: string | null; progress_json: string | null } | null;
    const actual = operationOutputIds(guard.operationId, "replacement").length;
    if (!contractRow?.plan_json || !contractRow.plan_json.includes('"kind":"prepared_renewal"')) {
      if (!contractRow || contractRow.expected_source_count !== actual) throw new Error("Renewal output count does not match contract");
    } else {
      const contract = validatePreparedRenewalContractV2(JSON.parse(contractRow.plan_json) as unknown);
      const progress = contractRow.progress_json ? validateRenewalExecutionProgress(JSON.parse(contractRow.progress_json) as unknown) : undefined;
      if (!progress || progress.members.some((member) => member.outcome === "pending")) throw new Error("Prepared renewal still has unresolved member steps");
      const sent = progress.members.filter((member) => member.outcome === "sent");
      const outputRows = replacementOutputs(guard.operationId);
      if (actual !== sent.length || actual !== contract.expectedReplacementMessageCount - progress.members.filter((member) => member.outcome === "confirmed_missing").length
        || sent.some((member) => member.outputIds.length !== 1 || !outputRows.some((output) => output.sourceMemberKey === member.memberKey && output.messageId === member.outputIds[0]))) {
        throw new Error("Prepared renewal output associations do not match the complete member plan");
      }
    }
    setOperationState(guard.operationId, "outputs_recorded", now);
    setOperationPhase(guard.operationId, "replacement_outputs_recorded", now);
  });

  const installRenewedGeneration = (guardOrItemId: OperationGuard | RenewalExecutionGuard | number, operationIdOrSnapshots: string | readonly StoredMessageSnapshot[] | readonly PreparedMember[], snapshotsOrNow: readonly StoredMessageSnapshot[] | readonly PreparedMember[] | number, maybeNow?: number, maybeSourceCreatedAt?: number): number => database.transaction(() => {
    const guard: OperationGuard | RenewalExecutionGuard = typeof guardOrItemId === "number"
      ? (() => {
        const item = findItemById(guardOrItemId);
        if (!item || typeof operationIdOrSnapshots !== "string") throw new Error("Renewal operation lease is no longer owned");
        return { operationId: operationIdOrSnapshots, itemId: guardOrItemId, capturedContentVersion: item.contentVersion, capturedSourceGeneration: item.sourceGeneration };
      })()
      : guardOrItemId;
    const replacementValues = (typeof guardOrItemId === "number" ? snapshotsOrNow : operationIdOrSnapshots) as readonly (StoredMessageSnapshot | PreparedMember)[];
    const preparedMembers = replacementValues.length > 0 && "snapshot" in replacementValues[0]!;
    const now = (typeof guardOrItemId === "number" ? maybeNow : snapshotsOrNow) as number;
    const sourceCreatedAt = (typeof guardOrItemId === "number" ? maybeSourceCreatedAt : maybeNow) ?? now;
    const operation = guardRow(guard);
    if (!operation || operation.type !== "renew" || operation.maintenanceStatus !== "renewing" || !["replacement_outputs_recorded", "claimed"].includes(operation.phase)) throw conflict("Renewal generation guard conflict");
    const item = findItemById(guard.itemId);
    const effectiveVersion = "expectedContentVersion" in guard ? guard.expectedContentVersion : guard.capturedContentVersion;
    if (!item || item.maintenanceOperationId !== guard.operationId || item.contentVersion !== effectiveVersion || item.sourceGeneration !== guard.capturedSourceGeneration) throw conflict("Renewal generation CAS conflict");
    const nextGeneration = item.sourceGeneration + 1;
    if (preparedMembers) {
      for (const member of replacementValues as readonly PreparedMember[]) insertPreparedMember(item.id, nextGeneration, member);
    } else {
      for (const snapshot of replacementValues as readonly StoredMessageSnapshot[]) insertSnapshot(item.id, nextGeneration, snapshot);
    }
    const progress = renewalProgress(guard.operationId);
    const nextPreparationState = item.editorialFrozenAt !== undefined ? (item.preparationState ?? "ready") : item.representationKind === "prepared" && item.attribution?.ownership === "bot" && ((item.nicknameRevisionAppliedKey ?? "") !== (item.nicknameRevisionWantedKey ?? "") || (item.nicknameRevisionApplied ?? 0) !== (item.nicknameRevisionWanted ?? 0)) ? "refresh_pending" : item.preparationState ?? "unprepared";
    const firstMemberId = preparedMembers ? (replacementValues[0] as PreparedMember | undefined)?.messageId : (replacementValues[0] as StoredMessageSnapshot | undefined)?.messageId;
    const result = database.raw.query(`UPDATE queue_items SET source_generation = ?, first_message_id = COALESCE(?, first_message_id), physical_created_at = ?, last_renewed_at = ?, maintenance_status = 'renewal_cleanup_pending', preparation_state = ?
      WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewing' AND content_version = ? AND source_generation = ?`)
      .run(nextGeneration, firstMemberId ?? null, sourceCreatedAt, now, nextPreparationState, item.id, guard.operationId, effectiveVersion, guard.capturedSourceGeneration);
    if (Number(result.changes) !== 1) throw conflict("Renewal generation install lost its lease");
    setOperationState(guard.operationId, "cleanup_pending", now);
    setOperationPhase(guard.operationId, "generation_installed", now);
    return nextGeneration;
  });

  const setRetry = (itemId: number, operationId: string, now: number, retryNotBefore: number, errorCode: string, errorText: string): void => database.transaction(() => {
    const operation = database.raw.query("SELECT type, return_item_status FROM operations WHERE id = ? AND item_id = ?").get(operationId, itemId) as { type: string; return_item_status: QueueItemStatus | null } | null;
    if (!operation) throw new Error("Operation not found for retry");
    if (operation.type === "renew") {
      const result = database.raw.query(`UPDATE queue_items SET maintenance_status = 'idle', maintenance_operation_id = NULL, maintenance_retry_not_before = ?, last_error_code = ?, last_error = ?,
        preparation_state = CASE WHEN editorial_frozen_at IS NULL AND representation_kind = 'prepared' AND json_extract(attribution_json, '$.ownership') = 'bot' AND (COALESCE(nickname_revision_applied_key, '') <> COALESCE(nickname_revision_wanted_key, '') OR nickname_revision_applied <> nickname_revision_wanted) THEN 'refresh_pending' ELSE preparation_state END
        WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewing'`).run(retryNotBefore, errorCode, errorText, itemId, operationId);
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

  const completeRenewalWithOrphans = (guard: RenewalExecutionGuard | OperationGuard, orphanIds: readonly number[], now: number, reason = "old_generation_cleanup_failed"): void => database.transaction(() => {
    const operation = guardRow(guard);
    if (!operation || operation.type !== "renew" || !["generation_installed", "old_source_cleanup_pending"].includes(operation.phase)) throw new Error("Renewal cleanup guard conflict");
    const item = findItemById(guard.itemId);
    const effectiveVersion = "expectedContentVersion" in guard ? guard.expectedContentVersion : guard.capturedContentVersion;
    if (!item || item.maintenanceOperationId !== guard.operationId || item.contentVersion !== effectiveVersion || item.sourceGeneration !== guard.capturedSourceGeneration + 1) throw new Error("Renewal completion CAS conflict");
    const terminal = reason === "telegram_age_limit";
    const nextAttemptAt = reason === "permission_denied" ? now + 6 * 60 * 60_000 : now;
    const orphanInsert = database.raw.query("INSERT OR IGNORE INTO orphaned_sources (item_id, source_generation, chat_id, telegram_message_id, reason, first_attempt_at, last_attempt_at, resolved_at, attempt_count, next_attempt_at, terminal_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const id of orphanIds) orphanInsert.run(item.id, guard.capturedSourceGeneration, item.queueChatId, id, reason, now, now, null, terminal ? 1 : 0, terminal ? null : nextAttemptAt, terminal ? reason : null);
    const result = database.raw.query(`UPDATE queue_items SET maintenance_status = 'idle', maintenance_operation_id = NULL, maintenance_retry_not_before = NULL,
      preparation_state = CASE WHEN editorial_frozen_at IS NULL AND representation_kind = 'prepared' AND json_extract(attribution_json, '$.ownership') = 'bot' AND (COALESCE(nickname_revision_applied_key, '') <> COALESCE(nickname_revision_wanted_key, '') OR nickname_revision_applied <> nickname_revision_wanted) THEN 'refresh_pending' ELSE preparation_state END
      WHERE id = ? AND maintenance_operation_id = ? AND maintenance_status = 'renewal_cleanup_pending' AND content_version = ? AND source_generation = ?`).run(item.id, guard.operationId, effectiveVersion, guard.capturedSourceGeneration + 1);
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
    database.raw.query(`UPDATE queue_items SET status = 'deleted', completed_at = ?, claimed_operation_id = NULL, claimed_at = NULL, maintenance_status = 'idle', maintenance_operation_id = NULL,
      editorial_frozen_at = COALESCE(editorial_frozen_at, ?), editorial_freeze_reason = COALESCE(editorial_freeze_reason, 'admin_delete')
      WHERE id = ? AND status NOT IN ('done','deleted','deleted_external')`).run(now, now, itemId);
  };

  const retryItem = (itemId: number, now: number): void => {
    database.raw.query(`UPDATE queue_items SET status = 'queued', retry_not_before = NULL, last_error_code = NULL, last_error = NULL, claimed_operation_id = NULL, claimed_at = NULL,
      preparation_state = CASE WHEN editorial_frozen_at IS NOT NULL AND representation_kind = 'prepared' THEN 'ready' WHEN representation_kind = 'raw' AND preparation_state = 'failed' THEN 'unprepared' ELSE preparation_state END
      WHERE id = ? AND maintenance_status = 'idle' AND status IN ('blocked','needs_edit','needs_review','delete_blocked')`).run(itemId);
    void now;
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

  const currentSourceIds = (itemId: number): MessageId[] => getMessages(itemId).filter((message) => message.removedAt === undefined).map((message) => message.telegramMessageId);

  const getCurrentSnapshotSet = (itemId: number): StoredMessageSnapshot[] => getMessages(itemId).filter((message) => message.removedAt === undefined).map((message) => message.snapshot);

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

  const preparationOutputOperation = (queueChatId: number, messageId: number): { operationId: string; itemId: number } | undefined => {
    const row = database.raw.query(`SELECT po.operation_id, qpo.item_id FROM queue_preparation_outputs po
      JOIN queue_preparation_operations qpo ON qpo.id = po.operation_id JOIN queue_items qi ON qi.id = qpo.item_id
      WHERE po.chat_id = ? AND po.telegram_message_id = ? AND qpo.state IN ('running','outputs_recorded','cleanup_pending','uncertain')
        AND qi.status NOT IN ('done','deleted','deleted_external')`).get(queueChatId, messageId) as { operation_id: string; item_id: number } | null;
    return row ? { operationId: row.operation_id, itemId: row.item_id } : undefined;
  };

  const preparationCandidateOperation = (queueChatId: number): { operationId: string; itemId: number } | undefined => {
    const row = database.raw.query(`SELECT qpo.id AS operation_id, qi.id AS item_id FROM queue_preparation_operations qpo JOIN queue_items qi ON qi.id = qpo.item_id
      WHERE qi.queue_chat_id = ? AND qpo.state IN ('running','outputs_recorded') AND qpo.phase IN ('transfer_pending','attribution_pending')
      ORDER BY qpo.updated_at LIMIT 1`).get(queueChatId) as { operation_id: string; item_id: number } | null;
    return row ? { operationId: row.operation_id, itemId: row.item_id } : undefined;
  };

  const preparationOperationState = (operationId: string): string | undefined => {
    const row = database.raw.query("SELECT state FROM queue_preparation_operations WHERE id = ?").get(operationId) as { state: string } | null;
    return row?.state;
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
    getCurrentMembers,
    getCapturedMembers,
    findKnownSource,
    observeQueueSnapshot,
    addAlbumMember,
    addLateAlbumMember,
    insertRecoveredSnapshots,
    reprocessRecoveredItem,
    finalizeAlbums,
    reconcileNicknamePolicy,
    acceptAdminQueueEdit,
    acceptProvisionalPreparationEdit,
    updateSnapshot,
    listActive,
    getHead,
    peekNextReady,
    claimReadyPublication,
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
    replacementOutputs,
    renewalProgress,
    recoverExpiredOperations,
    recordOutput,
    recordReplacementOutput,
    persistPreparedRenewalContract,
    markRenewalMemberSent,
    markRenewalMemberMissing,
    persistPublicationContract,
    persistPreparedPublicationContract,
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
    preparationOutputOperation,
    preparationCandidateOperation,
    preparationOperationState,
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
      database.transaction(() => database.raw.query(`INSERT INTO known_hidden_authors (sender_name, first_seen_at, last_seen_at)
        VALUES (?, ?, ?) ON CONFLICT(sender_name) DO UPDATE SET last_seen_at = MAX(known_hidden_authors.last_seen_at, excluded.last_seen_at)`)
        .run(origin.senderUserName, now, now));
      return;
    }
    if (origin.kind !== "user") return;
    const normalizedUsername = origin.username?.toLowerCase();
    database.transaction(() => {
      const previous = database.raw.query("SELECT normalized_username FROM known_authors WHERE user_id = ?").get(origin.userId) as { normalized_username: string | null } | null;
      if (normalizedUsername) database.raw.query("UPDATE known_authors SET normalized_username = NULL WHERE normalized_username = ? AND user_id <> ?").run(normalizedUsername, origin.userId);
      database.raw.query("INSERT INTO known_authors (user_id, username, normalized_username, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, normalized_username = excluded.normalized_username, display_name = excluded.display_name, last_seen_at = excluded.last_seen_at").run(origin.userId, origin.username ?? null, normalizedUsername ?? null, origin.displayName, now, now);
      reconcileAffectedIdentifiableItems(origin.userId, previous?.normalized_username ?? undefined, normalizedUsername);
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

  const resolveCreditPolicy = (origin: SemanticOrigin): { alias?: string; revisionKey: string; revision: number } => {
    if (origin.kind === "hidden_user") {
      const row = database.raw.query("SELECT kha.id, kha.alias_revision, haa.nickname FROM known_hidden_authors kha LEFT JOIN hidden_author_aliases haa ON haa.hidden_author_id = kha.id WHERE kha.sender_name = ? COLLATE BINARY").get(origin.senderUserName) as { id: number; alias_revision: number; nickname: string | null } | null;
      if (!row) return { revisionKey: `hidden:unobserved:${origin.senderUserName}`, revision: 0 };
      return { ...(row.nickname === null ? {} : { alias: row.nickname }), revisionKey: `hidden:${row.id}`, revision: row.alias_revision };
    }
    if (origin.kind !== "user") return { revisionKey: "none", revision: 0 };
    const byId = database.raw.query("SELECT ka.alias_revision, aa.nickname FROM known_authors ka LEFT JOIN author_aliases aa ON aa.user_id = ka.user_id WHERE ka.user_id = ?").get(origin.userId) as { alias_revision: number; nickname: string | null } | null;
    if (byId?.nickname !== null && byId?.nickname !== undefined) return { alias: byId.nickname, revisionKey: `user:${origin.userId}`, revision: byId.alias_revision };
    if (origin.username) {
      const byUsername = database.raw.query(`SELECT ka.user_id, ka.alias_revision, aa.nickname FROM known_authors ka
        JOIN author_aliases aa ON aa.user_id = ka.user_id WHERE ka.normalized_username = ? ORDER BY ka.user_id LIMIT 1`)
        .get(origin.username.toLowerCase()) as { user_id: number; alias_revision: number; nickname: string } | null;
      if (byUsername) return { alias: byUsername.nickname, revisionKey: `user:${byUsername.user_id}`, revision: byUsername.alias_revision };
    }
    return { revisionKey: `user:${origin.userId}`, revision: byId?.alias_revision ?? 0 };
  };

  const aliasForOrigin = (origin: SemanticOrigin): string | undefined => resolveCreditPolicy(origin).alias;
  const aliasRevisionForOrigin = (origin: SemanticOrigin): number => resolveCreditPolicy(origin).revision;

  const reconcileAffectedIdentifiableItems = (userId: number, previousUsername?: string, currentUsername?: string): void => {
    const usernames = [...new Set([previousUsername, currentUsername].filter((name): name is string => name !== undefined))];
    const clauses = ["json_extract(origin_json, '$.userId') = ?"];
    const args: Array<string | number> = [userId];
    if (usernames.length > 0) {
      clauses.push(`lower(json_extract(origin_json, '$.username')) IN (${usernames.map(() => "?").join(",")})`);
      args.push(...usernames);
    }
    const rows = database.raw.query(`SELECT id, origin_json, nickname_revision_wanted, nickname_revision_wanted_key
      FROM queue_items WHERE status NOT IN ('done','deleted','deleted_external') AND editorial_frozen_at IS NULL
        AND json_extract(origin_json, '$.kind') = 'user' AND (${clauses.join(" OR ")})`).all(...args) as Array<{ id: number; origin_json: string; nickname_revision_wanted: number; nickname_revision_wanted_key: string | null }>;
    for (const row of rows) {
      const policy = resolveCreditPolicy(validateSemanticOrigin(JSON.parse(row.origin_json) as unknown));
      const wanted = row.nickname_revision_wanted_key === policy.revisionKey ? Math.max(row.nickname_revision_wanted, policy.revision) : policy.revision;
      database.raw.query(`UPDATE queue_items SET nickname_revision_wanted = ?, nickname_revision_wanted_key = ?,
        preparation_state = CASE WHEN representation_kind = 'prepared' AND json_extract(attribution_json, '$.ownership') = 'bot'
          AND (COALESCE(nickname_revision_applied_key, '') <> ? OR nickname_revision_applied <> ?) THEN 'refresh_pending' ELSE preparation_state END
        WHERE id = ? AND editorial_frozen_at IS NULL`).run(wanted, policy.revisionKey, policy.revisionKey, wanted, row.id);
    }
  };

  const updateIdentifiableAuthorItems = (userId: number, revision: number): void => {
    database.raw.query(`UPDATE queue_items
      SET nickname_revision_wanted = CASE WHEN nickname_revision_wanted_key = ? THEN MAX(nickname_revision_wanted, ?) ELSE ? END,
          nickname_revision_wanted_key = ?,
          preparation_state = CASE WHEN representation_kind = 'prepared' AND json_extract(attribution_json, '$.ownership') = 'bot' THEN 'refresh_pending' ELSE preparation_state END
      WHERE status NOT IN ('done','deleted','deleted_external')
        AND editorial_frozen_at IS NULL
        AND json_extract(origin_json, '$.kind') = 'user'
        AND (json_extract(origin_json, '$.userId') = ? OR lower(json_extract(origin_json, '$.username')) = (SELECT normalized_username FROM known_authors WHERE user_id = ?))`)
      .run(`user:${userId}`, revision, revision, `user:${userId}`, userId, userId);
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
      const username = (database.raw.query("SELECT normalized_username FROM known_authors WHERE user_id = ?").get(userId) as { normalized_username: string | null }).normalized_username ?? undefined;
      reconcileAffectedIdentifiableItems(userId, username, username);
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
      const username = (database.raw.query("SELECT normalized_username FROM known_authors WHERE user_id = ?").get(userId) as { normalized_username: string | null }).normalized_username ?? undefined;
      reconcileAffectedIdentifiableItems(userId, username, username);
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
      SET nickname_revision_wanted = CASE WHEN nickname_revision_wanted_key = 'hidden:' || ? THEN MAX(nickname_revision_wanted, ?) ELSE ? END,
          nickname_revision_wanted_key = 'hidden:' || ?,
          preparation_state = CASE WHEN representation_kind = 'prepared' AND json_extract(attribution_json, '$.ownership') = 'bot' THEN 'refresh_pending' ELSE preparation_state END
      WHERE status NOT IN ('done','deleted','deleted_external')
        AND editorial_frozen_at IS NULL
        AND json_extract(origin_json, '$.kind') = 'hidden_user'
        AND json_extract(origin_json, '$.senderUserName') = (SELECT sender_name FROM known_hidden_authors WHERE id = ?)`)
      .run(hiddenAuthorId, revision, revision, hiddenAuthorId, hiddenAuthorId);
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

  return { isChannelWhitelisted, upsertChannel, removeChannel, listChannels, observeAuthor, resolveAuthorId, resolveCreditPolicy, aliasForOrigin, aliasRevisionForOrigin, setAlias, removeAlias, listAuthors, listHiddenAuthors, getHiddenAuthor, countHiddenAuthors, setHiddenAlias, removeHiddenAlias };
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
  type ScheduleOutcome = "published" | "empty" | "blocked" | "failed" | "skipped_downtime";
  type ScheduleAttempt = {
    attemptNo: number;
    operationId: string;
    itemId: number;
    createdAt: number;
    operationState: string;
    operationPhase: string;
    requestEvidenceVersion: number;
    expectedOutputCount: number | null;
    outputIds: number[];
    requestStates: string[];
  };
  type DueScheduleRun = { occurrenceAt: number; retryNotBefore?: number; retryDeadlineAt: number; attemptCount: number };
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
    if (!value) cancelUnsentRows("schedule_paused", now);
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
      database.raw.query(`UPDATE schedule_runs SET status = 'failed', cancelled_at = ?, cancel_reason = 'slot_removed', completed_at = ?, error_code = 'slot_removed', claim_token = NULL, claim_boot_id = NULL
        WHERE cancelled_at IS NULL AND ((status = 'pending'
            AND ((CAST(strftime('%H', occurrence_at / 1000, 'unixepoch') AS INTEGER) * 60) + CAST(strftime('%M', occurrence_at / 1000, 'unixepoch') AS INTEGER)) = ?)
          OR (status = 'running'
            AND ((CAST(strftime('%H', occurrence_at / 1000, 'unixepoch') AS INTEGER) * 60) + CAST(strftime('%M', occurrence_at / 1000, 'unixepoch') AS INTEGER)) = ?
            AND NOT EXISTS (SELECT 1 FROM schedule_publication_attempts spa WHERE spa.occurrence_at = schedule_runs.occurrence_at)))`).run(now, now, minuteOfDay, minuteOfDay);
      database.raw.query("INSERT INTO audit_events (event_type, actor, metadata_json, created_at) VALUES ('schedule_slot_removed', ?, ?, ?)").run(String(adminId), JSON.stringify({ minuteOfDay }), now);
    }
  });
  const materialize = (occurrenceAt: number): boolean => {
    const date = new Date(occurrenceAt);
    const minuteOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();
    const slot = database.raw.query("SELECT effective_at FROM schedule_slots WHERE minute_of_day = ? AND effective_at < ?").get(minuteOfDay, occurrenceAt) as { effective_at: number } | null;
    if (!slot) return false;
    const result = database.raw.query("INSERT OR IGNORE INTO schedule_runs (occurrence_at, status, retry_deadline_at) VALUES (?, 'pending', ?)").run(occurrenceAt, occurrenceAt + 300_000);
    return Number(result.changes) > 0;
  };
  const run = (occurrenceAt: number): { status: string; itemId?: number; operationId?: string; retryNotBefore?: number; retryDeadlineAt?: number; attemptCount?: number; cancelledAt?: number; cancelReason?: string; errorCode?: string } | undefined => {
    const row = database.raw.query("SELECT status, item_id, operation_id, retry_not_before, retry_deadline_at, attempt_count, cancelled_at, cancel_reason, error_code FROM schedule_runs WHERE occurrence_at = ?").get(occurrenceAt) as { status: string; item_id: number | null; operation_id: string | null; retry_not_before: number | null; retry_deadline_at: number | null; attempt_count: number; cancelled_at: number | null; cancel_reason: string | null; error_code: string | null } | null;
    if (!row) return undefined;
    const result: { status: string; itemId?: number; operationId?: string; retryNotBefore?: number; retryDeadlineAt?: number; attemptCount?: number; cancelledAt?: number; cancelReason?: string; errorCode?: string } = { status: row.status, attemptCount: row.attempt_count };
    if (row.item_id !== null) result.itemId = row.item_id;
    if (row.operation_id !== null) result.operationId = row.operation_id;
    if (row.retry_not_before !== null) result.retryNotBefore = row.retry_not_before;
    if (row.retry_deadline_at !== null) result.retryDeadlineAt = row.retry_deadline_at;
    if (row.cancelled_at !== null) result.cancelledAt = row.cancelled_at;
    if (row.cancel_reason !== null) result.cancelReason = row.cancel_reason;
    if (row.error_code !== null) result.errorCode = row.error_code;
    return result;
  };
  const markRun = (occurrenceAt: number, status: string, now: number, itemId?: number, operationId?: string, errorCode?: string): void => {
    database.raw.query("UPDATE schedule_runs SET status = ?, item_id = ?, operation_id = ?, completed_at = ?, error_code = ? WHERE occurrence_at = ? AND status IN ('pending','running')").run(status, itemId ?? null, operationId ?? null, now, errorCode ?? null, occurrenceAt);
  };
  const markRunning = (occurrenceAt: number, now: number): boolean => {
    const result = database.raw.query("UPDATE schedule_runs SET status = 'running', operation_id = NULL, started_at = ? WHERE occurrence_at = ? AND status = 'pending'").run(now, occurrenceAt);
    return Number(result.changes) === 1;
  };
  const duePending = (now: number): DueScheduleRun[] => (database.raw.query(`SELECT occurrence_at, retry_not_before, retry_deadline_at, attempt_count FROM schedule_runs
    WHERE status = 'pending' AND cancelled_at IS NULL AND retry_deadline_at IS NOT NULL
      AND (retry_not_before IS NULL OR retry_not_before <= ?) AND retry_deadline_at > ?
    ORDER BY occurrence_at`).all(now, now) as Array<{ occurrence_at: number; retry_not_before: number | null; retry_deadline_at: number; attempt_count: number }>).map((row) => ({
      occurrenceAt: row.occurrence_at,
      retryDeadlineAt: row.retry_deadline_at,
      attemptCount: row.attempt_count,
      ...(row.retry_not_before === null ? {} : { retryNotBefore: row.retry_not_before }),
    }));
  const nextPendingWake = (now: number): number | undefined => {
    const row = database.raw.query(`SELECT MIN(CASE WHEN retry_not_before IS NULL OR retry_not_before <= ? THEN retry_deadline_at
      WHEN retry_not_before < retry_deadline_at THEN retry_not_before ELSE retry_deadline_at END) AS next_at
      FROM schedule_runs WHERE status = 'pending' AND cancelled_at IS NULL AND retry_deadline_at IS NOT NULL`).get(now) as { next_at: number | null };
    return row.next_at ?? undefined;
  };
  const claimRun = (occurrenceAt: number, bootId: string, now: number): { occurrenceAt: number; deadlineAt: number; claimToken: string } | undefined => database.transaction(() => {
    const claimToken = randomUUID();
    const result = database.raw.query(`UPDATE schedule_runs SET status = 'running', operation_id = NULL, item_id = NULL, started_at = ?, completed_at = NULL,
      claim_token = ?, claim_boot_id = ?, retry_not_before = NULL
      WHERE occurrence_at = ? AND status = 'pending' AND cancelled_at IS NULL AND retry_deadline_at > ?
        AND (retry_not_before IS NULL OR retry_not_before <= ?)
        AND EXISTS (SELECT 1 FROM settings WHERE key = 'schedule_enabled' AND json_extract(value_json, '$') = 1)`).run(now, claimToken, bootId, occurrenceAt, now, now);
    if (Number(result.changes) !== 1) return undefined;
    const row = database.raw.query("SELECT retry_deadline_at FROM schedule_runs WHERE occurrence_at = ? AND claim_token = ?").get(occurrenceAt, claimToken) as { retry_deadline_at: number };
    return { occurrenceAt, deadlineAt: row.retry_deadline_at, claimToken };
  });
  const deferRun = (claimToken: string, retryAt: number, now: number, reason: string): boolean => {
    const row = database.raw.query("SELECT occurrence_at, retry_deadline_at FROM schedule_runs WHERE status = 'running' AND claim_token = ? AND cancelled_at IS NULL").get(claimToken) as { occurrence_at: number; retry_deadline_at: number } | null;
    if (!row || retryAt >= row.retry_deadline_at || now >= row.retry_deadline_at) return false;
    const result = database.raw.query(`UPDATE schedule_runs SET status = 'pending', retry_not_before = ?, claim_token = NULL, claim_boot_id = NULL,
      operation_id = NULL, item_id = NULL, error_code = ?, started_at = NULL
      WHERE occurrence_at = ? AND status = 'running' AND claim_token = ? AND cancelled_at IS NULL AND retry_deadline_at > ?`).run(retryAt, reason, row.occurrence_at, claimToken, now);
    return Number(result.changes) === 1;
  };
  const finishRun = (claimToken: string, outcome: { status: ScheduleOutcome; itemId?: number; operationId?: string; errorCode?: string }, now: number): boolean => {
    const result = database.raw.query(`UPDATE schedule_runs SET status = ?, item_id = COALESCE(?, item_id), operation_id = COALESCE(?, operation_id),
      completed_at = ?, error_code = ?, claim_token = NULL, claim_boot_id = NULL
      WHERE status = 'running' AND claim_token = ? AND cancelled_at IS NULL`).run(outcome.status, outcome.itemId ?? null, outcome.operationId ?? null, now, outcome.errorCode ?? null, claimToken);
    return Number(result.changes) === 1;
  };
  const cancelPendingRows = (reason: string, now: number): number => {
    const result = database.raw.query(`UPDATE schedule_runs SET status = 'failed', cancelled_at = ?, cancel_reason = ?, completed_at = ?, error_code = ?, retry_not_before = NULL, claim_token = NULL, claim_boot_id = NULL
      WHERE status = 'pending' AND cancelled_at IS NULL`).run(now, reason, now, reason);
    return Number(result.changes);
  };
  const cancelUnsentRows = (reason: string, now: number): number => {
    const result = database.raw.query(`UPDATE schedule_runs SET status = 'failed', cancelled_at = ?, cancel_reason = ?, completed_at = ?, error_code = ?, retry_not_before = NULL, claim_token = NULL, claim_boot_id = NULL
      WHERE cancelled_at IS NULL AND (status = 'pending' OR (status = 'running'
        AND NOT EXISTS (SELECT 1 FROM schedule_publication_attempts spa WHERE spa.occurrence_at = schedule_runs.occurrence_at)))`).run(now, reason, now, reason);
    return Number(result.changes);
  };
  const cancelPendingRuns = (reason: string, now: number): number => database.transaction(() => cancelPendingRows(reason, now));
  const cancelUnsentRuns = (reason: string, now: number): number => database.transaction(() => {
    return cancelUnsentRows(reason, now);
  });
  const cancelOlderPendingRuns = (newerOccurrenceAt: number, reason: string, now: number): number => {
    const result = database.raw.query(`UPDATE schedule_runs SET status = 'failed', cancelled_at = ?, cancel_reason = ?, completed_at = ?, error_code = ?, retry_not_before = NULL, claim_token = NULL, claim_boot_id = NULL
      WHERE status = 'pending' AND cancelled_at IS NULL AND occurrence_at < ?`).run(now, reason, now, reason, newerOccurrenceAt);
    return Number(result.changes);
  };
  const expirePendingRuns = (now: number): number => {
    const result = database.raw.query(`UPDATE schedule_runs SET status = 'failed', completed_at = ?, error_code = 'retry_window_expired', retry_not_before = NULL
      WHERE status = 'pending' AND cancelled_at IS NULL AND retry_deadline_at IS NOT NULL AND retry_deadline_at <= ?`).run(now, now);
    return Number(result.changes);
  };
  const associatedAttempts = (occurrenceAt: number): ScheduleAttempt[] => {
    const rows = database.raw.query(`SELECT spa.attempt_no, spa.operation_id, spa.item_id, spa.created_at, o.state AS operation_state, o.phase AS operation_phase,
      o.request_evidence_version, o.expected_output_count,
      COALESCE((SELECT json_group_array(telegram_message_id) FROM operation_outputs oo WHERE oo.operation_id = spa.operation_id AND oo.kind = 'destination'), '[]') AS outputs_json,
      COALESCE((SELECT json_group_array(state) FROM operation_request_attempts ora WHERE ora.operation_id = spa.operation_id ORDER BY request_ordinal), '[]') AS requests_json
      FROM schedule_publication_attempts spa JOIN operations o ON o.id = spa.operation_id WHERE spa.occurrence_at = ? ORDER BY spa.attempt_no`).all(occurrenceAt) as Array<{ attempt_no: number; operation_id: string; item_id: number; created_at: number; operation_state: string; operation_phase: string; request_evidence_version: number; expected_output_count: number | null; outputs_json: string; requests_json: string }>;
    return rows.map((row) => ({ attemptNo: row.attempt_no, operationId: row.operation_id, itemId: row.item_id, createdAt: row.created_at, operationState: row.operation_state, operationPhase: row.operation_phase, requestEvidenceVersion: row.request_evidence_version, expectedOutputCount: row.expected_output_count, outputIds: JSON.parse(row.outputs_json) as number[], requestStates: JSON.parse(row.requests_json) as string[] }));
  };
  const recoverInterruptedRuns = (now: number): number => database.transaction(() => {
    const rows = database.raw.query(`SELECT occurrence_at, item_id, operation_id, retry_deadline_at, claim_boot_id, cancelled_at
      FROM schedule_runs WHERE status = 'running'`).all() as Array<{ occurrence_at: number; item_id: number | null; operation_id: string | null; retry_deadline_at: number | null; claim_boot_id: string | null; cancelled_at: number | null }>;
    let recovered = 0;
    for (const row of rows) {
      const attempts = associatedAttempts(row.occurrence_at);
      const complete = attempts.find((attempt) => attempt.expectedOutputCount !== null && attempt.expectedOutputCount > 0
        && attempt.outputIds.length === attempt.expectedOutputCount
        && (attempt.operationPhase === "completed" || attempt.operationPhase === "output_complete" || attempt.operationPhase === "source_cleanup_pending" || attempt.operationState === "done" || attempt.operationState === "cleanup_pending"));
      if (complete) {
        database.raw.query(`UPDATE schedule_runs SET status = 'published', item_id = ?, operation_id = ?, completed_at = ?, error_code = ?, claim_token = NULL, claim_boot_id = NULL
          WHERE occurrence_at = ? AND status = 'running'`).run(complete.itemId, complete.operationId, now, complete.operationState === "cleanup_pending" || complete.operationPhase === "source_cleanup_pending" ? "cleanup_pending" : null, row.occurrence_at);
        recovered += 1;
        continue;
      }
      const possiblySent = attempts.find((attempt) => attempt.outputIds.length > 0 || attempt.operationState === "uncertain" || attempt.operationPhase === "uncertain"
        || attempt.requestStates.some((state) => state === "in_flight" || state === "accepted" || state === "unknown")
        || (attempt.requestEvidenceVersion === 0 && attempt.requestStates.length === 0));
      if (possiblySent || row.cancelled_at !== null) {
        database.raw.query(`UPDATE schedule_runs SET status = 'failed', completed_at = ?, error_code = ?, claim_token = NULL, claim_boot_id = NULL
          WHERE occurrence_at = ? AND status = 'running'`).run(now, row.cancelled_at !== null ? "cancelled" : "uncertain_publish", row.occurrence_at);
        recovered += 1;
        continue;
      }
      const safeEvidence = attempts.length > 0 && attempts.every((attempt) => attempt.requestEvidenceVersion === 1
        && (attempt.requestStates.length === 0 || attempt.requestStates.every((state) => state === "rejected")));
      const freshClaimWithoutOperation = attempts.length === 0 && row.operation_id === null && row.claim_boot_id !== null;
      if ((safeEvidence || freshClaimWithoutOperation) && row.retry_deadline_at !== null && row.retry_deadline_at > now && enabled()) {
        const retryRow = database.raw.query(`SELECT MAX(qi.retry_not_before) AS retry_at FROM schedule_publication_attempts spa
          JOIN queue_items qi ON qi.id = spa.item_id WHERE spa.occurrence_at = ?`).get(row.occurrence_at) as { retry_at: number | null };
        const retryAt = Math.min(row.retry_deadline_at - 1, Math.max(now, retryRow.retry_at ?? now));
        database.raw.query(`UPDATE schedule_runs SET status = 'pending', retry_not_before = ?, started_at = NULL, operation_id = NULL, item_id = NULL,
          claim_token = NULL, claim_boot_id = NULL, error_code = 'startup_retry_recovered' WHERE occurrence_at = ? AND status = 'running'`).run(retryAt, row.occurrence_at);
      } else {
        database.raw.query(`UPDATE schedule_runs SET status = 'failed', completed_at = ?, error_code = ?, claim_token = NULL, claim_boot_id = NULL
          WHERE occurrence_at = ? AND status = 'running'`).run(now, row.retry_deadline_at === null || row.retry_deadline_at <= now ? "retry_window_expired" : "startup_recovery", row.occurrence_at);
      }
      recovered += 1;
    }
    return recovered;
  });
  const lastScan = (): number | undefined => {
    const row = database.raw.query("SELECT last_scheduler_scan_at FROM app_state WHERE id = 1").get() as { last_scheduler_scan_at: number | null };
    return row.last_scheduler_scan_at ?? undefined;
  };
  const setLastScan = (now: number): void => { database.raw.query("UPDATE app_state SET last_scheduler_scan_at = ? WHERE id = 1").run(now); };
  return { slots, enabled, setEnabled, addSlot, removeSlot, materialize, run, markRun, markRunning, duePending, nextPendingWake, claimRun, deferRun, finishRun, cancelPendingRuns, cancelUnsentRuns, cancelOlderPendingRuns, expirePendingRuns, associatedAttempts, recoverInterruptedRuns, lastScan, setLastScan };
};

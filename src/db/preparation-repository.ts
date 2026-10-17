import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database";
import { createGeneratedEventRepository } from "./generated-event-repository";
import { assertPreparedMembers } from "../domain/prepared-post";
import {
  validateAttributionDescriptor,
  validateExecutionProgress,
  validatePreparationContractV1,
  validatePreparedMember,
  validateStoredMessageSnapshot,
} from "../domain/validation";
import { OperationConflictError } from "../errors";
import type { AttributionDescriptor, ExecutionProgress, MessageId, PreparationContractV1, PreparedExecutionGuard, PreparedMember, QueueItemStatus } from "../types";

type PreparationRow = {
  id: string; item_id: number; kind: "prepare" | "refresh"; state: string; phase: string; boot_id: string; lease_expires_at: number;
  captured_content_version: number; captured_source_generation: number; target_source_generation: number | null;
  source_ids_json: string; contract_json: string; progress_json: string; result_json: string | null; return_item_status: QueueItemStatus;
  error_code: string | null; error_json: string | null; created_at: number; updated_at: number;
};

export type PreparationClaim = {
  operationId: string; itemId: number; kind: "prepare" | "refresh"; guard: PreparedExecutionGuard;
  sourceIds: MessageId[]; memberKeys: string[]; bootId: string;
};

export type PreparationResult = { members: readonly PreparedMember[]; attribution: AttributionDescriptor; nicknameRevisionApplied: number; nicknameRevisionAppliedKey?: string };
export type PreparationOutput = { chatId: number; messageId: number; ordinal: number; outputKey: string; stepKey: string; sourceMemberKey?: string; role: "content" | "credit"; snapshot?: unknown };

const asJson = (value: unknown): string => JSON.stringify(value);
const conflict = (message: string): OperationConflictError => new OperationConflictError(message);

export type PreparationRepository = ReturnType<typeof createPreparationRepository>;

export const createPreparationRepository = (database: AppDatabase, options: { leaseMs?: number; operationId?: () => string } = {}) => {
  const leaseMs = options.leaseMs ?? 300_000;
  const makeOperationId = options.operationId ?? randomUUID;
  const generatedEvents = createGeneratedEventRepository(database);

  const operation = (id: string): PreparationRow | undefined => database.raw.query("SELECT * FROM queue_preparation_operations WHERE id = ?").get(id) as PreparationRow | null ?? undefined;
  const assertOwner = (id: string, allowCleanup = false): PreparationRow => {
    const row = operation(id);
    if (!row) throw conflict("Preparation operation no longer exists");
    const owned = database.raw.query("SELECT content_version, source_generation FROM queue_items WHERE id = ? AND preparation_operation_id = ? AND content_version >= ? AND source_generation = ?").get(row.item_id, id, row.captured_content_version, row.captured_source_generation) as { content_version: number; source_generation: number } | null;
    if (!owned && !allowCleanup) throw conflict("Preparation operation ownership or version changed");
    if (owned && validateExecutionProgress(JSON.parse(row.progress_json) as unknown).effectiveContentVersion !== owned.content_version) throw conflict("Preparation item changed outside its guarded execution");
    return row;
  };

  const claimNextPreparation = (now: number, bootId: string): PreparationClaim | undefined => database.transaction(() => {
    const row = database.raw.query(`SELECT qi.id, qi.status, qi.preparation_state, qi.content_version, qi.source_generation,
        CASE WHEN qi.preparation_state = 'refresh_pending' OR qi.representation_kind = 'prepared' THEN 'refresh' ELSE 'prepare' END AS kind
      FROM queue_items qi
      WHERE qi.status = 'queued'
        AND qi.preparation_state IN ('unprepared','refresh_pending')
        AND (qi.editorial_frozen_at IS NULL OR qi.preparation_state = 'unprepared')
        AND qi.preparation_operation_id IS NULL
        AND qi.claimed_operation_id IS NULL
        AND qi.maintenance_status = 'idle'
        AND (qi.retry_not_before IS NULL OR qi.retry_not_before <= ?)
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.item_id = qi.id AND o.state IN ('running','outputs_recorded','cleanup_pending','uncertain'))
        AND NOT EXISTS (SELECT 1 FROM queue_preparation_operations po WHERE po.item_id = qi.id AND po.state IN ('running','outputs_recorded','cleanup_pending','uncertain'))
      ORDER BY qi.logical_sequence LIMIT 1`).get(now) as { id: number; status: QueueItemStatus; preparation_state: string; content_version: number; source_generation: number; kind: "prepare" | "refresh" } | null;
    if (!row) return undefined;
    const members = database.raw.query("SELECT member_key, telegram_message_id FROM queue_messages WHERE item_id = ? AND source_generation = ? AND removed_at IS NULL ORDER BY ordinal, telegram_message_id").all(row.id, row.source_generation) as Array<{ member_key: string | null; telegram_message_id: number }>;
    if (members.length === 0 || members.some((member) => member.member_key === null)) return undefined;
    const id = makeOperationId();
    const kind = row.kind;
    const state = kind === "refresh" ? "refreshing" : "preparing";
    const sourceIds = members.map((member) => member.telegram_message_id as MessageId);
    const progress: ExecutionProgress = { version: 1, effectiveContentVersion: row.content_version, members: members.map((member) => ({ memberKey: member.member_key!, outcome: "pending", outputIds: [] })) };
    const changed = database.raw.query("UPDATE queue_items SET preparation_state = ?, preparation_operation_id = ? WHERE id = ? AND status = 'queued' AND preparation_state IN ('unprepared','refresh_pending') AND preparation_operation_id IS NULL AND claimed_operation_id IS NULL AND maintenance_status = 'idle' AND content_version = ? AND source_generation = ?").run(state, id, row.id, row.content_version, row.source_generation);
    if (Number(changed.changes) !== 1) return undefined;
    database.raw.query(`INSERT INTO queue_preparation_operations (id, item_id, kind, state, phase, boot_id, lease_expires_at, captured_content_version, captured_source_generation, target_source_generation, source_ids_json, contract_json, progress_json, result_json, return_item_status, created_at, updated_at)
      VALUES (?, ?, ?, 'running', 'claimed', ?, ?, ?, ?, NULL, ?, '{}', ?, NULL, ?, ?, ?)`)
      .run(id, row.id, kind, bootId, now + leaseMs, row.content_version, row.source_generation, asJson(sourceIds), asJson(progress), row.status, now, now);
    return { operationId: id, itemId: row.id, kind, guard: { operationId: id, itemId: row.id, capturedContentVersion: row.content_version, capturedSourceGeneration: row.source_generation, expectedContentVersion: row.content_version }, sourceIds, memberKeys: members.map((member) => member.member_key!), bootId };
  });

  const persistContract = (operationId: string, contract: PreparationContractV1, now: number): void => database.transaction(() => {
    const validated = validatePreparationContractV1(contract);
    const row = assertOwner(operationId);
    if (validated.itemId !== row.item_id || validated.kind !== row.kind || validated.capturedContentVersion !== row.captured_content_version || validated.capturedSourceGeneration !== row.captured_source_generation) throw conflict("Preparation contract does not match its claimed operation");
    const ids = JSON.parse(row.source_ids_json) as number[];
    if (validated.capturedMembers.map((member) => Number(member.messageId)).join(",") !== ids.join(",")) throw conflict("Preparation contract source members changed after claim");
    const result = database.raw.query("UPDATE queue_preparation_operations SET contract_json = ?, updated_at = ? WHERE id = ? AND phase = 'claimed' AND state = 'running'").run(asJson(validated), now, operationId);
    if (Number(result.changes) !== 1) throw conflict("Preparation contract can only be persisted before transfer");
  });

  const setPhase = (operationId: string, phase: string, now: number): void => database.transaction(() => {
    assertOwner(operationId);
    const result = database.raw.query("UPDATE queue_preparation_operations SET phase = ?, updated_at = ? WHERE id = ? AND state IN ('running','outputs_recorded')").run(phase, now, operationId);
    if (Number(result.changes) !== 1) throw conflict("Preparation operation is no longer running");
  });

  const recordOutput = (operationId: string, output: PreparationOutput, now: number): void => database.transaction(() => {
    const row = assertOwner(operationId);
    if (!Number.isSafeInteger(output.chatId) || !Number.isSafeInteger(output.messageId) || output.messageId <= 0 || !Number.isSafeInteger(output.ordinal) || output.ordinal < 0 || !output.outputKey || !output.stepKey) throw new Error("Invalid preparation output evidence");
    const existingPrep = database.raw.query("SELECT operation_id, ordinal, output_key, step_key FROM queue_preparation_outputs WHERE chat_id = ? AND telegram_message_id = ?").get(output.chatId, output.messageId) as { operation_id: string; ordinal: number; output_key: string; step_key: string } | null;
    const existingOperation = database.raw.query("SELECT operation_id FROM operation_outputs WHERE chat_id = ? AND telegram_message_id = ?").get(output.chatId, output.messageId) as { operation_id: string } | null;
    const existingQueue = database.raw.query("SELECT item_id, source_generation FROM queue_messages WHERE queue_chat_id = ? AND telegram_message_id = ?").get(output.chatId, output.messageId) as { item_id: number; source_generation: number } | null;
    if (existingOperation || existingQueue || existingPrep && (existingPrep.operation_id !== operationId || existingPrep.ordinal !== output.ordinal || existingPrep.output_key !== output.outputKey || existingPrep.step_key !== output.stepKey)) throw conflict(`Telegram output ${output.chatId}/${output.messageId} is already owned`);
    const snapshotJson = output.snapshot === undefined ? null : asJson(validateStoredMessageSnapshot(output.snapshot));
    database.raw.query(`INSERT INTO queue_preparation_outputs (operation_id, chat_id, telegram_message_id, ordinal, output_key, step_key, source_member_key, role, snapshot_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(operation_id, chat_id, telegram_message_id) DO NOTHING`)
      .run(operationId, output.chatId, output.messageId, output.ordinal, output.outputKey, output.stepKey, output.sourceMemberKey ?? null, output.role, snapshotJson, now);
    const expectedPost = database.raw.query("SELECT 1 FROM queue_generated_events WHERE operation_family = 'preparation' AND operation_id = ? AND chat_id = ? AND message_id = ? AND event_kind = 'post' AND state = 'pending' LIMIT 1").get(operationId, output.chatId, output.messageId);
    if (!expectedPost) database.raw.query(`INSERT INTO queue_generated_events (id, operation_family, operation_id, chat_id, message_id, event_kind, expected_fingerprint, expected_snapshot_json, state, created_at)
      VALUES (?, 'preparation', ?, ?, ?, 'post', NULL, ?, 'pending', ?)`)
      .run(randomUUID(), operationId, output.chatId, output.messageId, snapshotJson, now);
    database.raw.query("UPDATE queue_preparation_operations SET state = 'outputs_recorded', updated_at = ? WHERE id = ? AND state = 'running'").run(now, operationId);
    void row;
  });

  const expectEdit = (operationId: string, chatId: number, messageId: number, snapshotValue: unknown, now: number): string => {
    assertOwner(operationId);
    const snapshot = validateStoredMessageSnapshot(snapshotValue);
    if (Number(snapshot.chatId) !== chatId || Number(snapshot.messageId) !== messageId || !snapshot.contentFingerprint) throw new Error("Expected edit snapshot identity or fingerprint is invalid");
    return generatedEvents.expect({ family: "preparation", operationId, chatId, messageId, kind: "edit", fingerprint: snapshot.contentFingerprint, snapshot, now });
  };

  const markEditRequestStarted = (eventId: string, startedAt: number, observedAfterUpdateId?: number): void => generatedEvents.markEditRequestStarted(eventId, startedAt, observedAfterUpdateId);
  const markEditRequestAccepted = (eventId: string, finishedAt: number, editDate?: number): ReturnType<typeof generatedEvents.markEditRequestAccepted> => generatedEvents.markEditRequestAccepted(eventId, finishedAt, editDate);
  const markEditRequestRejected = (eventId: string, finishedAt: number): ReturnType<typeof generatedEvents.markEditRequestRejected> => generatedEvents.markEditRequestRejected(eventId, finishedAt);
  const markEditRequestUnknown = (eventId: string, finishedAt: number): ReturnType<typeof generatedEvents.markEditRequestUnknown> => generatedEvents.markEditRequestUnknown(eventId, finishedAt);

  const recordCompleteResult = (operationId: string, result: PreparationResult, now: number): void => database.transaction(() => {
    const row = assertOwner(operationId);
    const members = result.members.map((member) => validatePreparedMember(member, "result.member"));
    assertPreparedMembers(members);
    if (!Number.isSafeInteger(result.nicknameRevisionApplied) || result.nicknameRevisionApplied < 0) throw new Error("Invalid applied nickname revision");
    if (result.nicknameRevisionAppliedKey !== undefined && (typeof result.nicknameRevisionAppliedKey !== "string" || result.nicknameRevisionAppliedKey.length === 0)) throw new Error("Invalid applied nickname key");
    const attribution = validateAttributionDescriptor(result.attribution);
    const outputIds = new Set((database.raw.query("SELECT telegram_message_id FROM queue_preparation_outputs WHERE operation_id = ? AND chat_id = (SELECT queue_chat_id FROM queue_items WHERE id = ?)").all(operationId, row.item_id) as Array<{ telegram_message_id: number }>).map((output) => output.telegram_message_id));
    if (members.some((member) => !outputIds.has(Number(member.messageId)))) throw conflict("Prepared result includes an output that was not durably recorded");
    const normalized = { members, attribution, nicknameRevisionApplied: result.nicknameRevisionApplied, ...(result.nicknameRevisionAppliedKey === undefined ? {} : { nicknameRevisionAppliedKey: result.nicknameRevisionAppliedKey }) };
    const changed = database.raw.query("UPDATE queue_preparation_operations SET state = 'outputs_recorded', phase = 'result_complete', result_json = ?, updated_at = ? WHERE id = ? AND state IN ('running','outputs_recorded') AND captured_content_version = ? AND captured_source_generation = ?").run(asJson(normalized), now, operationId, row.captured_content_version, row.captured_source_generation);
    if (Number(changed.changes) !== 1) throw conflict("Preparation completion guard conflict");
  });

  const installPreparedGenerationTx = (row: PreparationRow, now: number): { itemId: number; oldSourceIds: MessageId[]; preparationState: string } => {
    const operationId = row.id;
    if (row.phase !== "result_complete" || !row.result_json) throw conflict("Preparation result is not complete");
    assertOwner(operationId);
    const result = JSON.parse(row.result_json) as PreparationResult;
    const members = result.members.map((member) => validatePreparedMember(member, "result.member"));
    assertPreparedMembers(members);
    const item = database.raw.query("SELECT queue_chat_id, content_version, source_generation, nickname_revision_wanted, nickname_revision_wanted_key, editorial_frozen_at, status FROM queue_items WHERE id = ? AND preparation_operation_id = ?").get(row.item_id, operationId) as { queue_chat_id: number; content_version: number; source_generation: number; nickname_revision_wanted: number; nickname_revision_wanted_key: string | null; editorial_frozen_at: number | null; status: QueueItemStatus } | null;
    const progress = validateExecutionProgress(JSON.parse(row.progress_json) as unknown);
    if (!item || item.content_version !== progress.effectiveContentVersion || item.source_generation !== row.captured_source_generation || item.status !== "queued") throw conflict("Preparation install guard conflict");
    const outputRows = database.raw.query("SELECT telegram_message_id, source_member_key, role, snapshot_json FROM queue_preparation_outputs WHERE operation_id = ? AND chat_id = ?").all(operationId, item.queue_chat_id) as Array<{ telegram_message_id: number; source_member_key: string | null; role: string; snapshot_json: string | null }>;
    const outputById = new Map(outputRows.map((output) => [output.telegram_message_id, output]));
    const generation = row.captured_source_generation + 1;
    for (const [ordinal, member] of members.entries()) {
      const output = outputById.get(Number(member.messageId));
      if (!output || output.role !== member.role) throw conflict("Prepared member has no matching durable output evidence");
      if (output.source_member_key !== null && output.source_member_key !== member.memberKey) throw conflict("Prepared output member association conflicts with result");
      const snapshot = validateStoredMessageSnapshot({ ...member.snapshot, chatId: item.queue_chat_id, messageId: Number(member.messageId), ordinal });
      database.raw.query(`INSERT INTO queue_messages (item_id, source_generation, queue_chat_id, telegram_message_id, ordinal, telegram_date, edit_date, snapshot_json, member_key, member_role, member_delivery_mode, album_key, removed_at, removal_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
        .run(row.item_id, generation, item.queue_chat_id, member.messageId, ordinal, snapshot.telegramDate, snapshot.editDate ?? null, asJson(snapshot), member.memberKey, member.role, member.deliveryMode, member.albumKey ?? null);
    }
    const appliedKey = result.nicknameRevisionAppliedKey ?? item.nickname_revision_wanted_key ?? "none";
    let wantedKey = item.nickname_revision_wanted_key ?? appliedKey;
    let wantedRevision = item.nickname_revision_wanted;
    if (item.editorial_frozen_at === null && result.attribution.ownership === "bot" && appliedKey === wantedKey && result.nicknameRevisionApplied > wantedRevision) wantedRevision = result.nicknameRevisionApplied;
    const nextPreparationState = item.editorial_frozen_at !== null || result.attribution.ownership !== "bot" || (appliedKey === wantedKey && result.nicknameRevisionApplied === wantedRevision) ? "ready" : "refresh_pending";
    const primary = members.find((member) => member.role === "content") ?? members[0]!;
    const installed = database.raw.query(`UPDATE queue_items SET source_generation = ?, first_message_id = ?, content_type = ?, physical_created_at = ?, representation_kind = 'prepared', preparation_state = ?, preparation_operation_id = NULL, attribution_json = ?, nickname_revision_applied = ?, nickname_revision_applied_key = ?, nickname_revision_wanted = ?, nickname_revision_wanted_key = ?, prepared_at = ? WHERE id = ? AND preparation_operation_id = ? AND content_version = ? AND source_generation = ?`)
      .run(generation, primary.messageId, primary.snapshot.contentType, now, nextPreparationState, asJson(validateAttributionDescriptor(result.attribution)), result.nicknameRevisionApplied, appliedKey, wantedRevision, wantedKey, now, row.item_id, operationId, progress.effectiveContentVersion, row.captured_source_generation);
    if (Number(installed.changes) !== 1) throw conflict("Prepared generation lost its guarded install");
    const oldSourceIds = JSON.parse(row.source_ids_json) as MessageId[];
    database.raw.query("UPDATE queue_preparation_operations SET state = 'cleanup_pending', phase = 'source_cleanup_pending', target_source_generation = ?, updated_at = ? WHERE id = ?").run(generation, now, operationId);
    return { itemId: row.item_id, oldSourceIds, preparationState: nextPreparationState };
  };

  const installPreparedGeneration = (operationId: string, now: number): { itemId: number; oldSourceIds: MessageId[]; preparationState: string } => database.transaction(() => {
    const row = operation(operationId);
    if (!row) throw conflict("Preparation operation no longer exists");
    return installPreparedGenerationTx(row, now);
  });

  const completeInPlacePreparation = (guard: PreparedExecutionGuard, preparedMembers: readonly PreparedMember[], attribution: AttributionDescriptor, revision: number, now: number, revisionKey?: string): { preparationState: string } => database.transaction(() => {
    const row = assertOwner(guard.operationId);
    const progress = validateExecutionProgress(JSON.parse(row.progress_json) as unknown);
    const item = database.raw.query("SELECT queue_chat_id, nickname_revision_wanted, nickname_revision_wanted_key, content_version, source_generation, editorial_frozen_at FROM queue_items WHERE id = ? AND preparation_operation_id = ?").get(guard.itemId, guard.operationId) as { queue_chat_id: number; nickname_revision_wanted: number; nickname_revision_wanted_key: string | null; content_version: number; source_generation: number; editorial_frozen_at: number | null } | null;
    if (!item || row.kind !== "prepare" || item.content_version !== guard.expectedContentVersion || progress.effectiveContentVersion !== guard.expectedContentVersion || item.source_generation !== guard.capturedSourceGeneration) throw conflict("In-place preparation guard conflict");
    const capturedKeys = progress.members.map((member) => member.memberKey).sort();
    const preparedKeys = preparedMembers.map((member) => member.memberKey).sort();
    if (capturedKeys.length !== preparedKeys.length || capturedKeys.some((key, index) => key !== preparedKeys[index])) throw conflict("In-place preparation must preserve every captured member");
    for (const member of preparedMembers) {
      const snapshot = validateStoredMessageSnapshot(member.snapshot);
      const changed = database.raw.query("UPDATE queue_messages SET member_role = ?, member_delivery_mode = ?, album_key = ?, snapshot_json = ? WHERE item_id = ? AND source_generation = ? AND member_key = ? AND telegram_message_id = ? AND removed_at IS NULL").run(member.role, member.deliveryMode, member.albumKey ?? null, asJson(snapshot), guard.itemId, guard.capturedSourceGeneration, member.memberKey, member.messageId);
      if (Number(changed.changes) !== 1) throw conflict("In-place prepared member changed");
    }
    const appliedKey = revisionKey ?? item.nickname_revision_wanted_key ?? "none";
    const wantedKey = item.nickname_revision_wanted_key ?? appliedKey;
    const wantedRevision = item.editorial_frozen_at === null && attribution.ownership === "bot" && appliedKey === wantedKey ? Math.max(item.nickname_revision_wanted, revision) : item.nickname_revision_wanted;
    const nextState = item.editorial_frozen_at !== null || attribution.ownership !== "bot" || (appliedKey === wantedKey && revision === wantedRevision) ? "ready" : "refresh_pending";
    const installed = database.raw.query("UPDATE queue_items SET representation_kind = 'prepared', preparation_state = ?, preparation_operation_id = NULL, attribution_json = ?, nickname_revision_applied = ?, nickname_revision_applied_key = ?, nickname_revision_wanted = ?, nickname_revision_wanted_key = ?, prepared_at = ? WHERE id = ? AND preparation_operation_id = ? AND content_version = ? AND source_generation = ?").run(nextState, asJson(validateAttributionDescriptor(attribution)), revision, appliedKey, wantedRevision, wantedKey, now, guard.itemId, guard.operationId, guard.expectedContentVersion, guard.capturedSourceGeneration);
    if (Number(installed.changes) !== 1) throw conflict("In-place prepared installation lost its guard");
    database.raw.query("UPDATE queue_preparation_operations SET state = 'done', phase = 'completed', result_json = ?, updated_at = ? WHERE id = ? AND state IN ('running','outputs_recorded')").run(asJson({ members: preparedMembers, attribution, nicknameRevisionApplied: revision, nicknameRevisionAppliedKey: appliedKey }), now, guard.operationId);
    return { preparationState: nextState };
  });

  const completeInPlaceRefresh = (guard: PreparedExecutionGuard, updatedMembers: readonly PreparedMember[], attribution: AttributionDescriptor, revision: number, now: number, revisionKey?: string, contentChanged = true): { preparationState: string } => database.transaction(() => {
    const row = assertOwner(guard.operationId);
    const item = database.raw.query("SELECT queue_chat_id, nickname_revision_wanted, nickname_revision_wanted_key, nickname_revision_applied_key, content_version, source_generation, editorial_frozen_at FROM queue_items WHERE id = ? AND preparation_operation_id = ?").get(guard.itemId, guard.operationId) as { queue_chat_id: number; nickname_revision_wanted: number; nickname_revision_wanted_key: string | null; nickname_revision_applied_key: string | null; content_version: number; source_generation: number; editorial_frozen_at: number | null } | null;
    if (!item || row.kind !== "refresh" || item.content_version !== guard.expectedContentVersion || item.source_generation !== guard.capturedSourceGeneration) throw conflict("In-place refresh guard conflict");
    for (const member of contentChanged ? updatedMembers : []) {
      if (Number(member.messageId) <= 0 || member.snapshot.messageId !== member.messageId) throw new Error("Invalid refreshed member snapshot");
      const changed = database.raw.query("UPDATE queue_messages SET snapshot_json = ?, telegram_date = ?, edit_date = ? WHERE item_id = ? AND source_generation = ? AND member_key = ? AND telegram_message_id = ? AND removed_at IS NULL").run(asJson(validateStoredMessageSnapshot(member.snapshot)), member.snapshot.telegramDate, member.snapshot.editDate ?? null, guard.itemId, guard.capturedSourceGeneration, member.memberKey, member.messageId);
      if (Number(changed.changes) !== 1) throw conflict("Refreshed queue member changed");
    }
    const appliedKey = revisionKey ?? item.nickname_revision_wanted_key ?? item.nickname_revision_applied_key ?? "none";
    const wantedKey = item.nickname_revision_wanted_key ?? appliedKey;
    const wantedRevision = item.editorial_frozen_at === null && attribution.ownership === "bot" && appliedKey === wantedKey ? Math.max(item.nickname_revision_wanted, revision) : item.nickname_revision_wanted;
    const nextState = item.editorial_frozen_at !== null || attribution.ownership !== "bot" || (appliedKey === wantedKey && revision === wantedRevision) ? "ready" : "refresh_pending";
    const versionExpression = contentChanged ? "content_version + 1" : "content_version";
    database.raw.query(`UPDATE queue_items SET content_version = ${versionExpression}, attribution_json = ?, nickname_revision_applied = ?, nickname_revision_applied_key = ?, nickname_revision_wanted = ?, nickname_revision_wanted_key = ?, preparation_state = ?, preparation_operation_id = NULL, prepared_at = ? WHERE id = ? AND preparation_operation_id = ? AND content_version = ? AND source_generation = ?`).run(asJson(validateAttributionDescriptor(attribution)), revision, appliedKey, wantedRevision, wantedKey, nextState, now, guard.itemId, guard.operationId, guard.expectedContentVersion, guard.capturedSourceGeneration);
    database.raw.query("UPDATE queue_preparation_operations SET state = 'done', phase = 'completed', result_json = ?, updated_at = ? WHERE id = ? AND state IN ('running','outputs_recorded')").run(asJson({ members: updatedMembers, attribution, nicknameRevisionApplied: revision, nicknameRevisionAppliedKey: appliedKey }), now, guard.operationId);
    return { preparationState: nextState };
  });

  const markFailed = (operationId: string, status: QueueItemStatus, code: string, description: string, now: number): void => database.transaction(() => {
    const row = assertOwner(operationId);
    if (!["queued", "blocked", "needs_edit", "needs_review"].includes(status)) throw new Error("Invalid preparation failure status");
    database.raw.query("UPDATE queue_items SET status = ?, preparation_state = 'failed', preparation_operation_id = NULL, last_error_code = ?, last_error = ? WHERE id = ? AND preparation_operation_id = ?").run(status, code, description, row.item_id, operationId);
    database.raw.query("UPDATE queue_preparation_operations SET state = 'failed', phase = 'failed', error_code = ?, error_json = ?, updated_at = ? WHERE id = ?").run(code, asJson({ description }), now, operationId);
  });

  const markUncertain = (operationId: string, code: string, description: string, now: number): void => database.transaction(() => {
    const row = operation(operationId);
    if (!row) throw conflict("Preparation operation no longer exists");
    // A differing admin edit can advance content_version while this operation
    // is in flight. Preserve that edit and release the lease into review rather
    // than letting a stale completion overwrite it or leaving the item owned.
    database.raw.query("UPDATE queue_items SET status = 'needs_review', preparation_state = 'uncertain', preparation_operation_id = NULL, last_error_code = ?, last_error = ? WHERE id = ? AND preparation_operation_id = ?").run(code, description, row.item_id, operationId);
    database.raw.query("UPDATE queue_preparation_operations SET state = 'uncertain', phase = 'uncertain', error_code = ?, error_json = ?, updated_at = ? WHERE id = ?").run(code, asJson({ description }), now, operationId);
  });

  const scheduleRetry = (operationId: string, retryAt: number, code: string, description: string, now: number): void => database.transaction(() => {
    const row = assertOwner(operationId);
    const item = database.raw.query("SELECT preparation_state FROM queue_items WHERE id = ?").get(row.item_id) as { preparation_state: string };
    const pendingState = row.kind === "refresh" ? "refresh_pending" : "unprepared";
    database.raw.query("UPDATE queue_items SET preparation_state = ?, preparation_operation_id = NULL, retry_not_before = ?, last_error_code = ?, last_error = ? WHERE id = ? AND preparation_operation_id = ?").run(pendingState, retryAt, code, description, row.item_id, operationId);
    database.raw.query("UPDATE queue_preparation_operations SET state = 'failed', phase = 'failed', error_code = ?, error_json = ?, updated_at = ? WHERE id = ?").run(code, asJson({ description, previousState: item.preparation_state, retryAt }), now, operationId);
  });

  const markPreparationNeeded = (itemId: number, reason: "initial" | "refresh", now: number): void => {
    database.raw.query(`UPDATE queue_items SET preparation_state = CASE
      WHEN editorial_frozen_at IS NOT NULL AND representation_kind = 'prepared' THEN 'ready'
      WHEN ? = 'refresh' THEN 'refresh_pending' ELSE 'unprepared' END,
      retry_not_before = NULL WHERE id = ? AND preparation_operation_id IS NULL AND status NOT IN ('done','deleted','deleted_external')`).run(reason, itemId);
    database.raw.query("UPDATE queue_items SET last_error = NULL, last_error_code = NULL WHERE id = ? AND preparation_operation_id IS NULL").run(itemId);
    void now;
  };

  const markMemberMissing = (guard: PreparedExecutionGuard, memberKey: string, evidence: { method: string; code?: number; description: string }, now: number): { remainingCount: number; itemRemoved: boolean; nextGuard: PreparedExecutionGuard } => database.transaction(() => {
    const row = assertOwner(guard.operationId);
    const progress = validateExecutionProgress(JSON.parse(row.progress_json) as unknown);
    if (row.item_id !== guard.itemId || row.captured_content_version !== guard.capturedContentVersion || row.captured_source_generation !== guard.capturedSourceGeneration || progress.effectiveContentVersion !== guard.expectedContentVersion) throw conflict("Missing-member execution guard conflict");
    const currentItem = database.raw.query("SELECT content_version, source_generation, preparation_operation_id FROM queue_items WHERE id = ?").get(guard.itemId) as { content_version: number; source_generation: number; preparation_operation_id: string | null } | null;
    if (!currentItem || currentItem.content_version !== guard.expectedContentVersion || currentItem.source_generation !== guard.capturedSourceGeneration || currentItem.preparation_operation_id !== guard.operationId) throw conflict("Missing-member item version or owner changed");
    if (!evidence.method || !evidence.description) throw new Error("Confirmed missing evidence must name its method and description");
    const entry = progress.members.find((member) => member.memberKey === memberKey);
    if (!entry || entry.outcome !== "pending") throw conflict("Missing-member evidence does not match a pending member");
    const tombstone = database.raw.query("UPDATE queue_messages SET removed_at = ?, removal_reason = ? WHERE item_id = ? AND source_generation = ? AND member_key = ? AND removed_at IS NULL").run(now, `source_missing:${evidence.method}`, guard.itemId, guard.capturedSourceGeneration, memberKey);
    if (Number(tombstone.changes) !== 1) throw conflict("Queue member is no longer active");
    const nextVersion = guard.expectedContentVersion + 1;
    const nextProgress: ExecutionProgress = { version: 1, effectiveContentVersion: nextVersion, members: progress.members.map((member) => member.memberKey === memberKey ? { ...member, outcome: "confirmed_missing", outputIds: [], missingEvidence: evidence } : member) };
    const remaining = (database.raw.query("SELECT COUNT(*) AS count FROM queue_messages WHERE item_id = ? AND source_generation = ? AND removed_at IS NULL").get(guard.itemId, guard.capturedSourceGeneration) as { count: number }).count;
    if (remaining === 0) database.raw.query("UPDATE queue_items SET status = 'deleted_external', completed_at = ?, preparation_state = 'failed', preparation_operation_id = NULL, content_version = ?, last_error_code = 'all_sources_missing', last_error = 'All current source messages were confirmed missing' WHERE id = ? AND preparation_operation_id = ?").run(now, nextVersion, guard.itemId, guard.operationId);
    else database.raw.query("UPDATE queue_items SET first_message_id = (SELECT telegram_message_id FROM queue_messages WHERE item_id = ? AND source_generation = ? AND removed_at IS NULL ORDER BY ordinal, telegram_message_id LIMIT 1), content_version = ? WHERE id = ? AND preparation_operation_id = ?").run(guard.itemId, guard.capturedSourceGeneration, nextVersion, guard.itemId, guard.operationId);
    database.raw.query("UPDATE queue_preparation_operations SET progress_json = ?, updated_at = ? WHERE id = ? AND state IN ('running','outputs_recorded')").run(asJson(nextProgress), now, guard.operationId);
    if (remaining === 0) database.raw.query("UPDATE queue_preparation_operations SET state = 'failed', phase = 'failed', error_code = 'all_sources_missing', updated_at = ? WHERE id = ?").run(now, guard.operationId);
    return { remainingCount: remaining, itemRemoved: remaining === 0, nextGuard: { ...guard, expectedContentVersion: nextVersion } };
  });

  const heartbeatOperations = (now: number, bootId: string): number => Number(database.raw.query("UPDATE queue_preparation_operations SET lease_expires_at = ?, updated_at = ? WHERE boot_id = ? AND state IN ('running','outputs_recorded','cleanup_pending')").run(now + leaseMs, now, bootId).changes);

  const recoverExpiredOperations = (now: number, bootId: string): { requeued: number; uncertain: number; cleanupPending: number } => database.transaction(() => {
    const rows = database.raw.query("SELECT * FROM queue_preparation_operations WHERE state IN ('running','outputs_recorded','cleanup_pending') AND (lease_expires_at <= ? OR boot_id <> ?)").all(now, bootId) as PreparationRow[];
    let requeued = 0; let uncertain = 0; let cleanupPending = 0;
    for (const row of rows) {
      if (row.phase === "claimed") {
        const state = row.kind === "refresh" ? "refresh_pending" : "unprepared";
        database.raw.query("UPDATE queue_items SET preparation_state = ?, preparation_operation_id = NULL WHERE id = ? AND preparation_operation_id = ?").run(state, row.item_id, row.id);
        database.raw.query("UPDATE queue_preparation_operations SET state = 'failed', phase = 'failed', error_code = 'restart_before_mutation', updated_at = ? WHERE id = ?").run(now, row.id);
        requeued += 1;
      } else if (row.phase === "result_complete") {
        database.raw.exec("SAVEPOINT preparation_recovery_install");
        try {
          installPreparedGenerationTx(row, now);
          database.raw.exec("RELEASE SAVEPOINT preparation_recovery_install");
          cleanupPending += 1;
        } catch (error) {
          database.raw.exec("ROLLBACK TO SAVEPOINT preparation_recovery_install");
          database.raw.exec("RELEASE SAVEPOINT preparation_recovery_install");
          const description = error instanceof Error ? error.message : "Prepared result failed restart validation";
          database.raw.query("UPDATE queue_items SET status = 'needs_review', preparation_state = 'uncertain', preparation_operation_id = NULL, last_error_code = 'preparation_restart_result_invalid', last_error = ? WHERE id = ? AND preparation_operation_id = ?").run(description, row.item_id, row.id);
          database.raw.query("UPDATE queue_preparation_operations SET state = 'uncertain', phase = 'uncertain', error_code = 'preparation_restart_result_invalid', error_json = ?, updated_at = ? WHERE id = ?").run(asJson({ description }), now, row.id);
          uncertain += 1;
        }
      } else if (row.phase === "generation_installed" || row.phase === "source_cleanup_pending") {
        database.raw.query("UPDATE queue_preparation_operations SET state = 'cleanup_pending', boot_id = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?").run(bootId, now + leaseMs, now, row.id);
        cleanupPending += 1;
      } else {
        database.raw.query("UPDATE queue_items SET status = 'needs_review', preparation_state = 'uncertain', preparation_operation_id = NULL, last_error_code = 'preparation_restart_uncertain', last_error = 'Preparation may have produced queue messages; inspect operation evidence' WHERE id = ? AND preparation_operation_id = ?").run(row.item_id, row.id);
        database.raw.query("UPDATE queue_preparation_operations SET state = 'uncertain', phase = 'uncertain', error_code = 'preparation_restart_uncertain', updated_at = ? WHERE id = ?").run(now, row.id);
        uncertain += 1;
      }
    }
    return { requeued, uncertain, cleanupPending };
  });

  const finishCleanup = (operationId: string, now: number, cleanupError?: string): void => database.transaction(() => {
    const row = operation(operationId);
    if (!row || row.state !== "cleanup_pending") throw conflict("Preparation cleanup is not pending");
    if (cleanupError !== undefined) {
      database.raw.query("UPDATE queue_preparation_operations SET error_code = 'source_cleanup_failed', error_json = ?, updated_at = ? WHERE id = ?").run(asJson({ description: cleanupError }), now, operationId);
      return;
    }
    database.raw.query("UPDATE queue_preparation_operations SET state = 'done', phase = 'completed', updated_at = ? WHERE id = ? AND state = 'cleanup_pending'").run(now, operationId);
  });

  const listCleanupPending = (): Array<{ operationId: string; itemId: number; sourceIds: MessageId[] }> => {
    const rows = database.raw.query("SELECT id, item_id, source_ids_json FROM queue_preparation_operations WHERE state = 'cleanup_pending' ORDER BY created_at").all() as Array<{ id: string; item_id: number; source_ids_json: string }>;
    return rows.map((row) => ({ operationId: row.id, itemId: row.item_id, sourceIds: JSON.parse(row.source_ids_json) as MessageId[] }));
  };

  const operationEvidence = (itemId: number): Array<{ operationId: string; kind: string; state: string; phase: string; contract?: unknown; progress: unknown; result?: unknown; outputs: unknown[] }> => {
    const rows = database.raw.query("SELECT * FROM queue_preparation_operations WHERE item_id = ? ORDER BY created_at DESC").all(itemId) as PreparationRow[];
    return rows.map((row) => ({ operationId: row.id, kind: row.kind, state: row.state, phase: row.phase, ...(row.contract_json === "{}" ? {} : { contract: JSON.parse(row.contract_json) as unknown }), progress: JSON.parse(row.progress_json) as unknown, ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }), outputs: database.raw.query("SELECT chat_id, telegram_message_id, ordinal, output_key, step_key, source_member_key, role, snapshot_json FROM queue_preparation_outputs WHERE operation_id = ? ORDER BY ordinal").all(row.id) as unknown[] }));
  };

  const releaseForResolution = (operationId: string, action: "retry" | "retry_after_cleanup" | "discard" | "discard_after_cleanup", now: number): void => database.transaction(() => {
    const row = operation(operationId);
    if (!row || row.state !== "uncertain") throw conflict("Preparation operation is not uncertain");
    const hasOutputs = database.raw.query("SELECT 1 FROM queue_preparation_outputs WHERE operation_id = ? LIMIT 1").get(operationId) !== null;
    const retry = action === "retry" || action === "retry_after_cleanup";
    const cleanupConfirmed = action === "retry_after_cleanup" || action === "discard_after_cleanup";
    if (hasOutputs && !cleanupConfirmed) throw conflict("Known outputs must be deleted before retrying or discarding this preparation");
    if (!hasOutputs && cleanupConfirmed) throw conflict("No tracked preparation outputs exist for cleanup confirmation");
    const next = retry ? (row.kind === "refresh" ? "refresh_pending" : "unprepared") : "failed";
    const status = retry ? "queued" : "needs_review";
    const changed = database.raw.query("UPDATE queue_items SET preparation_state = ?, preparation_operation_id = NULL, status = ?, retry_not_before = NULL, content_version = content_version + 1 WHERE id = ? AND preparation_operation_id IS NULL AND status = 'needs_review' AND preparation_state = 'uncertain'").run(next, status, row.item_id);
    if (Number(changed.changes) !== 1) throw conflict("Preparation item changed before uncertainty resolution");
    database.raw.query("UPDATE queue_preparation_operations SET state = ?, phase = ?, error_code = ?, updated_at = ? WHERE id = ? AND state = 'uncertain'").run(retry ? "failed" : "done", retry ? "failed" : "completed", retry ? "admin_retry" : "admin_discard", now, operationId);
    database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES ('preparation_uncertainty_resolved', 'admin', ?, ?, ?, ?)")
      .run(row.item_id, operationId, JSON.stringify({ action, trackedOutputs: hasOutputs }), now);
  });

  return { claimNextPreparation, persistContract, setPhase, recordOutput, expectEdit, markEditRequestStarted, markEditRequestAccepted, markEditRequestRejected, markEditRequestUnknown, recordCompleteResult, installPreparedGeneration, completeInPlacePreparation, completeInPlaceRefresh, markFailed, markUncertain, scheduleRetry, markPreparationNeeded, markMemberMissing, heartbeatOperations, recoverExpiredOperations, finishCleanup, listCleanupPending, operationEvidence, releaseForResolution };
};

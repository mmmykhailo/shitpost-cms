import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database";
import { validateStoredMessageSnapshot } from "../domain/validation";
import type { StoredMessageSnapshot } from "../types";

export type GeneratedEventKind = "post" | "edit";
export type GeneratedEventFamily = "preparation" | "publication" | "renewal" | "recovery";
export type GeneratedEventMatch = { eventId: string; operationId: string; family: GeneratedEventFamily; provisional?: true };

type EventRow = {
  id: string;
  operation_id: string;
  operation_family: GeneratedEventFamily;
  chat_id: number;
  message_id: number;
  expected_fingerprint: string | null;
  expected_edit_date: number | null;
  observed_after_update_id: number | null;
  request_state: string;
  valid_until: number | null;
  provisional_snapshot_json: string | null;
  provisional_received_at: number | null;
  provisional_update_id: number | null;
};

const validTime = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe non-negative integer`);
};

export const createGeneratedEventRepository = (database: AppDatabase, idFactory: () => string = randomUUID) => {
  const expect = (input: { family: GeneratedEventFamily; operationId: string; chatId: number; messageId: number; kind: GeneratedEventKind; fingerprint?: string; snapshot?: StoredMessageSnapshot; now: number }): string => {
    if (!Number.isSafeInteger(input.chatId) || !Number.isSafeInteger(input.messageId) || input.messageId <= 0 || !input.operationId) throw new Error("Generated-event expectation identity is invalid");
    validTime(input.now, "Generated-event timestamp");
    if (input.kind !== "post" && input.kind !== "edit") throw new Error("Generated-event kind is invalid");
    const snapshot = input.snapshot === undefined ? undefined : validateStoredMessageSnapshot(input.snapshot);
    const existing = database.raw.query("SELECT id FROM queue_generated_events WHERE operation_family = ? AND operation_id = ? AND chat_id = ? AND message_id = ? AND event_kind = ? AND expected_fingerprint IS ? AND state = 'pending' LIMIT 1").get(input.family, input.operationId, input.chatId, input.messageId, input.kind, input.fingerprint ?? null) as { id: string } | null;
    if (existing) return existing.id;
    const id = idFactory();
    database.raw.query(`INSERT INTO queue_generated_events (id, operation_family, operation_id, chat_id, message_id, event_kind, expected_fingerprint, expected_snapshot_json, state, request_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, input.family, input.operationId, input.chatId, input.messageId, input.kind, input.fingerprint ?? null, snapshot === undefined ? null : JSON.stringify(snapshot), input.kind === "edit" ? "queued" : "legacy", input.now);
    return id;
  };

  const readEvent = (eventId: string): EventRow | undefined => database.raw.query(`SELECT id, operation_id, operation_family, chat_id, message_id, expected_fingerprint,
      expected_edit_date, observed_after_update_id, request_state, valid_until, provisional_snapshot_json, provisional_received_at, provisional_update_id
    FROM queue_generated_events WHERE id = ? AND event_kind = 'edit'`).get(eventId) as EventRow | null ?? undefined;

  const markEditRequestStarted = (eventId: string, startedAt: number, observedAfterUpdateId?: number): void => database.transaction(() => {
    validTime(startedAt, "Edit request start time");
    if (observedAfterUpdateId !== undefined && (!Number.isSafeInteger(observedAfterUpdateId) || observedAfterUpdateId < 0)) throw new Error("Observed update ID is invalid");
    const row = readEvent(eventId);
    if (!row || row.request_state !== "queued") throw new Error("Edit expectation is not queued for dispatch");
    const latest = observedAfterUpdateId ?? (database.raw.query(`SELECT MAX(COALESCE(telegram_update_id, CAST(json_extract(snapshot_json, '$.telegramUpdateId') AS INTEGER))) AS update_id
      FROM pending_queue_updates WHERE queue_chat_id = ?`).get(row.chat_id) as { update_id: number | null }).update_id ?? undefined;
    const changed = database.raw.query(`UPDATE queue_generated_events SET request_state = 'in_flight', request_started_at = ?, observed_after_update_id = ?
      WHERE id = ? AND event_kind = 'edit' AND state = 'pending' AND request_state = 'queued'`).run(startedAt, latest ?? null, eventId);
    if (Number(changed.changes) !== 1) throw new Error("Edit expectation changed before request initiation");
  });

  const provisionalMatches = (row: EventRow, snapshot: StoredMessageSnapshot, requestEditDate: number | undefined): boolean => {
    if (!row.expected_fingerprint || snapshot.contentFingerprint !== row.expected_fingerprint) return false;
    if (requestEditDate === undefined || snapshot.editDate === undefined || requestEditDate !== snapshot.editDate) return false;
    if (row.observed_after_update_id !== null && (snapshot.telegramUpdateId === undefined || snapshot.telegramUpdateId <= row.observed_after_update_id)) return false;
    return true;
  };

  const markEditRequestAccepted = (eventId: string, finishedAt: number, editDate?: number): { kind: "none" | "generated" | "collision"; snapshot?: StoredMessageSnapshot } => database.transaction(() => {
    validTime(finishedAt, "Edit request finish time");
    if (editDate !== undefined) validTime(editDate, "Returned Telegram edit date");
    const row = readEvent(eventId);
    if (!row || row.request_state !== "in_flight") throw new Error("Edit expectation is not in flight");
    const provisional = row.provisional_snapshot_json === null ? undefined : validateStoredMessageSnapshot(JSON.parse(row.provisional_snapshot_json) as unknown);
    const validUntil = finishedAt + 60_000;
    if (provisional && provisionalMatches(row, provisional, editDate)) {
      database.raw.query(`UPDATE queue_generated_events SET request_state = 'accepted', request_finished_at = ?, expected_edit_date = ?, valid_until = ?, state = 'matched', matched_at = ?
        WHERE id = ? AND request_state = 'in_flight' AND state = 'pending'`).run(finishedAt, editDate ?? null, validUntil, finishedAt, eventId);
      return { kind: "generated" };
    }
    database.raw.query(`UPDATE queue_generated_events SET request_state = 'accepted', request_finished_at = ?, expected_edit_date = ?, valid_until = ?
      WHERE id = ? AND request_state = 'in_flight' AND state = 'pending'`).run(finishedAt, editDate ?? null, validUntil, eventId);
    return provisional ? { kind: "collision", snapshot: provisional } : { kind: "none" };
  });

  type FailedEditOutcome = { eventId: string; operationId: string; family: GeneratedEventFamily; snapshot?: StoredMessageSnapshot };
  const finishFailedEdit = (eventId: string, finishedAt: number, state: "rejected" | "unknown"): FailedEditOutcome => database.transaction(() => {
    validTime(finishedAt, "Edit request finish time");
    const row = readEvent(eventId);
    if (!row || row.request_state !== "in_flight") throw new Error("Edit expectation is not in flight");
    database.raw.query(`UPDATE queue_generated_events SET request_state = ?, request_finished_at = ?, state = 'obsolete', matched_at = ?
      WHERE id = ? AND event_kind = 'edit' AND state = 'pending' AND request_state = 'in_flight'`).run(state, finishedAt, finishedAt, eventId);
    return { eventId, operationId: row.operation_id, family: row.operation_family, ...(row.provisional_snapshot_json === null ? {} : { snapshot: validateStoredMessageSnapshot(JSON.parse(row.provisional_snapshot_json) as unknown) }) };
  });

  const markEditRequestRejected = (eventId: string, finishedAt: number): FailedEditOutcome => finishFailedEdit(eventId, finishedAt, "rejected");
  const markEditRequestUnknown = (eventId: string, finishedAt: number): FailedEditOutcome => finishFailedEdit(eventId, finishedAt, "unknown");

  const incomingEdit = (row: EventRow, snapshotValue: StoredMessageSnapshot, now: number): GeneratedEventMatch | undefined => {
    const snapshot = validateStoredMessageSnapshot(snapshotValue);
    if (row.request_state === "in_flight") {
      if (row.provisional_snapshot_json !== null) {
        const previous = validateStoredMessageSnapshot(JSON.parse(row.provisional_snapshot_json) as unknown);
        let newer = now >= (row.provisional_received_at ?? 0);
        if (snapshot.editDate !== undefined && previous.editDate !== undefined && snapshot.editDate !== previous.editDate) newer = snapshot.editDate > previous.editDate;
        else if (snapshot.telegramUpdateId !== undefined && row.provisional_update_id !== null) newer = snapshot.telegramUpdateId > row.provisional_update_id;
        if (!newer) return { eventId: row.id, operationId: row.operation_id, family: row.operation_family, provisional: true };
      }
      database.raw.query("UPDATE queue_generated_events SET provisional_snapshot_json = ?, provisional_received_at = ?, provisional_update_id = ? WHERE id = ? AND request_state = 'in_flight' AND state = 'pending'")
        .run(JSON.stringify(snapshot), now, snapshot.telegramUpdateId ?? null, row.id);
      return { eventId: row.id, operationId: row.operation_id, family: row.operation_family, provisional: true };
    }
    if (row.request_state !== "accepted" || row.valid_until === null || row.valid_until < now || row.expected_edit_date === null || snapshot.editDate === undefined || snapshot.editDate !== row.expected_edit_date) return undefined;
    if (row.expected_fingerprint !== null && row.expected_fingerprint !== snapshot.contentFingerprint) return undefined;
    if (row.observed_after_update_id !== null && (snapshot.telegramUpdateId === undefined || snapshot.telegramUpdateId <= row.observed_after_update_id)) return undefined;
    return { eventId: row.id, operationId: row.operation_id, family: row.operation_family };
  };

  const consume = (chatId: number, messageId: number, kind: GeneratedEventKind, fingerprint: string | undefined, now: number, incomingSnapshot?: StoredMessageSnapshot): GeneratedEventMatch | undefined => database.transaction(() => {
    validTime(now, "Generated-event observation time");
    if (kind === "edit") {
      if (!incomingSnapshot) return undefined;
      const inFlight = database.raw.query(`SELECT id, operation_id, operation_family, chat_id, message_id, expected_fingerprint, expected_edit_date,
          observed_after_update_id, request_state, valid_until, provisional_snapshot_json, provisional_received_at, provisional_update_id
        FROM queue_generated_events WHERE chat_id = ? AND message_id = ? AND event_kind = 'edit' AND state = 'pending' AND request_state = 'in_flight'
        ORDER BY request_started_at DESC, created_at DESC LIMIT 1`).get(chatId, messageId) as EventRow | null;
      if (inFlight) return incomingEdit(inFlight, incomingSnapshot, now);
      const accepted = database.raw.query(`SELECT id, operation_id, operation_family, chat_id, message_id, expected_fingerprint, expected_edit_date,
          observed_after_update_id, request_state, valid_until, provisional_snapshot_json, provisional_received_at, provisional_update_id
        FROM queue_generated_events WHERE chat_id = ? AND message_id = ? AND event_kind = 'edit' AND state IN ('pending','matched') AND request_state = 'accepted'
          AND expected_fingerprint IS ? AND valid_until >= ? AND expected_edit_date = ?
          AND (state = 'pending' OR provisional_update_id = ?)
        ORDER BY request_finished_at DESC, created_at DESC LIMIT 1`).get(chatId, messageId, fingerprint ?? null, now, incomingSnapshot.editDate ?? null, incomingSnapshot.telegramUpdateId ?? null) as EventRow | null;
      if (!accepted) return undefined;
      const matched = incomingEdit(accepted, incomingSnapshot, now);
      if (matched && !matched.provisional) database.raw.query(`UPDATE queue_generated_events SET state = 'matched', matched_at = COALESCE(matched_at, ?),
          provisional_snapshot_json = COALESCE(provisional_snapshot_json, ?), provisional_received_at = COALESCE(provisional_received_at, ?), provisional_update_id = COALESCE(provisional_update_id, ?)
        WHERE id = ? AND state IN ('pending','matched') AND request_state = 'accepted'`).run(now, JSON.stringify(validateStoredMessageSnapshot(incomingSnapshot)), now, incomingSnapshot.telegramUpdateId ?? null, matched.eventId);
      return matched;
    }
    const row = database.raw.query(`SELECT id, operation_id, operation_family, chat_id, message_id, expected_fingerprint, expected_edit_date,
        observed_after_update_id, request_state, valid_until, provisional_snapshot_json, provisional_received_at, provisional_update_id
      FROM queue_generated_events WHERE chat_id = ? AND message_id = ? AND event_kind = ? AND state = 'pending'
        AND (expected_fingerprint IS NULL OR expected_fingerprint = ?)
      ORDER BY created_at, id LIMIT 1`)
      .get(chatId, messageId, kind, fingerprint ?? null) as EventRow | null;
    if (!row) return undefined;
    const changed = database.raw.query("UPDATE queue_generated_events SET state = 'matched', matched_at = ? WHERE id = ? AND state = 'pending'").run(now, row.id);
    return Number(changed.changes) === 1 ? { eventId: row.id, operationId: row.operation_id, family: row.operation_family } : undefined;
  });

  const obsoleteForOperation = (family: GeneratedEventFamily, operationId: string, now: number): number => Number(database.raw.query("UPDATE queue_generated_events SET state = 'obsolete', matched_at = ? WHERE operation_family = ? AND operation_id = ? AND state = 'pending'").run(now, family, operationId).changes);
  const purge = (before: number): number => database.transaction(() => {
    database.raw.query(`UPDATE queue_generated_events SET state = 'obsolete', matched_at = COALESCE(valid_until, created_at)
      WHERE event_kind = 'edit' AND request_state = 'accepted' AND state = 'pending' AND valid_until < ?`).run(before);
    return Number(database.raw.query(`DELETE FROM queue_generated_events WHERE created_at < ? AND state IN ('matched','obsolete')
      AND NOT EXISTS (SELECT 1 FROM queue_preparation_operations p WHERE p.id = queue_generated_events.operation_id AND p.state NOT IN ('done','failed'))
      AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = queue_generated_events.operation_id AND o.state NOT IN ('done','failed'))`).run(before).changes);
  });
  return { expect, consume, markEditRequestStarted, markEditRequestAccepted, markEditRequestRejected, markEditRequestUnknown, obsoleteForOperation, purge };
};

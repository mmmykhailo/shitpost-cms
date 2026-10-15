import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database";
import { validateStoredMessageSnapshot } from "../domain/validation";
import type { StoredMessageSnapshot } from "../types";

export type GeneratedEventKind = "post" | "edit";
export type GeneratedEventFamily = "preparation" | "publication" | "renewal" | "recovery";

export const createGeneratedEventRepository = (database: AppDatabase, idFactory: () => string = randomUUID) => {
  const expect = (input: { family: GeneratedEventFamily; operationId: string; chatId: number; messageId: number; kind: GeneratedEventKind; fingerprint?: string; snapshot?: StoredMessageSnapshot; now: number }): string => {
    if (!Number.isSafeInteger(input.chatId) || !Number.isSafeInteger(input.messageId) || input.messageId <= 0 || !input.operationId) throw new Error("Generated-event expectation identity is invalid");
    const snapshot = input.snapshot === undefined ? undefined : validateStoredMessageSnapshot(input.snapshot);
    const existing = database.raw.query("SELECT id FROM queue_generated_events WHERE operation_family = ? AND operation_id = ? AND chat_id = ? AND message_id = ? AND event_kind = ? AND expected_fingerprint IS ? AND state = 'pending' LIMIT 1").get(input.family, input.operationId, input.chatId, input.messageId, input.kind, input.fingerprint ?? null) as { id: string } | null;
    if (existing) return existing.id;
    const id = idFactory();
    database.raw.query(`INSERT INTO queue_generated_events (id, operation_family, operation_id, chat_id, message_id, event_kind, expected_fingerprint, expected_snapshot_json, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, input.family, input.operationId, input.chatId, input.messageId, input.kind, input.fingerprint ?? null, snapshot === undefined ? null : JSON.stringify(snapshot), input.now);
    return id;
  };

  const consume = (chatId: number, messageId: number, kind: GeneratedEventKind, fingerprint: string | undefined, now: number): { eventId: string; operationId: string; family: GeneratedEventFamily } | undefined => database.transaction(() => {
    const row = database.raw.query(`SELECT id, operation_id, operation_family FROM queue_generated_events
      WHERE chat_id = ? AND message_id = ? AND event_kind = ? AND state = 'pending'
        AND (expected_fingerprint IS NULL OR expected_fingerprint = ?)
      ORDER BY created_at, id LIMIT 1`)
      .get(chatId, messageId, kind, fingerprint ?? null) as { id: string; operation_id: string; operation_family: GeneratedEventFamily } | null;
    if (!row) return undefined;
    const changed = database.raw.query("UPDATE queue_generated_events SET state = 'matched', matched_at = ? WHERE id = ? AND state = 'pending'").run(now, row.id);
    if (Number(changed.changes) !== 1) return undefined;
    return { eventId: row.id, operationId: row.operation_id, family: row.operation_family };
  });

  const obsoleteForOperation = (family: GeneratedEventFamily, operationId: string, now: number): number => Number(database.raw.query("UPDATE queue_generated_events SET state = 'obsolete', matched_at = ? WHERE operation_family = ? AND operation_id = ? AND state = 'pending'").run(now, family, operationId).changes);
  const purge = (before: number): number => Number(database.raw.query(`DELETE FROM queue_generated_events WHERE created_at < ? AND state IN ('matched','obsolete')
    AND NOT EXISTS (SELECT 1 FROM queue_preparation_operations p WHERE p.id = queue_generated_events.operation_id AND p.state NOT IN ('done','failed'))
    AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = queue_generated_events.operation_id AND o.state NOT IN ('done','failed'))`).run(before).changes);
  return { expect, consume, obsoleteForOperation, purge };
};


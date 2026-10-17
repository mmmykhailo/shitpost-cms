import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database";
import { validateJsonPayload } from "../domain/validation";

const validateDescriptor = (value: unknown): Record<string, unknown> => {
  const payload = validateJsonPayload(value, "admin response descriptor");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("Admin response descriptor must be an object");
  const descriptor = payload as Record<string, unknown>;
  if (descriptor.version !== 1 || typeof descriptor.text !== "string") throw new Error("Admin response descriptor version or text is invalid");
  if (descriptor.entities !== undefined && (!Array.isArray(descriptor.entities) || descriptor.entities.some((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true;
    const entity = entry as Record<string, unknown>;
    return typeof entity.type !== "string" || !Number.isSafeInteger(entity.offset) || (entity.offset as number) < 0 || !Number.isSafeInteger(entity.length) || (entity.length as number) <= 0;
  }))) throw new Error("Admin response entities are invalid");
  if (descriptor.disableLinkPreview !== undefined && typeof descriptor.disableLinkPreview !== "boolean") throw new Error("Admin response link preview setting is invalid");
  if (descriptor.replyMarkup !== undefined) {
    const markup = descriptor.replyMarkup;
    if (typeof markup !== "object" || markup === null || Array.isArray(markup)) throw new Error("Admin response keyboard is invalid");
    const keyboard = markup as Record<string, unknown>;
    if (keyboard.kind === "force_reply") {
      if (keyboard.placeholder !== undefined && typeof keyboard.placeholder !== "string") throw new Error("Admin response prompt placeholder is invalid");
    } else if (keyboard.kind === "inline_keyboard" && Array.isArray(keyboard.rows) && keyboard.rows.every((row) => Array.isArray(row) && row.every((button) => {
      if (typeof button !== "object" || button === null || Array.isArray(button)) return false;
      const entry = button as Record<string, unknown>;
      return typeof entry.text === "string" && typeof entry.action === "string" && entry.payload !== undefined
        && (entry.itemVersion === undefined || Number.isSafeInteger(entry.itemVersion));
    }))) {
      // Valid semantic keyboard; callback tokens are generated at dispatch.
    } else throw new Error("Admin response keyboard is invalid");
  }
  if (descriptor.prompt !== undefined) {
    const prompt = descriptor.prompt;
    if (typeof prompt !== "object" || prompt === null || Array.isArray(prompt)) throw new Error("Admin response prompt metadata is invalid");
    const fields = prompt as Record<string, unknown>;
    if (!Number.isSafeInteger(fields.adminId) || typeof fields.generationId !== "string" || typeof fields.kind !== "string") throw new Error("Admin response prompt metadata is invalid");
  }
  if (descriptor.incident !== undefined) {
    const incident = descriptor.incident;
    if (typeof incident !== "object" || incident === null || Array.isArray(incident)) throw new Error("Admin response incident metadata is invalid");
    const fields = incident as Record<string, unknown>;
    if (typeof fields.id !== "string" || (fields.kind !== "warning" && fields.kind !== "recovery")) throw new Error("Admin response incident metadata is invalid");
  }
  if (descriptor.alert !== undefined) {
    const alert = descriptor.alert;
    if (typeof alert !== "object" || alert === null || Array.isArray(alert)) throw new Error("Admin response alert metadata is invalid");
    const fields = alert as Record<string, unknown>;
    if (typeof fields.dedupeKey !== "string" || (fields.fingerprint !== undefined && typeof fields.fingerprint !== "string") || !["periodic", "on_change", "resolution"].includes(String(fields.mode))) throw new Error("Admin response alert metadata is invalid");
  }
  return descriptor;
};

export type AdminResponseState = "pending" | "sending" | "sent" | "uncertain" | "failed" | "cancelled";
export type AdminResponseKind = "view" | "confirmation" | "prompt" | "warning" | "recovery" | "control";
export type AdminResponseRecord = {
  id: string;
  dedupeKey: string;
  updateId?: number;
  responseOrdinal?: number;
  adminChatId: number;
  kind: AdminResponseKind;
  descriptor: unknown;
  coalesceKey?: string;
  state: AdminResponseState;
  createdAt: number;
  nextAttemptAt: number;
  attemptCount: number;
  claimToken?: string;
  claimBootId?: string;
  leaseExpiresAt?: number;
  requestStartedAt?: number;
  telegramMessageId?: number;
  sentAt?: number;
  lastErrorKind?: string;
  lastErrorDescription?: string;
};

type ResponseRow = {
  id: string; dedupe_key: string; update_id: number | null; response_ordinal: number | null; admin_chat_id: number;
  kind: AdminResponseKind; descriptor_json: string; coalesce_key: string | null; state: AdminResponseState;
  created_at: number; next_attempt_at: number; attempt_count: number; claim_token: string | null; claim_boot_id: string | null;
  lease_expires_at: number | null; request_started_at: number | null; telegram_message_id: number | null; sent_at: number | null;
  last_error_kind: string | null; last_error_description: string | null;
};

const toRecord = (row: ResponseRow): AdminResponseRecord => ({
  id: row.id, dedupeKey: row.dedupe_key, adminChatId: row.admin_chat_id, kind: row.kind,
  descriptor: validateDescriptor(JSON.parse(row.descriptor_json) as unknown), state: row.state, createdAt: row.created_at,
  nextAttemptAt: row.next_attempt_at, attemptCount: row.attempt_count,
  ...(row.update_id === null ? {} : { updateId: row.update_id }),
  ...(row.response_ordinal === null ? {} : { responseOrdinal: row.response_ordinal }),
  ...(row.coalesce_key === null ? {} : { coalesceKey: row.coalesce_key }),
  ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
  ...(row.claim_boot_id === null ? {} : { claimBootId: row.claim_boot_id }),
  ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
  ...(row.request_started_at === null ? {} : { requestStartedAt: row.request_started_at }),
  ...(row.telegram_message_id === null ? {} : { telegramMessageId: row.telegram_message_id }),
  ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
  ...(row.last_error_kind === null ? {} : { lastErrorKind: row.last_error_kind }),
  ...(row.last_error_description === null ? {} : { lastErrorDescription: row.last_error_description }),
});

export const createAdminResponseRepository = (database: AppDatabase) => {
  const find = (id: string): AdminResponseRecord | undefined => {
    const row = database.raw.query("SELECT * FROM admin_response_outbox WHERE id = ?").get(id) as ResponseRow | null;
    return row === null ? undefined : toRecord(row);
  };

  const findByDedupeKey = (dedupeKey: string): AdminResponseRecord | undefined => {
    const row = database.raw.query("SELECT * FROM admin_response_outbox WHERE dedupe_key = ?").get(dedupeKey) as ResponseRow | null;
    return row === null ? undefined : toRecord(row);
  };

  const enqueue = (input: {
    dedupeKey?: string; updateId?: number; responseOrdinal?: number; adminChatId: number; kind: AdminResponseKind;
    descriptor: unknown; coalesceKey?: string; now: number;
  }): { record: AdminResponseRecord; inserted: boolean } => database.transaction(() => {
    if (!Number.isSafeInteger(input.adminChatId) || !Number.isSafeInteger(input.now) || input.now < 0) throw new RangeError("Invalid admin response destination or timestamp");
    if (input.updateId !== undefined && (!Number.isSafeInteger(input.updateId) || input.updateId < 0)) throw new RangeError("Admin response update ID must be a nonnegative safe integer");
    const ordinal = input.responseOrdinal ?? (input.updateId === undefined ? undefined : Number((database.raw.query("SELECT COALESCE(MAX(response_ordinal), -1) + 1 AS next FROM admin_response_outbox WHERE update_id = ?").get(input.updateId) as { next: number }).next));
    if (ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 0)) throw new RangeError("Admin response ordinal must be a nonnegative safe integer");
    const dedupeKey = input.dedupeKey ?? (input.updateId === undefined ? `response:${randomUUID()}` : `update:${input.updateId}:response:${ordinal}`);
    const existing = findByDedupeKey(dedupeKey);
    if (existing !== undefined) return { record: existing, inserted: false };
    const descriptorJson = JSON.stringify(validateDescriptor(input.descriptor));
    if (descriptorJson === undefined) throw new Error("Admin response descriptor must be JSON serializable");
    if (input.kind === "view" && input.coalesceKey !== undefined) {
      const pending = database.raw.query("SELECT id FROM admin_response_outbox WHERE coalesce_key = ? AND kind = 'view' AND state = 'pending' ORDER BY created_at DESC LIMIT 1").get(input.coalesceKey) as { id: string } | null;
      if (pending !== null) {
        const changed = database.raw.query(`UPDATE admin_response_outbox SET dedupe_key = ?, update_id = ?, response_ordinal = ?, admin_chat_id = ?, descriptor_json = ?, created_at = ?, next_attempt_at = ?, attempt_count = 0, last_error_kind = NULL, last_error_description = NULL
          WHERE id = ? AND state = 'pending'`).run(dedupeKey, input.updateId ?? null, ordinal ?? null, input.adminChatId, descriptorJson, input.now, input.now, pending.id);
        if (Number(changed.changes) === 1) return { record: find(pending.id)!, inserted: false };
      }
    }
    const id = randomUUID();
    database.raw.query(`INSERT INTO admin_response_outbox (id, dedupe_key, update_id, response_ordinal, admin_chat_id, kind, descriptor_version, descriptor_json, coalesce_key, state, created_at, next_attempt_at, attempt_count)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending', ?, ?, 0)`).run(id, dedupeKey, input.updateId ?? null, ordinal ?? null, input.adminChatId, input.kind, descriptorJson, input.coalesceKey ?? null, input.now, input.now);
    return { record: find(id)!, inserted: true };
  });

  const claimDue = (now: number, bootId: string, leaseMs = 60_000): AdminResponseRecord | undefined => database.transaction(() => {
    const row = database.raw.query(`SELECT * FROM admin_response_outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY CASE kind WHEN 'warning' THEN 0 WHEN 'recovery' THEN 0 WHEN 'confirmation' THEN 1 WHEN 'prompt' THEN 2 WHEN 'view' THEN 3 ELSE 4 END, created_at LIMIT 1`).get(now) as ResponseRow | null;
    if (row === null) return undefined;
    const token = randomUUID();
    const changed = database.raw.query(`UPDATE admin_response_outbox SET state = 'sending', claim_token = ?, claim_boot_id = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, request_started_at = NULL
      WHERE id = ? AND state = 'pending' AND next_attempt_at <= ?`).run(token, bootId, now + leaseMs, row.id, now);
    return Number(changed.changes) === 1 ? find(row.id) : undefined;
  });

  const markRequestStarted = (id: string, claimToken: string, now: number): boolean => Number(database.raw.query("UPDATE admin_response_outbox SET request_started_at = ? WHERE id = ? AND state = 'sending' AND claim_token = ? AND request_started_at IS NULL").run(now, id, claimToken).changes) === 1;
  const markSent = (id: string, claimToken: string, messageId: number, now: number): boolean => {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new RangeError("Delivered admin response message ID must be positive");
    return Number(database.raw.query(`UPDATE admin_response_outbox SET state = 'sent', telegram_message_id = ?, sent_at = ?, claim_token = NULL, claim_boot_id = NULL, lease_expires_at = NULL, last_error_kind = NULL, last_error_description = NULL
      WHERE id = ? AND state = 'sending' AND claim_token = ?`).run(messageId, now, id, claimToken).changes) === 1;
  };
  const markSentWithAcknowledgement = (id: string, claimToken: string, messageId: number, now: number, acknowledge: () => void): boolean => database.transaction(() => {
    if (!markSent(id, claimToken, messageId, now)) return false;
    acknowledge();
    return true;
  });
  const retry = (id: string, claimToken: string, nextAttemptAt: number, errorKind: string, description: string): boolean => Number(database.raw.query(`UPDATE admin_response_outbox SET state = 'pending', next_attempt_at = ?, claim_token = NULL, claim_boot_id = NULL, lease_expires_at = NULL, request_started_at = NULL, last_error_kind = ?, last_error_description = ?
    WHERE id = ? AND state = 'sending' AND claim_token = ?`).run(nextAttemptAt, errorKind, description, id, claimToken).changes) === 1;
  const finishFailed = (id: string, claimToken: string, state: "failed" | "uncertain", errorKind: string, description: string): boolean => Number(database.raw.query(`UPDATE admin_response_outbox SET state = ?, claim_token = NULL, claim_boot_id = NULL, lease_expires_at = NULL, last_error_kind = ?, last_error_description = ?
    WHERE id = ? AND state = 'sending' AND claim_token = ?`).run(state, errorKind, description, id, claimToken).changes) === 1;
  const cancel = (id: string, _now: number): boolean => Number(database.raw.query("UPDATE admin_response_outbox SET state = 'cancelled', claim_token = NULL, claim_boot_id = NULL, lease_expires_at = NULL, last_error_kind = 'cancelled', last_error_description = 'Superseded before delivery' WHERE id = ? AND (state = 'pending' OR (state = 'sending' AND request_started_at IS NULL))").run(id).changes) === 1;
  const cancelByDedupeKey = (dedupeKey: string, now: number): boolean => {
    const record = findByDedupeKey(dedupeKey);
    return record === undefined ? false : cancel(record.id, now);
  };
  const cancelPending = (coalesceKey: string, now: number): number => Number(database.raw.query("UPDATE admin_response_outbox SET state = 'cancelled', last_error_kind = 'cancelled', last_error_description = 'Superseded before delivery' WHERE coalesce_key = ? AND state = 'pending'").run(coalesceKey, now).changes);
  const rearmCancelled = (dedupeKey: string, descriptor: unknown, now: number): AdminResponseRecord | undefined => database.transaction(() => {
    const json = JSON.stringify(validateDescriptor(descriptor));
    if (json === undefined) throw new Error("Admin response descriptor must be JSON serializable");
    const changed = database.raw.query(`UPDATE admin_response_outbox SET state = 'pending', descriptor_json = ?, created_at = ?, next_attempt_at = ?, attempt_count = 0, claim_token = NULL, claim_boot_id = NULL, lease_expires_at = NULL, request_started_at = NULL, telegram_message_id = NULL, sent_at = NULL, last_error_kind = NULL, last_error_description = NULL
      WHERE dedupe_key = ? AND state = 'cancelled' AND request_started_at IS NULL AND telegram_message_id IS NULL`).run(json, now, now, dedupeKey);
    return Number(changed.changes) === 1 ? findByDedupeKey(dedupeKey) : undefined;
  });
  const rearmSent = (dedupeKey: string, descriptor: unknown, now: number): AdminResponseRecord | undefined => database.transaction(() => {
    const json = JSON.stringify(validateDescriptor(descriptor));
    if (json === undefined) throw new Error("Admin response descriptor must be JSON serializable");
    const changed = database.raw.query(`UPDATE admin_response_outbox SET state = 'pending', descriptor_json = ?, created_at = ?, next_attempt_at = ?, attempt_count = 0, claim_token = NULL, claim_boot_id = NULL, lease_expires_at = NULL, request_started_at = NULL, telegram_message_id = NULL, sent_at = NULL, last_error_kind = NULL, last_error_description = NULL
      WHERE dedupe_key = ? AND state = 'sent'`).run(json, now, now, dedupeKey);
    return Number(changed.changes) === 1 ? findByDedupeKey(dedupeKey) : undefined;
  });
  const recover = (now: number, bootId?: string): { requeued: number; uncertain: number } => database.transaction(() => {
    const lostClaim = "(lease_expires_at IS NULL OR lease_expires_at <= ? OR (? IS NOT NULL AND claim_boot_id IS NOT ?))";
    const uncertain = Number(database.raw.query(`UPDATE admin_response_outbox SET state = 'uncertain', claim_token = NULL, claim_boot_id = NULL, lease_expires_at = NULL, last_error_kind = 'restart_after_request_start', last_error_description = 'Telegram may have delivered this response before restart'
      WHERE state = 'sending' AND request_started_at IS NOT NULL AND ${lostClaim}`).run(now, bootId ?? null, bootId ?? null).changes);
    const requeued = Number(database.raw.query(`UPDATE admin_response_outbox SET state = 'pending', claim_token = NULL, claim_boot_id = NULL, lease_expires_at = NULL, next_attempt_at = ?, last_error_kind = 'restart_before_request', last_error_description = 'Response was not sent before restart'
      WHERE state = 'sending' AND request_started_at IS NULL AND ${lostClaim}`).run(now, now, bootId ?? null, bootId ?? null).changes);
    return { requeued, uncertain };
  });
  const counts = (): { pending: number; sending: number; uncertain: number; failed: number; oldestPendingAt?: number } => {
    const grouped = database.raw.query("SELECT state, COUNT(*) AS count FROM admin_response_outbox WHERE state IN ('pending','sending','uncertain','failed') GROUP BY state").all() as Array<{ state: string; count: number }>;
    const result: { pending: number; sending: number; uncertain: number; failed: number; oldestPendingAt?: number } = { pending: 0, sending: 0, uncertain: 0, failed: 0 };
    for (const row of grouped) if (row.state in result) result[row.state as keyof typeof result] = row.count as never;
    const oldest = database.raw.query("SELECT MIN(created_at) AS oldest FROM admin_response_outbox WHERE state = 'pending'").get() as { oldest: number | null };
    if (oldest.oldest !== null) result.oldestPendingAt = oldest.oldest;
    return result;
  };
  const purgeTerminal = (before: number): number => Number(database.raw.query("DELETE FROM admin_response_outbox WHERE state IN ('sent','failed','cancelled') AND created_at < ?").run(before).changes);

  return { find, findByDedupeKey, enqueue, claimDue, markRequestStarted, markSent, markSentWithAcknowledgement, retry, finishFailed, cancel, cancelByDedupeKey, cancelPending, rearmCancelled, rearmSent, recover, counts, purgeTerminal };
};

export type AdminResponseRepository = ReturnType<typeof createAdminResponseRepository>;

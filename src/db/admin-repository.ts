import { isReusableAction } from "../domain/admin-callback";
import { randomBytes } from "node:crypto";
import type { AppDatabase } from "./database";
import { StoredDataValidationError, validateJsonPayload } from "../domain/validation";

export type AdminRepository = ReturnType<typeof createAdminRepository>;

export const createAdminRepository = (database: AppDatabase) => {
  const setPrompt = (adminId: number, kind: string, state: unknown, replyToMessageId: number | undefined, now: number, ttlMs = 0): void => {
    const payload = validateJsonPayload(state, "admin prompt");
    database.raw.query("INSERT INTO admin_prompts (admin_id, kind, state_json, expected_reply_to_message_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(admin_id) DO UPDATE SET kind = excluded.kind, state_json = excluded.state_json, expected_reply_to_message_id = excluded.expected_reply_to_message_id, created_at = excluded.created_at, expires_at = excluded.expires_at").run(adminId, kind, JSON.stringify(payload), replyToMessageId ?? null, now, ttlMs === 0 ? 0 : now + ttlMs);
  };

  const setPendingPrompt = (adminId: number, kind: string, state: unknown, generationId: string, outboxId: string, now: number): void => {
    const payload = validateJsonPayload(state, "admin prompt");
    database.raw.query(`INSERT INTO admin_prompts (admin_id, kind, state_json, expected_reply_to_message_id, created_at, expires_at, generation_id, delivery_state, delivery_outbox_id)
      VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ?) ON CONFLICT(admin_id) DO UPDATE SET kind = excluded.kind, state_json = excluded.state_json, expected_reply_to_message_id = NULL, created_at = excluded.created_at, expires_at = excluded.expires_at, generation_id = excluded.generation_id, delivery_state = 'pending', delivery_outbox_id = excluded.delivery_outbox_id`).run(adminId, kind, JSON.stringify(payload), now, now, generationId, outboxId);
  };

  const activatePendingPrompt = (adminId: number, generationId: string, outboxId: string, messageId: number, now: number, ttlMs = 0): boolean => {
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || !Number.isSafeInteger(now) || now < 0) throw new RangeError("Invalid delivered prompt identity or time");
    return Number(database.raw.query(`UPDATE admin_prompts SET expected_reply_to_message_id = ?, delivery_state = 'active', expires_at = ?
      WHERE admin_id = ? AND generation_id = ? AND delivery_outbox_id = ? AND delivery_state = 'pending'`).run(messageId, ttlMs === 0 ? 0 : now + ttlMs, adminId, generationId, outboxId).changes) === 1;
  };

  const getPrompt = (adminId: number, now: number): { kind: string; state: unknown; deliveryState?: "pending" | "active"; generationId?: string; deliveryOutboxId?: string; expectedReplyToMessageId?: number } | undefined => {
    const row = database.raw.query("SELECT kind, state_json, expected_reply_to_message_id, expires_at, delivery_state, generation_id, delivery_outbox_id FROM admin_prompts WHERE admin_id = ?").get(adminId) as { kind: string; state_json: string; expected_reply_to_message_id: number | null; expires_at: number; delivery_state: "pending" | "active"; generation_id: string | null; delivery_outbox_id: string | null } | null;
    if (!row) return undefined;
    if (row.delivery_state === "active" && row.expires_at !== 0 && row.expires_at <= now) {
      database.raw.query("DELETE FROM admin_prompts WHERE admin_id = ?").run(adminId);
      return undefined;
    }
    let state: Record<string, unknown>;
    try {
      state = validateJsonPayload(JSON.parse(row.state_json) as unknown, "admin prompt");
    } catch (error) {
      if (!(error instanceof StoredDataValidationError)) throw error;
      database.raw.query("DELETE FROM admin_prompts WHERE admin_id = ?").run(adminId);
      return undefined;
    }
    const result: { kind: string; state: unknown; deliveryState?: "pending" | "active"; generationId?: string; deliveryOutboxId?: string; expectedReplyToMessageId?: number } = { kind: row.kind, state, deliveryState: row.delivery_state };
    if (row.generation_id !== null) result.generationId = row.generation_id;
    if (row.delivery_outbox_id !== null) result.deliveryOutboxId = row.delivery_outbox_id;
    if (row.expected_reply_to_message_id !== null) result.expectedReplyToMessageId = row.expected_reply_to_message_id;
    return result;
  };

  const clearPrompt = (adminId: number): void => { database.raw.query("DELETE FROM admin_prompts WHERE admin_id = ?").run(adminId); };

  const createCallbackToken = (adminId: number, action: string, payload: unknown, now: number, itemVersion?: number, ttlMs = 0, deliveryOutboxId?: string): string => {
    const token = randomBytes(12).toString("base64url");
    const validatedPayload = validateJsonPayload(payload, "callback token");
    database.raw.query("INSERT INTO callback_tokens (token, admin_id, action, payload_json, item_version, expires_at, legacy_token, delivery_outbox_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)").run(token, adminId, action, JSON.stringify(validatedPayload), itemVersion ?? null, ttlMs === 0 ? 0 : now + ttlMs, deliveryOutboxId ?? null);
    return token;
  };

  const consumeCallbackToken = (adminId: number, token: string, now: number): { action: string; payload: unknown; itemVersion?: number; legacy?: true } | undefined => database.transaction(() => {
    const row = database.raw.query("SELECT action, payload_json, item_version, expires_at, consumed_at, legacy_token FROM callback_tokens WHERE token = ? AND admin_id = ?").get(token, adminId) as { action: string; payload_json: string; item_version: number | null; expires_at: number; consumed_at: number | null; legacy_token: number } | null;
    if (!row || (!isReusableAction(row.action) && (row.consumed_at !== null || (row.expires_at !== 0 && row.expires_at <= now)))) return undefined;
    if (!isReusableAction(row.action)) database.raw.query("UPDATE callback_tokens SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL").run(now, token);
    let payload: Record<string, unknown>;
    try {
      payload = validateJsonPayload(JSON.parse(row.payload_json) as unknown, "callback token");
    } catch (error) {
      if (!(error instanceof StoredDataValidationError)) throw error;
      return undefined;
    }
    const result: { action: string; payload: unknown; itemVersion?: number; legacy?: true } = { action: row.action, payload };
    if (row.legacy_token === 1) result.legacy = true;
    if (row.item_version !== null) result.itemVersion = row.item_version;
    return result;
  });

  const callbackWasProcessed = (adminId: number, token: string): boolean => {
    const row = database.raw.query("SELECT consumed_at FROM callback_tokens WHERE token = ? AND admin_id = ?").get(token, adminId) as { consumed_at: number | null } | null;
    return row?.consumed_at !== null && row?.consumed_at !== undefined;
  };

  /** Captures only state that this action depends on, not wall-clock age. */
  const actionState = (action: string, payload: Record<string, unknown>): string => {
    if (typeof payload.itemId === "number") {
      const item = database.raw.query("SELECT status, content_version, source_generation, logical_sequence, maintenance_status, maintenance_operation_id, preparation_state, preparation_operation_id, last_error_code, claimed_operation_id FROM queue_items WHERE id = ?").get(payload.itemId) as Record<string, unknown> | null;
      if (action === "queue_move_execute" || action === "queue_move_first_execute") return JSON.stringify(item && { position: item.logical_sequence, status: item.status, maintenance: item.maintenance_status, operation: item.claimed_operation_id, preparationOperation: item.preparation_operation_id });
      const evidence = database.raw.query("SELECT id, phase, state FROM operations WHERE item_id = ? AND state NOT IN ('done','failed') ORDER BY id").all(payload.itemId);
      const outputs = database.raw.query("SELECT oo.* FROM operation_outputs oo JOIN operations o ON oo.operation_id = o.id WHERE o.item_id = ? ORDER BY oo.operation_id, oo.ordinal, oo.chat_id, oo.telegram_message_id").all(payload.itemId);
      const preparation = database.raw.query("SELECT id, phase, state, progress_json FROM queue_preparation_operations WHERE item_id = ? AND state NOT IN ('done','failed') ORDER BY id").all(payload.itemId);
      return JSON.stringify({ item, evidence, outputs, preparation });
    }
    if (typeof payload.userId === "number") return JSON.stringify(database.raw.query("SELECT alias_revision FROM known_authors WHERE user_id = ?").get(payload.userId));
    if (typeof payload.hiddenAuthorId === "number") return JSON.stringify(database.raw.query("SELECT alias_revision FROM known_hidden_authors WHERE id = ?").get(payload.hiddenAuthorId));
    if (typeof payload.signatureAuthorId === "number") return JSON.stringify(database.raw.query("SELECT alias_revision FROM known_queue_signature_authors WHERE id = ?").get(payload.signatureAuthorId));
    const resource = typeof payload.chatId === "number" ? `channel_whitelist:${payload.chatId}` : typeof payload.minuteOfDay === "number" ? `schedule_slots:${payload.minuteOfDay}` : undefined;
    return resource === undefined ? "{}" : JSON.stringify(database.raw.query("SELECT revision FROM admin_resource_revisions WHERE resource = ?").get(resource));
  };

  const audit = (eventType: string, actor: string, now: number, itemId?: number, operationId?: string, metadata: unknown = {}): void => {
    database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(eventType, actor, itemId ?? null, operationId ?? null, JSON.stringify(metadata), now);
  };

  const purgeExpiredTokensAndPrompts = (now: number): { tokens: number; prompts: number } => database.transaction(() => {
    database.raw.query("DELETE FROM callback_tokens WHERE delivery_outbox_id IN (SELECT id FROM admin_response_outbox WHERE state IN ('failed','cancelled'))").run();
    const rows = database.raw.query("SELECT token, action, consumed_at, expires_at FROM callback_tokens").all() as Array<{ token: string; action: string; consumed_at: number | null; expires_at: number }>;
    let tokens = 0;
    for (const row of rows) {
      if (!isReusableAction(row.action) && ((row.consumed_at !== null && row.consumed_at < now - 7 * 86_400_000) || (row.expires_at > 0 && row.expires_at < now))) {
        tokens += Number(database.raw.query("DELETE FROM callback_tokens WHERE token = ?").run(row.token).changes);
      }
    }
    const prompts = Number(database.raw.query("DELETE FROM admin_prompts WHERE delivery_state = 'active' AND expires_at > 0 AND expires_at < ?").run(now).changes);
    return { tokens, prompts };
  });

  const purgeAuditEvents = (before: number): number => Number(database.raw.query("DELETE FROM audit_events WHERE created_at < ?").run(before).changes);

  return { setPrompt, setPendingPrompt, activatePendingPrompt, getPrompt, clearPrompt, createCallbackToken, consumeCallbackToken, callbackWasProcessed, actionState, audit, purgeExpiredTokensAndPrompts, purgeAuditEvents };
};

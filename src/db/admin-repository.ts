import { randomBytes } from "node:crypto";
import type { AppDatabase } from "./database";

export type AdminRepository = ReturnType<typeof createAdminRepository>;

export const createAdminRepository = (database: AppDatabase) => {
  const setPrompt = (adminId: number, kind: string, state: unknown, replyToMessageId: number | undefined, now: number, ttlMs = 15 * 60_000): void => {
    database.raw.query("INSERT INTO admin_prompts (admin_id, kind, state_json, expected_reply_to_message_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(admin_id) DO UPDATE SET kind = excluded.kind, state_json = excluded.state_json, expected_reply_to_message_id = excluded.expected_reply_to_message_id, created_at = excluded.created_at, expires_at = excluded.expires_at").run(adminId, kind, JSON.stringify(state), replyToMessageId ?? null, now, now + ttlMs);
  };

  const getPrompt = (adminId: number, now: number): { kind: string; state: unknown; expectedReplyToMessageId?: number } | undefined => {
    const row = database.raw.query("SELECT kind, state_json, expected_reply_to_message_id, expires_at FROM admin_prompts WHERE admin_id = ?").get(adminId) as { kind: string; state_json: string; expected_reply_to_message_id: number | null; expires_at: number } | null;
    if (!row) return undefined;
    if (row.expires_at <= now) {
      database.raw.query("DELETE FROM admin_prompts WHERE admin_id = ?").run(adminId);
      return undefined;
    }
    const result: { kind: string; state: unknown; expectedReplyToMessageId?: number } = { kind: row.kind, state: JSON.parse(row.state_json) as unknown };
    if (row.expected_reply_to_message_id !== null) result.expectedReplyToMessageId = row.expected_reply_to_message_id;
    return result;
  };

  const clearPrompt = (adminId: number): void => { database.raw.query("DELETE FROM admin_prompts WHERE admin_id = ?").run(adminId); };

  const createCallbackToken = (adminId: number, action: string, payload: unknown, now: number, itemVersion?: number, ttlMs = 10 * 60_000): string => {
    const token = randomBytes(12).toString("base64url");
    database.raw.query("INSERT INTO callback_tokens (token, admin_id, action, payload_json, item_version, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(token, adminId, action, JSON.stringify(payload), itemVersion ?? null, now + ttlMs);
    return token;
  };

  const consumeCallbackToken = (adminId: number, token: string, now: number): { action: string; payload: unknown; itemVersion?: number } | undefined => database.transaction(() => {
    const row = database.raw.query("SELECT action, payload_json, item_version, expires_at FROM callback_tokens WHERE token = ? AND admin_id = ? AND consumed_at IS NULL").get(token, adminId) as { action: string; payload_json: string; item_version: number | null; expires_at: number } | null;
    if (!row || row.expires_at <= now) return undefined;
    database.raw.query("UPDATE callback_tokens SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL").run(now, token);
    const result: { action: string; payload: unknown; itemVersion?: number } = { action: row.action, payload: JSON.parse(row.payload_json) as unknown };
    if (row.item_version !== null) result.itemVersion = row.item_version;
    return result;
  });

  const audit = (eventType: string, actor: string, now: number, itemId?: number, operationId?: string, metadata: unknown = {}): void => {
    database.raw.query("INSERT INTO audit_events (event_type, actor, item_id, operation_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(eventType, actor, itemId ?? null, operationId ?? null, JSON.stringify(metadata), now);
  };

  const purgeExpiredTokensAndPrompts = (now: number): { tokens: number; prompts: number } => database.transaction(() => {
    const tokens = Number(database.raw.query("DELETE FROM callback_tokens WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR expires_at < ?").run(now - 7 * 86_400_000, now).changes);
    const prompts = Number(database.raw.query("DELETE FROM admin_prompts WHERE expires_at < ?").run(now).changes);
    return { tokens, prompts };
  });

  return { setPrompt, getPrompt, clearPrompt, createCallbackToken, consumeCallbackToken, audit, purgeExpiredTokensAndPrompts };
};

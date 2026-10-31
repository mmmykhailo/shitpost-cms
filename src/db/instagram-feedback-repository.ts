import { randomUUID } from "node:crypto";
import { validateJsonPayload } from "../domain/validation";
import type { AdminReplyMarkupIntent } from "../services/admin-response-worker";
import type { InstagramProgress } from "../services/instagram-feedback";
import type { AppDatabase } from "./database";

type Phase = InstagramProgress["phase"];
export type FeedbackClaim = {
  itemId: number; adminChatId: number; operationId: string; phase: Phase; text: string;
  replyMarkup?: AdminReplyMarkupIntent; revision: number; token: string;
  action: "send" | "edit" | "delete"; messageId?: number;
};
type Row = {
  item_id: number; admin_chat_id: number; operation_id: string; phase: Phase; text: string;
  reply_markup_json: string | null; revision: number; applied_revision: number; message_id: number | null;
  state: "pending" | "idle" | "claimed" | "uncertain" | "failed";
  next_attempt_at: number; claim_token: string | null; claim_boot_id: string | null;
  claim_json: string | null; lease_expires_at: number | null; request_started_at: number | null;
};
const rank: Record<Phase, number> = { downloading: 1, uploading: 2, retry: 3, failed: 4, uncertain: 4, cancelled: 4, ready: 5 };
const clearClaim = "claim_token = NULL, claim_boot_id = NULL, claim_json = NULL, lease_expires_at = NULL, request_started_at = NULL";

const markupJson = (markup: AdminReplyMarkupIntent | undefined): string | null => {
  if (markup === undefined) return null;
  validateJsonPayload(markup, "Instagram feedback keyboard");
  if (markup.kind === "force_reply") {
    if (markup.placeholder !== undefined && typeof markup.placeholder !== "string") throw new Error("Invalid feedback keyboard placeholder");
  } else if (markup.kind !== "inline_keyboard" || !Array.isArray(markup.rows) || !markup.rows.every((row) => Array.isArray(row) && row.every((button) =>
    button !== null && typeof button === "object" && typeof button.text === "string" && typeof button.action === "string"
    && button.payload !== undefined && (button.itemVersion === undefined || Number.isSafeInteger(button.itemVersion))))) throw new Error("Invalid feedback keyboard");
  return JSON.stringify(markup);
};

export type InstagramFeedbackRepository = ReturnType<typeof createInstagramFeedbackRepository>;
export const createInstagramFeedbackRepository = (database: AppDatabase) => {
  const find = (itemId: number): Row | undefined => database.raw.query("SELECT * FROM instagram_feedback WHERE item_id = ?").get(itemId) as Row | null ?? undefined;
  const owned = (claim: FeedbackClaim): Row | undefined => {
    const row = find(claim.itemId);
    return row?.state === "claimed" && row.claim_token === claim.token ? row : undefined;
  };
  const update = (input: {
    itemId: number; adminChatId: number; operationId: string; phase: Phase; text: string;
    replyMarkup?: AdminReplyMarkupIntent; now: number;
  }): void => database.transaction(() => {
    if (!Number.isSafeInteger(input.itemId) || input.itemId <= 0 || !Number.isSafeInteger(input.adminChatId)
      || !Number.isSafeInteger(input.now) || input.now < 0 || !input.operationId || !Object.hasOwn(rank, input.phase) || typeof input.text !== "string") throw new Error("Invalid Instagram feedback update");
    const markup = markupJson(input.replyMarkup);
    const row = find(input.itemId);
    if (row !== undefined) {
      if (row.operation_id !== input.operationId && database.raw.query("SELECT 1 FROM instagram_feedback_operations WHERE item_id = ? AND operation_id = ?").get(input.itemId, input.operationId)) return;
      if (row.operation_id === input.operationId && (rank[input.phase] < rank[row.phase]
        || (row.phase === input.phase && row.text === input.text && row.reply_markup_json === markup))) return;
      const state = row.state === "claimed" || row.state === "uncertain" ? row.state : input.phase === "ready" && row.message_id === null ? "idle" : "pending";
      database.raw.query(`UPDATE instagram_feedback SET admin_chat_id = ?, operation_id = ?, phase = ?, text = ?, reply_markup_json = ?,
        revision = revision + 1, state = ?, next_attempt_at = ?, updated_at = ? WHERE item_id = ?`)
        .run(input.adminChatId, input.operationId, input.phase, input.text, markup, state, input.now, input.now, input.itemId);
    } else {
      database.raw.query(`INSERT INTO instagram_feedback
        (item_id, admin_chat_id, operation_id, phase, text, reply_markup_json, revision, state, next_attempt_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(input.itemId, input.adminChatId, input.operationId, input.phase, input.text, markup, input.phase === "ready" ? "idle" : "pending", input.now, input.now);
    }
    database.raw.query("INSERT OR IGNORE INTO instagram_feedback_operations (item_id, operation_id) VALUES (?, ?)").run(input.itemId, input.operationId);
  });

  const claim = (now: number, bootId: string): FeedbackClaim | undefined => database.transaction(() => {
    const row = database.raw.query("SELECT * FROM instagram_feedback WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, item_id LIMIT 1").get(now) as Row | null;
    if (row === null) return undefined;
    const snapshot: FeedbackClaim = {
      itemId: row.item_id, adminChatId: row.admin_chat_id, operationId: row.operation_id, phase: row.phase, text: row.text,
      revision: row.revision, token: randomUUID(), action: row.phase === "ready" ? "delete" : row.message_id === null ? "send" : "edit",
      ...(row.message_id === null ? {} : { messageId: row.message_id }),
      ...(row.reply_markup_json === null ? {} : { replyMarkup: JSON.parse(row.reply_markup_json) as AdminReplyMarkupIntent }),
    };
    database.raw.query(`UPDATE instagram_feedback SET state = 'claimed', claim_token = ?, claim_boot_id = ?, claim_json = ?, lease_expires_at = ?, request_started_at = NULL WHERE item_id = ?`)
      .run(snapshot.token, bootId, JSON.stringify(snapshot), now + 60_000, row.item_id);
    return snapshot;
  });
  const begin = (snapshot: FeedbackClaim, now: number): boolean => database.transaction(() => {
    const row = owned(snapshot);
    if (row?.phase === "ready" && row.message_id === null && row.request_started_at === null) {
      database.raw.query(`UPDATE instagram_feedback SET state = 'idle', updated_at = ?, ${clearClaim} WHERE item_id = ?`).run(now, row.item_id);
      return false;
    }
    return Number(database.raw.query(`UPDATE instagram_feedback SET request_started_at = ?
      WHERE item_id = ? AND state = 'claimed' AND claim_token = ? AND request_started_at IS NULL AND lease_expires_at > ?`)
      .run(now, snapshot.itemId, snapshot.token, now).changes) === 1;
  });
  const complete = (snapshot: FeedbackClaim, messageId: number | undefined, now: number): void => database.transaction(() => {
    const row = owned(snapshot);
    if (row === undefined || row.request_started_at === null) return;
    if (snapshot.action === "send" && (!Number.isSafeInteger(messageId) || messageId! <= 0)) throw new Error("Feedback send requires a positive message ID");
    const id = snapshot.action === "delete" ? null : snapshot.action === "send" ? messageId! : row.message_id;
    const pending = row.revision !== snapshot.revision && !(row.phase === "ready" && id === null);
    database.raw.query(`UPDATE instagram_feedback SET message_id = ?, applied_revision = ?, state = ?, next_attempt_at = ?, updated_at = ?, last_error_code = NULL, ${clearClaim} WHERE item_id = ?`)
      .run(id, snapshot.revision, pending ? "pending" : "idle", now, now, snapshot.itemId);
  });
  const retry = (snapshot: FeedbackClaim, retryAt: number, code: string, now: number): void => {
    database.raw.query(`UPDATE instagram_feedback SET state = CASE WHEN phase = 'ready' AND message_id IS NULL THEN 'idle' ELSE 'pending' END,
      next_attempt_at = ?, last_error_code = ?, updated_at = ?, ${clearClaim} WHERE item_id = ? AND state = 'claimed' AND claim_token = ?`)
      .run(retryAt, code, now, snapshot.itemId, snapshot.token);
  };
  const fail = (snapshot: FeedbackClaim, code: string, now: number): void => {
    database.raw.query(`UPDATE instagram_feedback SET state = CASE WHEN message_id IS NULL AND request_started_at IS NOT NULL THEN 'uncertain'
      WHEN revision <> ? THEN CASE WHEN phase = 'ready' AND message_id IS NULL THEN 'idle' ELSE 'pending' END ELSE 'failed' END,
      last_error_code = ?, updated_at = ?, ${clearClaim} WHERE item_id = ? AND state = 'claimed' AND claim_token = ?`)
      .run(snapshot.revision, code, now, snapshot.itemId, snapshot.token);
  };
  const recover = (now: number, bootId: string): void => {
    database.raw.query(`UPDATE instagram_feedback SET state = CASE
      WHEN message_id IS NULL AND request_started_at IS NOT NULL THEN 'uncertain'
      WHEN phase = 'ready' AND message_id IS NULL THEN 'idle' ELSE 'pending' END,
      next_attempt_at = ?, updated_at = ?, last_error_code = 'interrupted', ${clearClaim}
      WHERE state = 'claimed' AND (claim_boot_id <> ? OR lease_expires_at <= ?)`)
      .run(now, now, bootId, now);
  };
  // Suppress a generic issue alert only while this exact content revision has a
  // viable dedicated error notice. Delivery failure restores the fallback alert.
  const handlesIssue = (itemId: number, contentVersion: number): boolean => database.raw.query(`SELECT 1
    FROM instagram_feedback f JOIN queue_preparation_operations p ON p.id = f.operation_id AND p.item_id = f.item_id
    WHERE f.item_id = ? AND p.captured_content_version = ?
      AND f.phase IN ('failed','uncertain','cancelled') AND f.state IN ('pending','claimed','idle')`)
    .get(itemId, contentVersion) !== null;
  return { update, claim, begin, complete, retry, fail, recover, handlesIssue };
};

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type AppDatabase } from "../src/db/database";
import type { LogFields, Logger } from "../src/logger";
import type { DeliveryMode } from "../src/types";

export type TestDatabase = {
  directory: string;
  path: string;
  database: AppDatabase;
  close(): void;
};

export const createTestDatabase = (prefix = "queuebot-test"): TestDatabase => {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const path = join(directory, "bot.sqlite");
  const database = createDatabase(path);
  let closed = false;
  return {
    directory,
    path,
    database,
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

export type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields: LogFields;
};

export type LoggerSpy = {
  logger: Logger;
  entries: LogEntry[];
};

export const createLoggerSpy = (): LoggerSpy => {
  const entries: LogEntry[] = [];
  const record = (level: LogEntry["level"], event: string, fields: LogFields = {}): void => {
    entries.push({ level, event, fields });
  };
  return {
    entries,
    logger: {
      debug: (event, fields) => record("debug", event, fields),
      info: (event, fields) => record("info", event, fields),
      warn: (event, fields) => record("warn", event, fields),
      error: (event, fields) => record("error", event, fields),
    },
  };
};

/** Explicit test-only fixture for a fully installed prepared queue representation. */
export const markQueueItemPrepared = (database: AppDatabase, itemId: number, deliveryMode: DeliveryMode, preparedAt = Date.now()): void => {
  const item = database.raw.query("SELECT source_generation FROM queue_items WHERE id = ?").get(itemId) as { source_generation: number } | null;
  if (!item) throw new Error(`Queue test fixture ${itemId} does not exist`);
  const members = database.raw.query("SELECT telegram_message_id, snapshot_json, ordinal FROM queue_messages WHERE item_id = ? AND source_generation = ? AND removed_at IS NULL ORDER BY ordinal, telegram_message_id").all(itemId, item.source_generation) as Array<{ telegram_message_id: number; snapshot_json: string; ordinal: number }>;
  for (const member of members) {
    const snapshot = JSON.parse(member.snapshot_json) as { mediaGroupId?: string };
    database.raw.query("UPDATE queue_messages SET member_key = COALESCE(member_key, ?), member_role = 'content', member_delivery_mode = ?, album_key = COALESCE(album_key, ?) WHERE item_id = ? AND source_generation = ? AND telegram_message_id = ?")
      .run(`legacy:${member.telegram_message_id}`, deliveryMode, snapshot.mediaGroupId ?? null, itemId, item.source_generation, member.telegram_message_id);
  }
  database.raw.query(`UPDATE queue_items SET representation_kind = 'prepared', preparation_state = 'ready', preparation_operation_id = NULL,
    delivery_mode = ?, policy_captured_at = COALESCE(policy_captured_at, ?), prepared_at = ?, nickname_revision_applied = nickname_revision_wanted,
    attribution_json = COALESCE(attribution_json, '{"ownership":"none"}') WHERE id = ?`)
    .run(deliveryMode, preparedAt, preparedAt, itemId);
};

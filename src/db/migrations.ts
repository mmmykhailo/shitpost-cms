import type { Database } from "bun:sqlite";

type Migration = { version: number; statements: readonly string[] };

const migrations: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        bot_id INTEGER,
        bot_username TEXT,
        created_at INTEGER NOT NULL,
        last_clean_shutdown_at INTEGER,
        last_scheduler_scan_at INTEGER,
        last_successful_update_at INTEGER
      )`,
      `INSERT INTO app_state (id, created_at) VALUES (1, unixepoch('now') * 1000)`,
      `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        updated_by_admin_id INTEGER
      )`,
      `CREATE TABLE schedule_slots (
        minute_of_day INTEGER PRIMARY KEY CHECK (minute_of_day BETWEEN 0 AND 1439),
        created_at INTEGER NOT NULL,
        created_by_admin_id INTEGER NOT NULL
      )`,
      `CREATE TABLE schedule_runs (
        occurrence_at INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending','running','published','empty','blocked','failed','skipped_downtime')),
        item_id INTEGER,
        operation_id TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        error_code TEXT,
        FOREIGN KEY (item_id) REFERENCES queue_items(id) ON DELETE SET NULL
      )`,
      `CREATE TABLE queue_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        logical_sequence INTEGER NOT NULL UNIQUE,
        queue_chat_id INTEGER NOT NULL,
        media_group_id TEXT,
        first_message_id INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        origin_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('collecting','queued','publishing','published_cleanup_pending','renewing','renewed_cleanup_pending','blocked','needs_edit','needs_review','uncertain_publish','uncertain_renewal','delete_blocked','done','deleted','deleted_external')),
        content_version INTEGER NOT NULL DEFAULT 1,
        source_generation INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        enqueued_at INTEGER NOT NULL,
        physical_created_at INTEGER NOT NULL,
        last_renewed_at INTEGER,
        retry_not_before INTEGER,
        last_error_code TEXT,
        last_error TEXT,
        destination_message_ids_json TEXT,
        claimed_operation_id TEXT,
        claimed_at INTEGER,
        album_quiet_deadline INTEGER,
        album_max_deadline INTEGER,
        published_at INTEGER,
        completed_at INTEGER,
        CHECK (content_version > 0),
        CHECK (source_generation >= 0)
      )`,
      `CREATE TABLE queue_messages (
        item_id INTEGER NOT NULL,
        source_generation INTEGER NOT NULL,
        queue_chat_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        telegram_date INTEGER NOT NULL,
        edit_date INTEGER,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (item_id, source_generation, telegram_message_id),
        UNIQUE (queue_chat_id, telegram_message_id),
        FOREIGN KEY (item_id) REFERENCES queue_items(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('publish','manual_publish','renew','delete','recover')),
        item_id INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('running','outputs_recorded','cleanup_pending','uncertain','done','failed')),
        captured_content_version INTEGER NOT NULL,
        captured_source_generation INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        error_code TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (item_id) REFERENCES queue_items(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE operation_outputs (
        operation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('destination','replacement','temporary_preview')),
        chat_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (operation_id, kind, chat_id, telegram_message_id),
        UNIQUE (chat_id, telegram_message_id),
        FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE orphaned_sources (
        item_id INTEGER NOT NULL,
        source_generation INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        reason TEXT NOT NULL,
        first_attempt_at INTEGER NOT NULL,
        last_attempt_at INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY (item_id, source_generation, chat_id, telegram_message_id),
        FOREIGN KEY (item_id) REFERENCES queue_items(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE channel_whitelist (
        chat_id INTEGER PRIMARY KEY,
        username TEXT,
        title TEXT,
        added_at INTEGER NOT NULL,
        added_by_admin_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE known_authors (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        normalized_username TEXT,
        display_name TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )`,
      `CREATE UNIQUE INDEX known_authors_username_idx ON known_authors(normalized_username) WHERE normalized_username IS NOT NULL`,
      `CREATE TABLE author_aliases (
        user_id INTEGER PRIMARY KEY,
        nickname TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by_admin_id INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES known_authors(user_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE admin_prompts (
        admin_id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        state_json TEXT NOT NULL,
        expected_reply_to_message_id INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE TABLE callback_tokens (
        token TEXT PRIMARY KEY,
        admin_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        item_version INTEGER,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      )`,
      `CREATE TABLE admin_alerts (
        dedupe_key TEXT PRIMARY KEY,
        severity TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_sent_at INTEGER,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        resolved_at INTEGER
      )`,
      `CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        item_id INTEGER,
        operation_id TEXT,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (item_id) REFERENCES queue_items(id) ON DELETE SET NULL
      )`,
      `CREATE TABLE runtime_leases (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX queue_active_idx ON queue_items(status, logical_sequence)`,
      `CREATE INDEX queue_sequence_idx ON queue_items(logical_sequence)`,
      `CREATE INDEX queue_messages_current_idx ON queue_messages(item_id, source_generation, ordinal)`,
      `CREATE INDEX operations_recovery_idx ON operations(state, updated_at)`,
      `CREATE INDEX schedule_runs_status_idx ON schedule_runs(status, occurrence_at)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE generated_messages (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('renewal','recovery_preview')),
        created_at INTEGER NOT NULL,
        consumed_at INTEGER,
        PRIMARY KEY (chat_id, message_id)
      )`,
      `CREATE INDEX generated_messages_pending_idx ON generated_messages(chat_id, message_id, consumed_at)`,
    ],
  },
];

export const applyMigrations = (db: Database): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  for (const migration of migrations) {
    const applied = db.query("SELECT version FROM schema_migrations WHERE version = ?").get(migration.version) as { version: number } | null;
    if (applied) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
};

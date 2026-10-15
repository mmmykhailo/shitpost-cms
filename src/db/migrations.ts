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
  {
    version: 3,
    statements: [
      `ALTER TABLE app_state ADD COLUMN current_boot_id TEXT`,
      `ALTER TABLE queue_items ADD COLUMN maintenance_status TEXT NOT NULL DEFAULT 'idle' CHECK (maintenance_status IN ('idle','renewing','renewal_cleanup_pending','uncertain_renewal'))`,
      `ALTER TABLE queue_items ADD COLUMN maintenance_operation_id TEXT`,
      `ALTER TABLE queue_items ADD COLUMN maintenance_retry_not_before INTEGER`,
      `CREATE INDEX queue_maintenance_idx ON queue_items(maintenance_status, physical_created_at, logical_sequence)`,
      `INSERT INTO audit_events (event_type, actor, item_id, metadata_json, created_at)
       SELECT 'legacy_renewal_quarantined', 'migration', id,
         json_object('previousStatus', status, 'maintenanceStatus', 'uncertain_renewal'),
         unixepoch('now') * 1000
       FROM queue_items
       WHERE status IN ('renewing', 'renewed_cleanup_pending', 'uncertain_renewal')`,
      `UPDATE queue_items
       SET status = 'needs_review',
           maintenance_status = 'uncertain_renewal',
           maintenance_operation_id = claimed_operation_id,
           last_error_code = 'legacy_renewal_state',
           last_error = 'Legacy renewal state requires explicit physical resolution'
       WHERE status IN ('renewing', 'renewed_cleanup_pending', 'uncertain_renewal')`,
      `ALTER TABLE operations ADD COLUMN boot_id TEXT`,
      `ALTER TABLE operations ADD COLUMN phase TEXT NOT NULL DEFAULT 'legacy'`,
      `ALTER TABLE operations ADD COLUMN return_item_status TEXT`,
      `ALTER TABLE operations ADD COLUMN expected_source_count INTEGER`,
      `ALTER TABLE operations ADD COLUMN expected_output_count INTEGER`,
      `ALTER TABLE operations ADD COLUMN source_ids_json TEXT`,
      `ALTER TABLE operations ADD COLUMN plan_json TEXT`,
      `UPDATE operations SET phase = CASE state WHEN 'done' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'uncertain' THEN 'uncertain' ELSE 'legacy' END`,
      `ALTER TABLE operation_outputs ADD COLUMN role TEXT NOT NULL DEFAULT 'legacy'`,
      `UPDATE operation_outputs SET role = CASE kind WHEN 'destination' THEN 'transferred' WHEN 'replacement' THEN 'replacement' WHEN 'temporary_preview' THEN 'temporary_preview' ELSE 'legacy' END`,
      `CREATE TABLE pending_queue_updates (
        queue_chat_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        media_group_id TEXT,
        snapshot_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        process_after INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','quarantined_renewal_candidate','consumed_generated','ingested','discarded')),
        candidate_operation_id TEXT,
        last_error TEXT,
        PRIMARY KEY (queue_chat_id, telegram_message_id)
      )`,
      `CREATE INDEX pending_queue_updates_state_idx ON pending_queue_updates(state, process_after)`,
      `CREATE INDEX pending_queue_updates_candidate_idx ON pending_queue_updates(candidate_operation_id, state)`,
      `ALTER TABLE orphaned_sources ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE orphaned_sources ADD COLUMN next_attempt_at INTEGER`,
      `ALTER TABLE orphaned_sources ADD COLUMN terminal_reason TEXT`,
      `ALTER TABLE schedule_slots ADD COLUMN effective_at INTEGER NOT NULL DEFAULT 0`,
      `UPDATE schedule_slots SET effective_at = created_at WHERE effective_at = 0`,
      `CREATE TABLE schedule_slot_history (
        minute_of_day INTEGER NOT NULL CHECK (minute_of_day BETWEEN 0 AND 1439),
        effective_from INTEGER NOT NULL,
        effective_until INTEGER,
        actor_admin_id INTEGER NOT NULL,
        PRIMARY KEY (minute_of_day, effective_from)
      )`,
      `INSERT INTO schedule_slot_history (minute_of_day, effective_from, actor_admin_id)
       SELECT minute_of_day, effective_at, created_by_admin_id FROM schedule_slots`,
      `CREATE TABLE recovery_sessions (
        id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        item_id INTEGER,
        boot_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (item_id) REFERENCES queue_items(id) ON DELETE SET NULL
      )`,
      `CREATE TABLE recovery_previews (
        session_id TEXT NOT NULL,
        source_message_id INTEGER NOT NULL,
        preview_chat_id INTEGER,
        preview_message_id INTEGER,
        ordinal INTEGER NOT NULL,
        snapshot_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, source_message_id),
        UNIQUE (preview_chat_id, preview_message_id),
        FOREIGN KEY (session_id) REFERENCES recovery_sessions(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX recovery_sessions_recovery_idx ON recovery_sessions(phase, lease_expires_at)`,
    ],
  },
  {
    version: 4,
    statements: [
      `ALTER TABLE queue_items ADD COLUMN preparation_state TEXT NOT NULL DEFAULT 'unprepared' CHECK (preparation_state IN ('unprepared','preparing','ready','refresh_pending','refreshing','failed','uncertain'))`,
      `ALTER TABLE queue_items ADD COLUMN representation_kind TEXT NOT NULL DEFAULT 'raw' CHECK (representation_kind IN ('raw','prepared'))`,
      `ALTER TABLE queue_items ADD COLUMN delivery_mode TEXT CHECK (delivery_mode IN ('copy','forward'))`,
      `ALTER TABLE queue_items ADD COLUMN policy_captured_at INTEGER`,
      `ALTER TABLE queue_items ADD COLUMN prepared_at INTEGER`,
      `ALTER TABLE queue_items ADD COLUMN preparation_operation_id TEXT`,
      `ALTER TABLE queue_items ADD COLUMN nickname_revision_wanted INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE queue_items ADD COLUMN nickname_revision_applied INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE queue_items ADD COLUMN attribution_json TEXT`,
      `UPDATE queue_items
       SET delivery_mode = CASE
             WHEN json_extract(origin_json, '$.kind') = 'channel'
              AND EXISTS (SELECT 1 FROM channel_whitelist WHERE chat_id = json_extract(queue_items.origin_json, '$.chatId')) THEN 'forward'
             ELSE 'copy' END,
           policy_captured_at = COALESCE(policy_captured_at, unixepoch('now') * 1000)
       WHERE delivery_mode IS NULL`,
      `ALTER TABLE queue_messages ADD COLUMN member_key TEXT`,
      `UPDATE queue_messages SET member_key = 'legacy:' || telegram_message_id WHERE member_key IS NULL`,
      `ALTER TABLE queue_messages ADD COLUMN member_role TEXT NOT NULL DEFAULT 'content' CHECK (member_role IN ('content','credit'))`,
      `ALTER TABLE queue_messages ADD COLUMN member_delivery_mode TEXT CHECK (member_delivery_mode IN ('copy','forward'))`,
      `UPDATE queue_messages
       SET member_delivery_mode = CASE
         WHEN COALESCE(json_extract(snapshot_json, '$.nativeOrigin.kind'), json_extract(snapshot_json, '$.origin.kind')) = 'channel' THEN 'forward'
         ELSE 'copy' END`,
      `ALTER TABLE queue_messages ADD COLUMN album_key TEXT`,
      `ALTER TABLE queue_messages ADD COLUMN removed_at INTEGER`,
      `ALTER TABLE queue_messages ADD COLUMN removal_reason TEXT`,
      `CREATE UNIQUE INDEX queue_messages_member_key_idx ON queue_messages(item_id, source_generation, member_key) WHERE member_key IS NOT NULL`,
      `ALTER TABLE known_authors ADD COLUMN alias_revision INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE operations ADD COLUMN progress_json TEXT`,
      `ALTER TABLE pending_queue_updates ADD COLUMN update_kind TEXT NOT NULL DEFAULT 'post' CHECK (update_kind IN ('post','edit'))`,
      `ALTER TABLE pending_queue_updates ADD COLUMN telegram_update_id INTEGER`,
      `ALTER TABLE pending_queue_updates ADD COLUMN captured_delivery_mode TEXT CHECK (captured_delivery_mode IN ('copy','forward'))`,
      `ALTER TABLE pending_queue_updates ADD COLUMN policy_captured_at INTEGER`,
      `ALTER TABLE admin_alerts ADD COLUMN notification_mode TEXT NOT NULL DEFAULT 'periodic' CHECK (notification_mode IN ('periodic','on_change'))`,
      `ALTER TABLE admin_alerts ADD COLUMN condition_fingerprint TEXT`,
      `ALTER TABLE admin_alerts ADD COLUMN sent_fingerprint TEXT`,
      `ALTER TABLE admin_alerts ADD COLUMN payload_json TEXT`,
      `ALTER TABLE admin_alerts ADD COLUMN delivery_retry_not_before INTEGER`,
      `ALTER TABLE admin_alerts ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0`,
      `CREATE TABLE known_hidden_authors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_name TEXT NOT NULL COLLATE BINARY UNIQUE,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        alias_revision INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE hidden_author_aliases (
        hidden_author_id INTEGER PRIMARY KEY,
        nickname TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by_admin_id INTEGER NOT NULL,
        FOREIGN KEY (hidden_author_id) REFERENCES known_hidden_authors(id) ON DELETE CASCADE
      )`,
      `INSERT INTO known_hidden_authors (sender_name, first_seen_at, last_seen_at)
       SELECT json_extract(qm.snapshot_json, '$.origin.senderUserName'), MIN(qm.telegram_date), MAX(qm.telegram_date)
       FROM queue_messages qm JOIN queue_items qi ON qi.id = qm.item_id
       WHERE json_extract(qm.snapshot_json, '$.origin.kind') = 'hidden_user'
       GROUP BY json_extract(qm.snapshot_json, '$.origin.senderUserName')`,
      `CREATE TABLE queue_preparation_operations (
        id TEXT PRIMARY KEY,
        item_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('prepare','refresh')),
        state TEXT NOT NULL CHECK (state IN ('running','outputs_recorded','cleanup_pending','uncertain','done','failed')),
        phase TEXT NOT NULL,
        boot_id TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        captured_content_version INTEGER NOT NULL,
        captured_source_generation INTEGER NOT NULL,
        target_source_generation INTEGER,
        source_ids_json TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        result_json TEXT,
        return_item_status TEXT NOT NULL,
        error_code TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (item_id) REFERENCES queue_items(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX queue_preparation_recovery_idx ON queue_preparation_operations(state, lease_expires_at)`,
      `CREATE INDEX queue_preparation_item_idx ON queue_preparation_operations(item_id, created_at)`,
      `CREATE TABLE queue_preparation_outputs (
        operation_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        output_key TEXT NOT NULL,
        step_key TEXT NOT NULL,
        source_member_key TEXT,
        role TEXT NOT NULL CHECK (role IN ('content','credit')),
        snapshot_json TEXT,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (operation_id, chat_id, telegram_message_id),
        UNIQUE (chat_id, telegram_message_id),
        FOREIGN KEY (operation_id) REFERENCES queue_preparation_operations(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE queue_generated_events (
        id TEXT PRIMARY KEY,
        operation_family TEXT NOT NULL CHECK (operation_family IN ('preparation','publication','renewal','recovery')),
        operation_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        event_kind TEXT NOT NULL CHECK (event_kind IN ('post','edit')),
        expected_fingerprint TEXT,
        expected_snapshot_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending','matched','obsolete')),
        created_at INTEGER NOT NULL,
        matched_at INTEGER
      )`,
      `CREATE INDEX queue_generated_events_match_idx ON queue_generated_events(chat_id, message_id, event_kind, state)`,
      `CREATE INDEX queue_generated_events_operation_idx ON queue_generated_events(operation_family, operation_id)`,
    ],
  },
];

export const applyMigrations = (db: Database, throughVersion = Number.POSITIVE_INFINITY): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  for (const migration of migrations) {
    if (migration.version > throughVersion) break;
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

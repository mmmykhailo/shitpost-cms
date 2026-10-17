import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../src/db/migrations";

const resources: Array<{ directory: string; close(): void }> = [];

afterEach(() => {
  while (resources.length) {
    const resource = resources.pop()!;
    resource.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("schema migrations", () => {
  test("creates the durable operation, preparation, hidden-author, quarantine, recovery, and schedule structures", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-migration-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    resources.push({ directory, close: database.close });

    expect((database.raw.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version).toBe(9);
    const columns = (table: string): string[] => (database.raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns("queue_items")).toEqual(expect.arrayContaining(["maintenance_status", "maintenance_operation_id", "maintenance_retry_not_before", "preparation_state", "representation_kind", "delivery_mode", "attribution_json", "editorial_frozen_at", "editorial_freeze_reason", "nickname_revision_wanted_key", "nickname_revision_applied_key"]));
    expect(columns("operations")).toEqual(expect.arrayContaining(["boot_id", "phase", "return_item_status", "expected_source_count", "expected_output_count", "source_ids_json", "plan_json"]));
    expect(columns("operation_outputs")).toEqual(expect.arrayContaining(["role", "step_key", "source_member_key"]));
    expect(columns("queue_messages")).toEqual(expect.arrayContaining(["member_key", "member_role", "member_delivery_mode", "album_key", "removed_at"]));
    expect(columns("pending_queue_updates")).toEqual(expect.arrayContaining(["update_kind", "telegram_update_id", "captured_delivery_mode", "policy_captured_at", "unmatched_edit_at", "unmatched_edit_update_id"]));
    expect(columns("schedule_slots")).toContain("effective_at");
    const tableExists = (table: string): boolean => Boolean(database.raw.query("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    expect(tableExists("pending_queue_updates")).toBe(true);
    expect(tableExists("recovery_sessions")).toBe(true);
    expect(tableExists("recovery_previews")).toBe(true);
    expect(tableExists("known_hidden_authors")).toBe(true);
    expect(tableExists("hidden_author_aliases")).toBe(true);
    expect(tableExists("queue_preparation_operations")).toBe(true);
    expect(tableExists("queue_preparation_outputs")).toBe(true);
    expect(tableExists("queue_generated_events")).toBe(true);
    expect(tableExists("schedule_publication_attempts")).toBe(true);
    expect(tableExists("operation_request_attempts")).toBe(true);
    expect(tableExists("telegram_admission_state")).toBe(true);
    expect(tableExists("telegram_incidents")).toBe(true);
    expect(tableExists("admin_update_receipts")).toBe(true);
    expect(tableExists("admin_response_outbox")).toBe(true);
    expect((database.raw.query("PRAGMA foreign_key_check").all() as unknown[])).toHaveLength(0);
  });

  test("upgrades a version-5 database and conservatively protects only proven or prepared active posts", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-migration-v5-"));
    const path = join(directory, "bot.sqlite");
    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec("PRAGMA foreign_keys = ON");
    applyMigrations(legacy, 5);
    const insertItem = (input: { sequence: number; messageId: number; status?: string; preparationState?: string; representationKind?: string; attribution?: string | null; generation?: number }): number => {
      legacy.query(`INSERT INTO queue_items (logical_sequence, queue_chat_id, first_message_id, content_type, origin_json, status,
        enqueued_at, physical_created_at, preparation_state, representation_kind, attribution_json, source_generation)
        VALUES (?, -100, ?, 'text', ?, ?, 100, 100, ?, ?, ?, ?)`)
        .run(input.sequence, input.messageId, JSON.stringify({ kind: "user", userId: input.sequence, displayName: "Author" }), input.status ?? "queued", input.preparationState ?? "unprepared", input.representationKind ?? "raw", input.attribution ?? null, input.generation ?? 0);
      const row = legacy.query("SELECT id FROM queue_items WHERE logical_sequence = ?").get(input.sequence) as { id: number };
      legacy.query(`INSERT INTO queue_messages (item_id, source_generation, queue_chat_id, telegram_message_id, ordinal, telegram_date, snapshot_json, removed_at)
        VALUES (?, ?, -100, ?, 0, 100, ?, NULL)`)
        .run(row.id, input.generation ?? 0, input.messageId, JSON.stringify({ schemaVersion: 1, chatId: -100, messageId: input.messageId, ordinal: 0, contentType: "text", origin: { kind: "user", userId: input.sequence, displayName: "Author" }, telegramDate: 100, hasReplyMarkup: false }));
      return row.id;
    };

    const adminOwned = insertItem({ sequence: 1, messageId: 101, preparationState: "ready", representationKind: "prepared", attribution: '{"ownership":"admin"}' });
    const verifiedEdit = insertItem({ sequence: 2, messageId: 102 });
    const unverifiedPrepared = insertItem({ sequence: 3, messageId: 103, preparationState: "ready", representationKind: "prepared", attribution: '{"ownership":"bot"}' });
    const plainRaw = insertItem({ sequence: 4, messageId: 104 });
    const obsolete = insertItem({ sequence: 5, messageId: 105, generation: 1 });
    legacy.query("UPDATE queue_items SET source_generation = 2 WHERE id = ?").run(obsolete);
    const removed = insertItem({ sequence: 6, messageId: 106 });
    legacy.query("UPDATE queue_messages SET removed_at = 150 WHERE item_id = ?").run(removed);
    const collecting = insertItem({ sequence: 7, messageId: 107, status: "collecting" });
    const uncertain = insertItem({ sequence: 8, messageId: 108, status: "uncertain_publish" });
    legacy.query("INSERT INTO operations (id, type, item_id, state, captured_content_version, captured_source_generation, phase, created_at, updated_at) VALUES ('uncertain-op', 'publish', ?, 'uncertain', 1, 0, 'uncertain', 100, 100)").run(uncertain);

    for (const messageId of [102, 105, 106]) {
      legacy.query(`INSERT INTO pending_queue_updates (queue_chat_id, telegram_message_id, snapshot_json, received_at, process_after, state, update_kind, telegram_update_id)
        VALUES (-100, ?, '{}', 120, 120, 'ingested', 'edit', ?)`)
        .run(messageId, messageId + 10_000);
    }
    legacy.query("INSERT INTO schedule_runs (occurrence_at, status, item_id, error_code) VALUES (1000, 'failed', ?, 'legacy_failure')").run(uncertain);
    applyMigrations(legacy);
    applyMigrations(legacy);

    const freeze = (id: number): { editorial_freeze_reason: string | null; editorial_freeze_message_id: number | null; editorial_freeze_update_id: number | null } => legacy.query("SELECT editorial_freeze_reason, editorial_freeze_message_id, editorial_freeze_update_id FROM queue_items WHERE id = ?").get(id) as never;
    expect(freeze(adminOwned).editorial_freeze_reason).toBe("legacy_edit_evidence");
    expect(freeze(verifiedEdit)).toEqual({ editorial_freeze_reason: "legacy_edit_evidence", editorial_freeze_message_id: 102, editorial_freeze_update_id: 10102 });
    expect(freeze(unverifiedPrepared).editorial_freeze_reason).toBe("legacy_unverified");
    expect(freeze(plainRaw).editorial_freeze_reason).toBeNull();
    expect(freeze(obsolete).editorial_freeze_reason).toBeNull();
    expect(freeze(removed).editorial_freeze_reason).toBeNull();
    expect((legacy.query("SELECT status FROM queue_items WHERE id = ?").get(collecting) as { status: string }).status).toBe("collecting");
    expect((legacy.query("SELECT status FROM queue_items WHERE id = ?").get(uncertain) as { status: string }).status).toBe("uncertain_publish");
    expect((legacy.query("SELECT state FROM operations WHERE id = 'uncertain-op'").get() as { state: string }).state).toBe("uncertain");
    expect((legacy.query("SELECT retry_deadline_at FROM schedule_runs WHERE occurrence_at = 1000").get() as { retry_deadline_at: number }).retry_deadline_at).toBe(301000);
    expect((legacy.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version).toBe(9);
    expect((legacy.query("PRAGMA foreign_key_check").all() as unknown[])).toHaveLength(0);
    legacy.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("backfills stable member keys and exact hidden sender identities", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-migration-v3-"));
    const path = join(directory, "bot.sqlite");
    const legacy = new Database(path, { create: true, strict: true });
    applyMigrations(legacy, 3);
    legacy.query("INSERT INTO queue_items (logical_sequence, queue_chat_id, first_message_id, content_type, origin_json, status, enqueued_at, physical_created_at) VALUES (1, -100, 77, 'text', ?, 'queued', 100, 100)").run(JSON.stringify({ kind: "hidden_user", senderUserName: " Alex " }));
    legacy.query("INSERT INTO queue_messages (item_id, source_generation, queue_chat_id, telegram_message_id, ordinal, telegram_date, snapshot_json) VALUES (1, 0, -100, 77, 0, 100, ?)").run(JSON.stringify({ schemaVersion: 1, chatId: -100, messageId: 77, ordinal: 0, contentType: "text", origin: { kind: "hidden_user", senderUserName: " Alex " }, telegramDate: 100, hasReplyMarkup: false }));
    legacy.query("INSERT INTO channel_whitelist (chat_id, username, title, added_at, added_by_admin_id, updated_at) VALUES (-500, 'source', 'Source', 1, 1, 1)").run();
    legacy.query("INSERT INTO queue_items (logical_sequence, queue_chat_id, first_message_id, content_type, origin_json, status, enqueued_at, physical_created_at) VALUES (2, -100, 78, 'text', ?, 'queued', 200, 200)").run(JSON.stringify({ kind: "channel", chatId: -500, title: "Source" }));
    legacy.query("INSERT INTO queue_messages (item_id, source_generation, queue_chat_id, telegram_message_id, ordinal, telegram_date, snapshot_json) VALUES (2, 0, -100, 78, 0, 200, ?)").run(JSON.stringify({ schemaVersion: 1, chatId: -100, messageId: 78, ordinal: 0, contentType: "text", origin: { kind: "channel", chatId: -500, title: "Source" }, telegramDate: 200, hasReplyMarkup: false }));
    applyMigrations(legacy);
    expect((legacy.query("SELECT member_key FROM queue_messages WHERE item_id = 1").get() as { member_key: string }).member_key).toBe("legacy:77");
    expect((legacy.query("SELECT sender_name FROM known_hidden_authors").get() as { sender_name: string }).sender_name).toBe(" Alex ");
    expect((legacy.query("SELECT delivery_mode, enqueued_at FROM queue_items WHERE id = 2").get() as { delivery_mode: string; enqueued_at: number })).toEqual({ delivery_mode: "forward", enqueued_at: 200 });
    expect((legacy.query("SELECT member_delivery_mode FROM queue_messages WHERE item_id = 2").get() as { member_delivery_mode: string }).member_delivery_mode).toBe("forward");
    expect((legacy.query("PRAGMA foreign_key_check").all() as unknown[])).toHaveLength(0);
    legacy.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("quarantines legacy renewal states from a version-2 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-migration-v2-"));
    const path = join(directory, "bot.sqlite");
    const legacy = new Database(path, { create: true, strict: true });
    applyMigrations(legacy, 2);
    legacy.query("INSERT INTO queue_items (logical_sequence, queue_chat_id, first_message_id, content_type, origin_json, status, enqueued_at, physical_created_at, claimed_operation_id) VALUES (1, -100, 77, 'text', ?, 'renewing', 100, 100, 'legacy-renewal')").run(JSON.stringify({ kind: "absent" }));
    legacy.query("INSERT INTO operations (id, type, item_id, state, captured_content_version, captured_source_generation, created_at, updated_at) VALUES ('legacy-renewal', 'renew', 1, 'uncertain', 1, 0, 100, 100)").run();
    legacy.query("INSERT INTO schedule_slots (minute_of_day, created_at, created_by_admin_id) VALUES (60, 123, 9)").run();
    applyMigrations(legacy);

    const item = legacy.query("SELECT status, maintenance_status, last_error_code FROM queue_items WHERE id = 1").get() as { status: string; maintenance_status: string; last_error_code: string };
    const operation = legacy.query("SELECT phase FROM operations WHERE id = 'legacy-renewal'").get() as { phase: string };
    const history = legacy.query("SELECT effective_from, actor_admin_id FROM schedule_slot_history WHERE minute_of_day = 60").get() as { effective_from: number; actor_admin_id: number };
    expect(item).toEqual({ status: "needs_review", maintenance_status: "uncertain_renewal", last_error_code: "legacy_renewal_state" });
    expect(operation.phase).toBe("uncertain");
    expect(history).toEqual({ effective_from: 123, actor_admin_id: 9 });
    expect((legacy.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'legacy_renewal_quarantined'").get() as { count: number }).count).toBe(1);
    legacy.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

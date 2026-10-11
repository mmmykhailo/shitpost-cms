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

describe("schema migration 3", () => {
  test("creates the durable operation, quarantine, recovery, and schedule structures", () => {
    const directory = mkdtempSync(join(tmpdir(), "queuebot-migration-"));
    const database = createDatabase(join(directory, "bot.sqlite"));
    resources.push({ directory, close: database.close });

    expect((database.raw.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version).toBe(3);
    const columns = (table: string): string[] => (database.raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns("queue_items")).toEqual(expect.arrayContaining(["maintenance_status", "maintenance_operation_id", "maintenance_retry_not_before"]));
    expect(columns("operations")).toEqual(expect.arrayContaining(["boot_id", "phase", "return_item_status", "expected_source_count", "expected_output_count", "source_ids_json", "plan_json"]));
    expect(columns("operation_outputs")).toContain("role");
    expect(columns("schedule_slots")).toContain("effective_at");
    const tableExists = (table: string): boolean => Boolean(database.raw.query("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    expect(tableExists("pending_queue_updates")).toBe(true);
    expect(tableExists("recovery_sessions")).toBe(true);
    expect(tableExists("recovery_previews")).toBe(true);
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

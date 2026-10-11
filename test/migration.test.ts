import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";

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
});

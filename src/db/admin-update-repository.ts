import type { AppDatabase } from "./database";
import { validateJsonPayload } from "../domain/validation";
import { randomUUID } from "node:crypto";

export type AdminUpdateState = "queued" | "running" | "applied" | "uncertain" | "rejected";

export const createAdminUpdateRepository = (database: AppDatabase) => {
  const begin = (input: { updateId: number; adminId: number; actionKind: string; actionPayload: unknown; bootId: string; now: number }): boolean => database.transaction(() => {
    if (!Number.isSafeInteger(input.updateId) || input.updateId < 0 || !Number.isSafeInteger(input.adminId) || input.adminId <= 0 || !Number.isSafeInteger(input.now) || input.now < 0) throw new RangeError("Invalid admin update identity or timestamp");
    const payload = validateJsonPayload(input.actionPayload, "admin update action");
    const inserted = database.raw.query(`INSERT INTO admin_update_receipts (update_id, admin_id, action_kind, action_payload_json, state, boot_id, accepted_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?) ON CONFLICT(update_id) DO NOTHING`).run(input.updateId, input.adminId, input.actionKind, JSON.stringify(payload), input.bootId, input.now, input.now);
    return Number(inserted.changes) === 1;
  });

  const defer = (updateId: number, actionKind: string, actionPayload: unknown, now: number): boolean => {
    const payload = validateJsonPayload(actionPayload, "admin action descriptor");
    return Number(database.raw.query("UPDATE admin_update_receipts SET action_kind = ?, action_payload_json = ?, state = 'queued', claim_token = NULL, updated_at = ? WHERE update_id = ? AND state = 'running' AND claim_token IS NULL").run(actionKind, JSON.stringify(payload), now, updateId).changes) === 1;
  };

  const claimNext = (bootId: string, now: number): { updateId: number; adminId: number; actionKind: string; actionPayload: unknown; claimToken: string; operationId?: string } | undefined => database.transaction(() => {
    const row = database.raw.query("SELECT update_id, admin_id, action_kind, action_payload_json, operation_id FROM admin_update_receipts WHERE state = 'queued' ORDER BY accepted_at, update_id LIMIT 1").get() as { update_id: number; admin_id: number; action_kind: string; action_payload_json: string; operation_id: string | null } | null;
    if (row === null) return undefined;
    const claimToken = randomUUID();
    const changed = database.raw.query("UPDATE admin_update_receipts SET state = 'running', boot_id = ?, claim_token = ?, updated_at = ? WHERE update_id = ? AND state = 'queued'").run(bootId, claimToken, now, row.update_id);
    return Number(changed.changes) === 1 ? { updateId: row.update_id, adminId: row.admin_id, actionKind: row.action_kind, actionPayload: JSON.parse(row.action_payload_json) as unknown, claimToken, ...(row.operation_id === null ? {} : { operationId: row.operation_id }) } : undefined;
  });

  const claimManualPublishReconciliation = (bootId: string, now: number): ({ updateId: number; adminId: number; actionKind: "manual_publish"; actionPayload: unknown; claimToken: string; operationId: string; reconcileOnly: true }) | undefined => database.transaction(() => {
    const row = database.raw.query(`SELECT update_id, admin_id, action_kind, action_payload_json, operation_id FROM admin_update_receipts
      WHERE state = 'uncertain' AND action_kind = 'manual_publish' AND operation_id IS NOT NULL AND COALESCE(json_extract(result_json, '$.reconciliationAttempted'), 0) = 0
      ORDER BY accepted_at, update_id LIMIT 1`).get() as { update_id: number; admin_id: number; action_kind: "manual_publish"; action_payload_json: string; operation_id: string } | null;
    if (row === null) return undefined;
    const claimToken = randomUUID();
    const changed = database.raw.query("UPDATE admin_update_receipts SET state = 'running', boot_id = ?, claim_token = ?, updated_at = ? WHERE update_id = ? AND state = 'uncertain'").run(bootId, claimToken, now, row.update_id);
    return Number(changed.changes) === 1 ? { updateId: row.update_id, adminId: row.admin_id, actionKind: row.action_kind, actionPayload: JSON.parse(row.action_payload_json) as unknown, claimToken, operationId: row.operation_id, reconcileOnly: true } : undefined;
  });

  const setOperationId = (updateId: number, claimToken: string, operationId: string, now: number): boolean => Number(database.raw.query("UPDATE admin_update_receipts SET operation_id = ?, updated_at = ? WHERE update_id = ? AND state = 'running' AND claim_token = ?").run(operationId, now, updateId, claimToken).changes) === 1;
  const requeue = (updateId: number, claimToken: string, now: number, reason: string): boolean => Number(database.raw.query("UPDATE admin_update_receipts SET state = 'queued', claim_token = NULL, updated_at = ?, result_json = ? WHERE update_id = ? AND state = 'running' AND claim_token = ?").run(now, JSON.stringify({ reason }), updateId, claimToken).changes) === 1;

  const finish = (updateId: number, state: Exclude<AdminUpdateState, "queued" | "running">, result: unknown, now: number, claimToken?: string): boolean => {
    const payload = validateJsonPayload(result, "admin update result");
    const updated = claimToken === undefined
      ? database.raw.query("UPDATE admin_update_receipts SET state = ?, result_json = ?, claim_token = NULL, updated_at = ? WHERE update_id = ? AND state = 'running' AND claim_token IS NULL").run(state, JSON.stringify(payload), now, updateId)
      : database.raw.query("UPDATE admin_update_receipts SET state = ?, result_json = ?, claim_token = NULL, updated_at = ? WHERE update_id = ? AND state = 'running' AND claim_token = ?").run(state, JSON.stringify(payload), now, updateId, claimToken);
    return Number(updated.changes) === 1;
  };

  const markInterruptedUncertain = (now: number): number => Number(database.raw.query(`UPDATE admin_update_receipts SET
      state = CASE WHEN action_kind = 'set_commands' OR (action_kind = 'manual_publish' AND operation_id IS NULL) OR action_kind = 'whitelist_lookup' THEN 'queued' ELSE 'uncertain' END,
      claim_token = NULL, updated_at = ?,
      result_json = CASE WHEN action_kind = 'set_commands' OR (action_kind = 'manual_publish' AND operation_id IS NULL) OR action_kind = 'whitelist_lookup'
        THEN '{"reason":"restart_before_effect"}' ELSE COALESCE(result_json, '{"reason":"restart_during_action"}') END
      WHERE state = 'running'`).run(now).changes);
  const find = (updateId: number): { updateId: number; adminId: number; actionKind: string; actionPayload: unknown; state: AdminUpdateState; acceptedAt: number; updatedAt: number; operationId?: string; result?: unknown } | undefined => {
    const row = database.raw.query("SELECT * FROM admin_update_receipts WHERE update_id = ?").get(updateId) as { update_id: number; admin_id: number; action_kind: string; action_payload_json: string; state: AdminUpdateState; accepted_at: number; updated_at: number; operation_id: string | null; result_json: string | null } | null;
    if (row === null) return undefined;
    return { updateId: row.update_id, adminId: row.admin_id, actionKind: row.action_kind, actionPayload: JSON.parse(row.action_payload_json) as unknown, state: row.state, acceptedAt: row.accepted_at, updatedAt: row.updated_at, ...(row.operation_id === null ? {} : { operationId: row.operation_id }), ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }) };
  };
  const counts = (): { active: number; uncertain: number } => {
    const rows = database.raw.query("SELECT state, COUNT(*) AS count FROM admin_update_receipts WHERE state IN ('queued','running','uncertain') GROUP BY state").all() as Array<{ state: string; count: number }>;
    return { active: rows.filter((row) => row.state === "queued" || row.state === "running").reduce((sum, row) => sum + row.count, 0), uncertain: rows.find((row) => row.state === "uncertain")?.count ?? 0 };
  };
  const purgeTerminal = (before: number): number => Number(database.raw.query("DELETE FROM admin_update_receipts WHERE state IN ('applied','rejected') AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM admin_response_outbox WHERE update_id = admin_update_receipts.update_id AND state IN ('pending','sending','uncertain'))").run(before).changes);

  return { begin, defer, claimNext, claimManualPublishReconciliation, setOperationId, requeue, finish, markInterruptedUncertain, find, counts, purgeTerminal, transaction: <T>(work: () => T): T => database.transaction(work) };
};

export type AdminUpdateRepository = ReturnType<typeof createAdminUpdateRepository>;

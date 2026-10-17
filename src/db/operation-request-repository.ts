import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database";

export type RequestAttemptState = "in_flight" | "accepted" | "rejected" | "unknown";

export const createOperationRequestRepository = (database: AppDatabase) => {
  const begin = (input: { operationId: string; method: string; targetChatId: number; stepKey?: string; now: number }): string => database.transaction(() => {
    if (!Number.isSafeInteger(input.targetChatId)) throw new RangeError("Request target chat ID must be a safe integer");
    if (!Number.isSafeInteger(input.now) || input.now < 0) throw new RangeError("Request start time must be a nonnegative safe integer");
    const operation = database.raw.query("SELECT state FROM operations WHERE id = ?").get(input.operationId) as { state: string } | null;
    if (!operation || !["running", "outputs_recorded", "cleanup_pending"].includes(operation.state)) throw new Error("Cannot begin a Telegram request for an inactive operation");
    const row = database.raw.query("SELECT COALESCE(MAX(request_ordinal), 0) + 1 AS next_ordinal FROM operation_request_attempts WHERE operation_id = ?").get(input.operationId) as { next_ordinal: number };
    const id = randomUUID();
    database.raw.query("INSERT INTO operation_request_attempts (id, operation_id, request_ordinal, method, target_chat_id, step_key, started_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'in_flight')").run(id, input.operationId, row.next_ordinal, input.method, input.targetChatId, input.stepKey ?? null, input.now);
    database.raw.query("UPDATE operations SET request_evidence_version = 1, updated_at = ? WHERE id = ?").run(input.now, input.operationId);
    return id;
  });
  const finish = (id: string, result: { state: Exclude<RequestAttemptState, "in_flight">; errorKind?: string; knownOutputIds?: readonly number[] }, now: number): void => database.transaction(() => {
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Request finish time must be a nonnegative safe integer");
    const ids = result.knownOutputIds ?? [];
    if (ids.some((messageId) => !Number.isSafeInteger(messageId) || messageId <= 0)) throw new RangeError("Request output IDs must be positive safe integers");
    const updated = database.raw.query(`UPDATE operation_request_attempts SET finished_at = ?, state = ?, error_kind = ?, known_output_ids_json = ?
      WHERE id = ? AND state = 'in_flight'`).run(now, result.state, result.errorKind ?? null, ids.length === 0 ? null : JSON.stringify(ids), id);
    if (Number(updated.changes) !== 1) throw new Error("Telegram request evidence is no longer in flight");
  });
  const listForOperation = (operationId: string): Array<{ id: string; ordinal: number; method: string; targetChatId: number; stepKey?: string; startedAt: number; finishedAt?: number; state: RequestAttemptState; errorKind?: string; knownOutputIds: number[] }> => {
    const rows = database.raw.query("SELECT id, request_ordinal, method, target_chat_id, step_key, started_at, finished_at, state, error_kind, known_output_ids_json FROM operation_request_attempts WHERE operation_id = ? ORDER BY request_ordinal").all(operationId) as Array<{ id: string; request_ordinal: number; method: string; target_chat_id: number; step_key: string | null; started_at: number; finished_at: number | null; state: RequestAttemptState; error_kind: string | null; known_output_ids_json: string | null }>;
    return rows.map((row) => ({ id: row.id, ordinal: row.request_ordinal, method: row.method, targetChatId: row.target_chat_id, startedAt: row.started_at, state: row.state, knownOutputIds: row.known_output_ids_json === null ? [] : JSON.parse(row.known_output_ids_json) as number[], ...(row.step_key === null ? {} : { stepKey: row.step_key }), ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }), ...(row.error_kind === null ? {} : { errorKind: row.error_kind }) }));
  };
  return { begin, finish, listForOperation };
};

export type OperationRequestRepository = ReturnType<typeof createOperationRequestRepository>;

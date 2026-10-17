import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database";

export type TelegramIncidentState = "active" | "recovering" | "resolved";
export type TelegramIncidentRecord = {
  id: string;
  conditionKey: string;
  state: TelegramIncidentState;
  firstFailureAt: number;
  lastFailureAt: number;
  cooldownUntil: number;
  quietUntil: number;
  lastRelevantSuccessAt?: number;
  actionRequired: boolean;
  warningOutboxId?: string;
  warningDeliveredAt?: number;
  recoveryOutboxId?: string;
  recoveryDeliveredAt?: number;
  resolvedAt?: number;
};

type Row = {
  id: string; condition_key: string; state: TelegramIncidentState; first_failure_at: number; last_failure_at: number;
  cooldown_until: number; quiet_until: number; last_relevant_success_at: number | null; action_required: number;
  warning_outbox_id: string | null; warning_delivered_at: number | null; recovery_outbox_id: string | null;
  recovery_delivered_at: number | null; resolved_at: number | null;
};

const toRecord = (row: Row): TelegramIncidentRecord => ({
  id: row.id,
  conditionKey: row.condition_key,
  state: row.state,
  firstFailureAt: row.first_failure_at,
  lastFailureAt: row.last_failure_at,
  cooldownUntil: row.cooldown_until,
  quietUntil: row.quiet_until,
  actionRequired: row.action_required === 1,
  ...(row.last_relevant_success_at === null ? {} : { lastRelevantSuccessAt: row.last_relevant_success_at }),
  ...(row.warning_outbox_id === null ? {} : { warningOutboxId: row.warning_outbox_id }),
  ...(row.warning_delivered_at === null ? {} : { warningDeliveredAt: row.warning_delivered_at }),
  ...(row.recovery_outbox_id === null ? {} : { recoveryOutboxId: row.recovery_outbox_id }),
  ...(row.recovery_delivered_at === null ? {} : { recoveryDeliveredAt: row.recovery_delivered_at }),
  ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
});

export const createTelegramIncidentRepository = (database: AppDatabase) => {
  const find = (id: string): TelegramIncidentRecord | undefined => {
    const row = database.raw.query("SELECT * FROM telegram_incidents WHERE id = ?").get(id) as Row | null;
    return row === null ? undefined : toRecord(row);
  };
  const open = (conditionKey = "flood_wait"): TelegramIncidentRecord | undefined => {
    const row = database.raw.query("SELECT * FROM telegram_incidents WHERE condition_key = ? AND state <> 'resolved'").get(conditionKey) as Row | null;
    return row === null ? undefined : toRecord(row);
  };
  const observeRealFloodWait = (now: number, notBefore: number, actionRequired = false): TelegramIncidentRecord => database.transaction(() => {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(notBefore) || notBefore < now) throw new RangeError("Invalid Telegram incident timing");
    const current = open("flood_wait");
    if (current !== undefined) {
      database.raw.query(`UPDATE telegram_incidents SET state = 'active', last_failure_at = ?, cooldown_until = MAX(cooldown_until, ?), quiet_until = MAX(cooldown_until, ?) + 300000,
        last_relevant_success_at = NULL, action_required = MAX(action_required, ?), recovery_outbox_id = NULL, recovery_delivered_at = NULL, resolved_at = NULL WHERE id = ?`).run(now, notBefore, notBefore, actionRequired ? 1 : 0, current.id);
      return open("flood_wait")!;
    }
    const id = randomUUID();
    database.raw.query(`INSERT INTO telegram_incidents (id, condition_key, state, first_failure_at, last_failure_at, cooldown_until, quiet_until, last_relevant_success_at, action_required)
      VALUES (?, 'flood_wait', 'active', ?, ?, ?, ?, NULL, ?)`).run(id, now, now, notBefore, notBefore + 300_000, actionRequired ? 1 : 0);
    return find(id)!;
  });
  const observeRelevantSuccess = (now: number): boolean => Number(database.raw.query(`UPDATE telegram_incidents SET last_relevant_success_at = ?
    WHERE condition_key = 'flood_wait' AND state <> 'resolved' AND cooldown_until <= ?`).run(now, now).changes) > 0;
  const setWarningOutbox = (id: string, outboxId: string): boolean => Number(database.raw.query("UPDATE telegram_incidents SET warning_outbox_id = ? WHERE id = ? AND state = 'active' AND warning_delivered_at IS NULL").run(outboxId, id).changes) === 1;
  const setRecoveryOutbox = (id: string, outboxId: string): boolean => Number(database.raw.query("UPDATE telegram_incidents SET state = 'recovering', recovery_outbox_id = ? WHERE id = ? AND state <> 'resolved' AND warning_delivered_at IS NOT NULL AND last_relevant_success_at >= cooldown_until").run(outboxId, id).changes) === 1;
  const markWarningDelivered = (id: string, outboxId: string, now: number): boolean => Number(database.raw.query("UPDATE telegram_incidents SET warning_delivered_at = ? WHERE id = ? AND warning_outbox_id = ? AND warning_delivered_at IS NULL AND state = 'active'").run(now, id, outboxId).changes) === 1;
  const markRecoveryDelivered = (id: string, outboxId: string, now: number): boolean => Number(database.raw.query("UPDATE telegram_incidents SET recovery_delivered_at = ?, state = 'resolved', resolved_at = ? WHERE id = ? AND recovery_outbox_id = ? AND state = 'recovering' AND warning_delivered_at IS NOT NULL").run(now, now, id, outboxId).changes) === 1;
  const resolveSilently = (id: string, now: number): boolean => Number(database.raw.query("UPDATE telegram_incidents SET state = 'resolved', resolved_at = ? WHERE id = ? AND state = 'active' AND warning_delivered_at IS NULL").run(now, id).changes) === 1;
  const returnToActive = (id: string): boolean => Number(database.raw.query("UPDATE telegram_incidents SET state = 'active', recovery_outbox_id = NULL WHERE id = ? AND state = 'recovering'").run(id).changes) === 1;
  const acknowledgeActionRequired = (id: string, value: boolean): boolean => Number(database.raw.query("UPDATE telegram_incidents SET action_required = ? WHERE id = ? AND state <> 'resolved'").run(value ? 1 : 0, id).changes) === 1;
  const snapshot = (): TelegramIncidentRecord | undefined => open("flood_wait");
  const counts = (): { open: number; recovering: number } => {
    const row = database.raw.query("SELECT SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN state = 'recovering' THEN 1 ELSE 0 END) AS recovering FROM telegram_incidents WHERE state <> 'resolved'").get() as { open: number | null; recovering: number | null };
    return { open: row.open ?? 0, recovering: row.recovering ?? 0 };
  };
  const purgeResolved = (before: number): number => Number(database.raw.query("DELETE FROM telegram_incidents WHERE state = 'resolved' AND resolved_at < ? AND (warning_delivered_at IS NULL OR warning_outbox_id IS NULL OR recovery_delivered_at IS NOT NULL)").run(before).changes);
  return { find, open, observeRealFloodWait, observeRelevantSuccess, setWarningOutbox, setRecoveryOutbox, markWarningDelivered, markRecoveryDelivered, resolveSilently, returnToActive, acknowledgeActionRequired, snapshot, counts, purgeResolved, transaction: <T>(work: () => T): T => database.transaction(work) };
};

export type TelegramIncidentRepository = ReturnType<typeof createTelegramIncidentRepository>;

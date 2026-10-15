import type { AppDatabase } from "./database";

export type AlertSeverity = "normal" | "immediate" | "critical";
export type AlertNotificationMode = "periodic" | "on_change";
export type AlertRecord = {
  dedupeKey: string;
  severity: AlertSeverity;
  notificationMode: AlertNotificationMode;
  firstSeenAt: number;
  lastSeenAt: number;
  lastSentAt?: number;
  occurrenceCount: number;
  resolvedAt?: number;
  conditionFingerprint?: string;
  sentFingerprint?: string;
  payload?: unknown;
  deliveryRetryNotBefore?: number;
  deliveryAttempts: number;
};

const repeatWindow = (severity: AlertSeverity): number => severity === "critical" ? 60 * 60_000 : severity === "immediate" ? 6 * 60 * 60_000 : 24 * 60 * 60_000;

export type AlertRepository = ReturnType<typeof createAlertRepository>;

export const createAlertRepository = (database: AppDatabase) => {
  const find = (dedupeKey: string): AlertRecord | undefined => {
    const row = database.raw.query("SELECT * FROM admin_alerts WHERE dedupe_key = ?").get(dedupeKey) as { dedupe_key: string; severity: AlertSeverity; notification_mode: AlertNotificationMode; first_seen_at: number; last_seen_at: number; last_sent_at: number | null; occurrence_count: number; resolved_at: number | null; condition_fingerprint: string | null; sent_fingerprint: string | null; payload_json: string | null; delivery_retry_not_before: number | null; delivery_attempts: number } | null;
    if (!row) return undefined;
    const result: AlertRecord = { dedupeKey: row.dedupe_key, severity: row.severity, notificationMode: row.notification_mode, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, occurrenceCount: row.occurrence_count, deliveryAttempts: row.delivery_attempts };
    if (row.last_sent_at !== null) result.lastSentAt = row.last_sent_at;
    if (row.resolved_at !== null) result.resolvedAt = row.resolved_at;
    if (row.condition_fingerprint !== null) result.conditionFingerprint = row.condition_fingerprint;
    if (row.sent_fingerprint !== null) result.sentFingerprint = row.sent_fingerprint;
    if (row.payload_json !== null) result.payload = JSON.parse(row.payload_json) as unknown;
    if (row.delivery_retry_not_before !== null) result.deliveryRetryNotBefore = row.delivery_retry_not_before;
    return result;
  };

  const raise = (dedupeKey: string, severity: AlertSeverity, now: number): { alert: AlertRecord; shouldSend: boolean } => database.transaction(() => {
    const previous = find(dedupeKey);
    database.raw.query("INSERT INTO admin_alerts (dedupe_key, severity, first_seen_at, last_seen_at, last_sent_at, occurrence_count, resolved_at) VALUES (?, ?, ?, ?, NULL, 1, NULL) ON CONFLICT(dedupe_key) DO UPDATE SET severity = excluded.severity, last_seen_at = excluded.last_seen_at, occurrence_count = admin_alerts.occurrence_count + 1, resolved_at = NULL").run(dedupeKey, severity, now, now);
    const alert = find(dedupeKey);
    if (!alert) throw new Error("Alert disappeared after raise");
    return { alert, shouldSend: previous?.resolvedAt !== undefined || alert.lastSentAt === undefined || now - alert.lastSentAt >= repeatWindow(severity) };
  });

  const raiseOnChange = (dedupeKey: string, severity: AlertSeverity, fingerprint: string, payload: unknown, now: number): { alert: AlertRecord; shouldSend: boolean } => database.transaction(() => {
    if (!dedupeKey || !fingerprint) throw new Error("On-change alerts require a key and condition fingerprint");
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) throw new Error("On-change alert payload must be JSON serializable");
    database.raw.query(`INSERT INTO admin_alerts (dedupe_key, severity, first_seen_at, last_seen_at, last_sent_at, occurrence_count, resolved_at, notification_mode, condition_fingerprint, sent_fingerprint, payload_json, delivery_retry_not_before, delivery_attempts)
      VALUES (?, ?, ?, ?, NULL, 1, NULL, 'on_change', ?, NULL, ?, NULL, 0)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        severity = excluded.severity,
        last_seen_at = excluded.last_seen_at,
        occurrence_count = admin_alerts.occurrence_count + 1,
        resolved_at = NULL,
        notification_mode = 'on_change',
        sent_fingerprint = CASE WHEN admin_alerts.notification_mode <> 'on_change' OR admin_alerts.condition_fingerprint IS NOT excluded.condition_fingerprint OR admin_alerts.resolved_at IS NOT NULL THEN NULL ELSE admin_alerts.sent_fingerprint END,
        delivery_retry_not_before = CASE WHEN admin_alerts.notification_mode <> 'on_change' OR admin_alerts.condition_fingerprint IS NOT excluded.condition_fingerprint OR admin_alerts.resolved_at IS NOT NULL THEN NULL ELSE admin_alerts.delivery_retry_not_before END,
        delivery_attempts = CASE WHEN admin_alerts.notification_mode <> 'on_change' OR admin_alerts.condition_fingerprint IS NOT excluded.condition_fingerprint OR admin_alerts.resolved_at IS NOT NULL THEN 0 ELSE admin_alerts.delivery_attempts END,
        condition_fingerprint = excluded.condition_fingerprint,
        payload_json = excluded.payload_json`).run(dedupeKey, severity, now, now, fingerprint, payloadJson);
    const alert = find(dedupeKey);
    if (!alert) throw new Error("On-change alert disappeared after raise");
    return { alert, shouldSend: alert.sentFingerprint !== fingerprint && (alert.deliveryRetryNotBefore === undefined || alert.deliveryRetryNotBefore <= now) };
  });

  const markSent = (dedupeKey: string, now: number): void => { database.raw.query("UPDATE admin_alerts SET last_sent_at = ? WHERE dedupe_key = ?").run(now, dedupeKey); };
  const markOnChangeSent = (dedupeKey: string, fingerprint: string, now: number): boolean => Number(database.raw.query("UPDATE admin_alerts SET last_sent_at = ?, sent_fingerprint = ?, delivery_retry_not_before = NULL, delivery_attempts = 0 WHERE dedupe_key = ? AND notification_mode = 'on_change' AND condition_fingerprint = ? AND resolved_at IS NULL").run(now, fingerprint, dedupeKey, fingerprint).changes) === 1;
  const markOnChangeDeliveryFailed = (dedupeKey: string, fingerprint: string, now: number): number => database.transaction(() => {
    const row = database.raw.query("SELECT delivery_attempts FROM admin_alerts WHERE dedupe_key = ? AND notification_mode = 'on_change' AND condition_fingerprint = ? AND resolved_at IS NULL").get(dedupeKey, fingerprint) as { delivery_attempts: number } | null;
    if (!row) return now;
    const attempts = row.delivery_attempts + 1;
    const backoffMs = Math.min(60 * 60_000, 30_000 * (2 ** Math.min(attempts - 1, 7)));
    const retryAt = now + backoffMs;
    database.raw.query("UPDATE admin_alerts SET delivery_attempts = ?, delivery_retry_not_before = ? WHERE dedupe_key = ? AND condition_fingerprint = ? AND resolved_at IS NULL").run(attempts, retryAt, dedupeKey, fingerprint);
    return retryAt;
  });
  const pendingOnChange = (now: number): Array<{ dedupeKey: string; severity: AlertSeverity; fingerprint: string; payload: unknown }> => {
    const rows = database.raw.query("SELECT dedupe_key, severity, condition_fingerprint, payload_json FROM admin_alerts WHERE notification_mode = 'on_change' AND resolved_at IS NULL AND condition_fingerprint IS NOT NULL AND sent_fingerprint IS NOT condition_fingerprint AND (delivery_retry_not_before IS NULL OR delivery_retry_not_before <= ?) ORDER BY severity DESC, last_seen_at LIMIT 100").all(now) as Array<{ dedupe_key: string; severity: AlertSeverity; condition_fingerprint: string; payload_json: string | null }>;
    return rows.filter((row) => row.payload_json !== null).map((row) => ({ dedupeKey: row.dedupe_key, severity: row.severity, fingerprint: row.condition_fingerprint, payload: JSON.parse(row.payload_json!) as unknown }));
  };
  const resolve = (dedupeKey: string, now: number): boolean => {
    const result = database.raw.query("UPDATE admin_alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL").run(now, dedupeKey);
    return Number(result.changes) === 1;
  };
  const active = (): AlertRecord[] => (database.raw.query("SELECT dedupe_key FROM admin_alerts WHERE resolved_at IS NULL ORDER BY severity DESC, last_seen_at DESC").all() as Array<{ dedupe_key: string }>).map((row) => find(row.dedupe_key)).filter((value): value is AlertRecord => value !== undefined);
  const counts = (): { active: number; critical: number; immediate: number; normal: number } => {
    const rows = database.raw.query("SELECT severity, COUNT(*) AS count FROM admin_alerts WHERE resolved_at IS NULL GROUP BY severity").all() as Array<{ severity: AlertSeverity; count: number }>;
    const result = { active: 0, critical: 0, immediate: 0, normal: 0 };
    for (const row of rows) {
      result[row.severity] += row.count;
      result.active += row.count;
    }
    return result;
  };
  const purgeResolved = (before: number): number => Number(database.raw.query("DELETE FROM admin_alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(before).changes);
  return { find, raise, raiseOnChange, markSent, markOnChangeSent, markOnChangeDeliveryFailed, pendingOnChange, resolve, active, counts, purgeResolved };
};

import type { AppDatabase } from "./database";

export type AlertSeverity = "normal" | "immediate" | "critical";
export type AlertRecord = {
  dedupeKey: string;
  severity: AlertSeverity;
  firstSeenAt: number;
  lastSeenAt: number;
  lastSentAt?: number;
  occurrenceCount: number;
  resolvedAt?: number;
};

const repeatWindow = (severity: AlertSeverity): number => severity === "critical" ? 60 * 60_000 : severity === "immediate" ? 6 * 60 * 60_000 : 24 * 60 * 60_000;

export type AlertRepository = ReturnType<typeof createAlertRepository>;

export const createAlertRepository = (database: AppDatabase) => {
  const find = (dedupeKey: string): AlertRecord | undefined => {
    const row = database.raw.query("SELECT * FROM admin_alerts WHERE dedupe_key = ?").get(dedupeKey) as { dedupe_key: string; severity: AlertSeverity; first_seen_at: number; last_seen_at: number; last_sent_at: number | null; occurrence_count: number; resolved_at: number | null } | null;
    if (!row) return undefined;
    const result: AlertRecord = { dedupeKey: row.dedupe_key, severity: row.severity, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, occurrenceCount: row.occurrence_count };
    if (row.last_sent_at !== null) result.lastSentAt = row.last_sent_at;
    if (row.resolved_at !== null) result.resolvedAt = row.resolved_at;
    return result;
  };

  const raise = (dedupeKey: string, severity: AlertSeverity, now: number): { alert: AlertRecord; shouldSend: boolean } => database.transaction(() => {
    const previous = find(dedupeKey);
    database.raw.query("INSERT INTO admin_alerts (dedupe_key, severity, first_seen_at, last_seen_at, last_sent_at, occurrence_count, resolved_at) VALUES (?, ?, ?, ?, NULL, 1, NULL) ON CONFLICT(dedupe_key) DO UPDATE SET severity = excluded.severity, last_seen_at = excluded.last_seen_at, occurrence_count = admin_alerts.occurrence_count + 1, resolved_at = NULL").run(dedupeKey, severity, now, now);
    const alert = find(dedupeKey);
    if (!alert) throw new Error("Alert disappeared after raise");
    return { alert, shouldSend: previous?.resolvedAt !== undefined || alert.lastSentAt === undefined || now - alert.lastSentAt >= repeatWindow(severity) };
  });

  const markSent = (dedupeKey: string, now: number): void => { database.raw.query("UPDATE admin_alerts SET last_sent_at = ? WHERE dedupe_key = ?").run(now, dedupeKey); };
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
  return { find, raise, markSent, resolve, active, counts, purgeResolved };
};

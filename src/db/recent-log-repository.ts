import type { LogLevel } from "../config";
import { sanitizeRecentLog, type LogFields } from "../logger";
import type { AppDatabase } from "./database";

export type RecentLog = { id: number; at: number; level: LogLevel; event: string; fields: LogFields };
export type RecentLogRepository = ReturnType<typeof createRecentLogRepository>;

const retentionMs = 7 * 24 * 60 * 60 * 1_000;
const levels: LogLevel[] = ["debug", "info", "warn", "error"];

export const createRecentLogRepository = (database: AppDatabase) => {
  const purge = (now: number): void => {
    database.raw.query("DELETE FROM recent_logs WHERE at < ?").run(now - retentionMs);
    database.raw.query("DELETE FROM recent_logs WHERE id NOT IN (SELECT id FROM recent_logs ORDER BY at DESC, id DESC LIMIT 500)").run();
  };
  purge(Date.now());
  return {
    append: (input: { at: number; level: LogLevel; event: string; fields: LogFields }): void => {
      const sanitized = sanitizeRecentLog(input.event, input.fields);
      database.transaction(() => {
        database.raw.query("INSERT INTO recent_logs (at, level, event, fields_json) VALUES (?, ?, ?, ?)")
          .run(input.at, input.level, sanitized.event, JSON.stringify(sanitized.fields));
        purge(Date.now());
      });
    },
    recent: (input: { level?: LogLevel; limit?: number } = {}): RecentLog[] => {
      purge(Date.now());
      const requested = input.limit ?? 50;
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.floor(requested))) : 50;
      const threshold = input.level === undefined ? 0 : levels.indexOf(input.level);
      const rows = database.raw.query(`SELECT id, at, level, event, fields_json FROM recent_logs
        WHERE CASE level WHEN 'debug' THEN 0 WHEN 'info' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END >= ?
        ORDER BY at DESC, id DESC LIMIT ?`).all(threshold, limit) as Array<{
          id: number; at: number; level: LogLevel; event: string; fields_json: string;
        }>;
      return rows.map((row) => ({ id: row.id, at: row.at, level: row.level, event: row.event, fields: JSON.parse(row.fields_json) as LogFields }));
    },
    purge,
  };
};

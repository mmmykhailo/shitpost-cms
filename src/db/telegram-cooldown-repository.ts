import type { AppDatabase } from "./database";

const SETTING_KEY = "telegram_mutation_not_before";

const validTimestamp = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer timestamp`);
};

export const createTelegramCooldownRepository = (database: AppDatabase) => {
  const readNotBefore = (): number => {
    const row = database.raw.query("SELECT value_json FROM settings WHERE key = ?").get(SETTING_KEY) as { value_json: string } | null;
    if (row === null) return 0;
    let value: unknown;
    try { value = JSON.parse(row.value_json) as unknown; }
    catch { throw new Error("Invalid persisted Telegram mutation cooldown"); }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid persisted Telegram mutation cooldown");
    return value;
  };

  const extendNotBefore = (deadlineMs: number, now: number): number => {
    validTimestamp(deadlineMs, "Cooldown deadline");
    validTimestamp(now, "Current time");
    return database.transaction(() => {
      const notBefore = Math.max(readNotBefore(), deadlineMs);
      database.raw.query("INSERT INTO settings (key, value_json, updated_at, updated_by_admin_id) VALUES (?, ?, ?, NULL) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by_admin_id = NULL").run(SETTING_KEY, JSON.stringify(notBefore), now);
      return notBefore;
    });
  };

  return { readNotBefore, extendNotBefore };
};

export type TelegramCooldownRepository = ReturnType<typeof createTelegramCooldownRepository>;

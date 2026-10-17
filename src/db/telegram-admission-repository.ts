import type { AppDatabase } from "./database";

const validTimestamp = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer timestamp`);
};

export const createTelegramAdmissionRepository = (database: AppDatabase) => {
  const readNotBefore = (scopeKey: string): number => {
    const row = database.raw.query("SELECT not_before FROM telegram_admission_state WHERE scope_key = ?").get(scopeKey) as { not_before: number } | null;
    return row?.not_before ?? 0;
  };
  const nextAllowedAt = (chatId: number | undefined): number => Math.max(readNotBefore("global"), chatId === undefined ? 0 : readNotBefore(`chat:${chatId}`));
  const reserve = (chatId: number | undefined, cost: number, now: number): void => database.transaction(() => {
    validTimestamp(now, "Admission time");
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > 100) throw new RangeError("Telegram mutation cost must be an integer between 1 and 100");
    const upsert = database.raw.query(`INSERT INTO telegram_admission_state (scope_key, not_before, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET not_before = MAX(telegram_admission_state.not_before, excluded.not_before), updated_at = excluded.updated_at`);
    upsert.run("global", now + cost * 1_000, now);
    if (chatId !== undefined) {
      if (!Number.isSafeInteger(chatId)) throw new RangeError("Telegram chat ID must be a safe integer");
      upsert.run(`chat:${chatId}`, now + cost * 3_000, now);
    }
  });
  const snapshot = (): Array<{ scopeKey: string; notBefore: number; updatedAt: number }> => (database.raw.query("SELECT scope_key, not_before, updated_at FROM telegram_admission_state ORDER BY scope_key").all() as Array<{ scope_key: string; not_before: number; updated_at: number }>).map((row) => ({ scopeKey: row.scope_key, notBefore: row.not_before, updatedAt: row.updated_at }));
  return { readNotBefore, nextAllowedAt, reserve, snapshot };
};

export type TelegramAdmissionRepository = ReturnType<typeof createTelegramAdmissionRepository>;

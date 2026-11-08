import type { DeskScreen } from "../admin-ui/widget/model";
import type { AppDatabase } from "./database";

type Panel = {
  revision: number;
  template: string;
  messageId: number | null;
  checkpoint: number;
  screen: DeskScreen;
};

export const createAdminPanelRepository = (database: AppDatabase) => {
  const find = (chatId: number): Panel | undefined => {
    const row = database.raw.query("SELECT * FROM admin_panels WHERE chat_id = ?").get(chatId) as
      { revision: number; template: string; message_id: number | null; checkpoint: number; screen_json: string } | null;
    return row ? { revision: row.revision, template: row.template, messageId: row.message_id,
      checkpoint: row.checkpoint, screen: JSON.parse(row.screen_json) as DeskScreen } : undefined;
  };

  const save = (chatId: number, template: string, screen: DeskScreen, replace: boolean): Panel => {
    database.raw.query(`INSERT INTO admin_panels (chat_id, revision, template, screen_json)
      VALUES (?, 1, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET
        revision = revision + 1, message_id = CASE WHEN ? THEN NULL ELSE message_id END,
        checkpoint = CASE WHEN ? THEN 0 ELSE checkpoint END, template = excluded.template, screen_json = excluded.screen_json`)
      .run(chatId, template, JSON.stringify(screen), Number(replace), Number(replace));
    return find(chatId)!;
  };

  const acknowledge = (chatId: number, revision: number, messageId: number, target?: number): void => {
    if (target === undefined) {
      database.raw.query(`UPDATE admin_panels SET checkpoint = ?, message_id = ?
        WHERE chat_id = ? AND revision = ? AND message_id IS NULL`).run(revision, messageId, chatId, revision);
    } else {
      database.raw.query(`UPDATE admin_panels SET checkpoint = MAX(checkpoint, ?)
        WHERE chat_id = ? AND message_id = ?`).run(revision, chatId, target);
    }
  };

  const retire = (chatId: number, messageId?: number): void => {
    database.raw.query(`UPDATE admin_panels SET revision = revision + 1, checkpoint = 0, message_id = NULL
      WHERE chat_id = ? AND (? IS NULL OR message_id = ?)`).run(chatId, messageId ?? null, messageId ?? null);
  };

  return { find, save, acknowledge, retire };
};

export type AdminPanelRepository = ReturnType<typeof createAdminPanelRepository>;

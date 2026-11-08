import { snapshotDesk, widgetCaption, widgetTemplate, type DeskScreen } from "../admin-ui/widget/model";
import type { AdminPanelRepository } from "../db/admin-panel-repository";
import type { AdminResponseRepository } from "../db/admin-response-repository";
import { widgetCoalesceKey } from "./admin-widget-delivery";

export const createAdminWidgetPanel = (panels: AdminPanelRepository, responses: AdminResponseRepository, chatId: number, now: () => number) => {
  const find = () => panels.find(chatId);
  const save = (screen: DeskScreen): string => {
    const old = find();
    const replace = old?.template !== widgetTemplate;
    const data = snapshotDesk(screen, (old?.revision ?? 0) + 1).data;
    const active = panels.save(chatId, widgetTemplate, screen, replace);
    const messageId = active.messageId;
    const at = now();
    responses.enqueue({
      adminChatId: chatId, kind: "view", now: at, notBefore: messageId === null ? at : at + 1_000,
      coalesceKey: widgetCoalesceKey(chatId), dedupeKey: `widget:${chatId}:${active.revision}`,
      descriptor: { version: 1, text: widgetCaption,
        widget: { revision: active.revision, ...(messageId === null ? {} : { messageId }) } },
    });
    return data;
  };
  const open = (screen: DeskScreen) => {
    const active = find();
    if (active?.messageId === null && active.template === widgetTemplate) {
      const job = responses.findByDedupeKey(`widget:${chatId}:${active.revision}`);
      if (job?.state === "sending" && job.requestStartedAt !== undefined) return;
    }
    save(screen);
  };
  const retire = () => {
    panels.retire(chatId);
    responses.cancelPending(widgetCoalesceKey(chatId), now());
  };
  const finish = (updateId: number, text: string, actions: DeskScreen["actions"]) => {
    const active = find();
    const route = active?.screen.refresh;
    if (active?.template !== widgetTemplate || active.messageId === null || route?.name !== "result" || route.updateId !== updateId) return;
    save({ ...active.screen, title: "Operation result", body: text,
      actions: [...actions, ...active.screen.actions] });
  };
  return { find, save, open, retire, finish };
};

export type AdminWidgetPanel = ReturnType<typeof createAdminWidgetPanel>;

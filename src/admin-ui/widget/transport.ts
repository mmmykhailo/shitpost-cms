import type { Api, Context } from "grammy";

type RawWidgets = {
  sendWidget(input: { chat_id: number; html: string; chat_data: string; caption: string; allow_queries: true }, signal?: AbortSignal): Promise<{ message_id: number }>;
  editMessageWidgetData(input: { chat_id: number; message_id: number; chat_data: string }, signal?: AbortSignal): Promise<true | { message_id: number }>;
  answerWidgetQuery(input: { widget_query_id: string | number; data?: string }, signal?: AbortSignal): Promise<true>;
};

export const rawWidgets = (api: Api): RawWidgets => api.raw as unknown as RawWidgets;

export const widgetAllowedUpdates = (enabled: boolean) => [
  "message", "callback_query", "channel_post", "edited_channel_post", ...(enabled ? ["widget_query"] : []),
] as NonNullable<NonNullable<Parameters<Api["getUpdates"]>[0]>["allowed_updates"]>;

export const readWidgetQuery = (ctx: Context) => {
  const raw = (ctx.update as unknown as { widget_query?: unknown }).widget_query;
  if (typeof raw !== "object" || raw === null) return;
  const query = raw as Record<string, unknown>;
  const id = query.id;
  if (!(typeof id === "string" && id.length > 0 && id.length <= 64) && !(typeof id === "number" && Number.isSafeInteger(id))) return;
  const from = query.from as { id?: unknown } | undefined;
  const chat = query.chat as { id?: unknown; type?: unknown } | undefined;
  return { id: id as string | number, from: from?.id, chatId: chat?.id, chatType: chat?.type,
    messageId: query.message_id, data: query.data, original: query.inline_message_id === undefined && query.widget_id === undefined };
};

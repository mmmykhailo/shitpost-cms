import type { Bot, Context } from "grammy";
import type { IngestionService } from "../services/ingestion";

export const registerQueueChannelHandlers = (bot: Bot, ingestion: IngestionService, onSuccessfulUpdate?: () => void): void => {
  bot.on("channel_post", (ctx: Context) => {
    if (ctx.channelPost) {
      ingestion.handleChannelPost(ctx.channelPost, ctx.update.update_id);
      onSuccessfulUpdate?.();
    }
  });
  bot.on("edited_channel_post", (ctx: Context) => {
    if (ctx.editedChannelPost) {
      ingestion.handleEditedChannelPost(ctx.editedChannelPost, ctx.update.update_id);
      onSuccessfulUpdate?.();
    }
  });
};

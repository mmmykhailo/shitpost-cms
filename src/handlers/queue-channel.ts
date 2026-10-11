import type { Bot, Context } from "grammy";
import type { IngestionService } from "../services/ingestion";

export const registerQueueChannelHandlers = (bot: Bot, ingestion: IngestionService): void => {
  bot.on("channel_post", (ctx: Context) => {
    if (ctx.channelPost) ingestion.handleChannelPost(ctx.channelPost);
  });
  bot.on("edited_channel_post", (ctx: Context) => {
    if (ctx.editedChannelPost) ingestion.handleEditedChannelPost(ctx.editedChannelPost);
  });
};

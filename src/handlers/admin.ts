import type { Bot, Context } from "grammy";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import { classifyTelegramError } from "../errors";
import { validateAlias } from "../domain/byline";
import { formatUtcSlot, parseUtcSlot } from "../domain/schedule";
import type { PolicyRepository, QueueRepository, ScheduleRepository } from "../db/repositories";
import type { AdminRepository } from "../db/admin-repository";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { TelegramGateway } from "../telegram";
import type { PublicationService } from "../services/publisher";
import type { SchedulerService } from "../services/scheduler";
import type { RecoveryService } from "../services/recovery";
import type { ChatId, UserId } from "../types";

type AdminDeps = {
  config: AppConfig;
  queue: QueueRepository;
  policy: PolicyRepository;
  schedule: ScheduleRepository;
  admin: AdminRepository;
  gateway: TelegramGateway;
  publisher: PublicationService;
  scheduler: SchedulerService;
  recovery: RecoveryService;
  logger: Logger;
  now: () => number;
};

const cleanDisplay = (value: string | undefined): string => (value ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 120);

const isAuthorized = (ctx: Context, adminUserId: UserId): boolean => ctx.from?.id === adminUserId && ctx.chat?.type === "private";

const button = async (deps: AdminDeps, text: string, action: string, payload: unknown = {}, itemVersion?: number) => ({
  text,
  callback_data: `v1:${deps.admin.createCallbackToken(deps.config.adminUserId, action, payload, deps.now(), itemVersion)}`,
});

const keyboard = (rows: Array<Awaited<ReturnType<typeof button>>[]>): InlineKeyboardMarkup => ({ inline_keyboard: rows });

const dashboardText = (deps: AdminDeps): string => {
  const counts = deps.queue.statusCounts();
  const head = deps.queue.getHead();
  const slots = deps.schedule.slots();
  const next = deps.scheduler.nextAt();
  const nextText = next === undefined ? "not configured" : new Date(next).toISOString();
  const status = deps.schedule.enabled() ? "running" : "paused";
  const headText = head ? `#${head.id} · ${head.status} · logical age ${Math.max(0, deps.now() - head.enqueuedAt)} ms` : "empty";
  return [
    "Telegram queue manager",
    `Schedule: ${status} · ${slots.map(formatUtcSlot).join(", ") || "no UTC slots"}`,
    `Next run: ${nextText}`,
    `Queue: ${counts.queued ?? 0} queued · ${counts.blocked ?? 0} blocked · ${(counts.uncertain_publish ?? 0) + (counts.uncertain_renewal ?? 0)} uncertain`,
    `Head: ${headText}`,
    `Renewal warnings: ${deps.queue.listRenewalAges(deps.now()).filter((entry) => entry.ageMs >= 42 * 60 * 60 * 1000).length}`,
  ].join("\n");
};

export const registerAdminHandlers = (bot: Bot, deps: AdminDeps): void => {
  const reject = async (ctx: Context): Promise<void> => {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Not authorized", show_alert: true });
    else if (ctx.chat?.type === "private") await ctx.reply("Not authorized.");
  };

  const dashboardKeyboard = async (): Promise<InlineKeyboardMarkup> => keyboard([
    [await button(deps, "Queue", "queue"), await button(deps, "Publish next now", "publish")],
    [await button(deps, "Schedule", "schedule"), await button(deps, "Whitelist", "whitelist")],
    [await button(deps, "Author names", "authors"), await button(deps, "Health", "health")],
  ]);

  const sendDashboard = async (ctx: Context): Promise<void> => {
    await ctx.reply(dashboardText(deps), { reply_markup: await dashboardKeyboard() });
  };

  const sendQueue = async (ctx: Context): Promise<void> => {
    const items = deps.queue.listActive(10, 0);
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [];
    const lines = ["Queue (FIFO)", ...items.map((item) => `#${item.id} · ${item.contentType} · ${item.status} · age ${Math.max(0, deps.now() - item.enqueuedAt)} ms`)];
    for (const item of items) rows.push([await button(deps, `Delete #${item.id}`, "queue_delete", { itemId: item.id }, item.contentVersion), await button(deps, `Retry #${item.id}`, "queue_retry", { itemId: item.id }, item.contentVersion), await button(deps, `Move #${item.id}`, "queue_move_end", { itemId: item.id }, item.contentVersion)]);
    rows.push([await button(deps, "Back", "dashboard")]);
    await ctx.reply(lines.join("\n"), { reply_markup: keyboard(rows) });
  };

  const sendSchedule = async (ctx: Context): Promise<void> => {
    const slots = deps.schedule.slots();
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[await button(deps, "Add UTC slot", "slot_add"), await button(deps, deps.schedule.enabled() ? "Pause" : "Resume", deps.schedule.enabled() ? "schedule_pause" : "schedule_resume")]];
    for (const slot of slots) rows.push([await button(deps, `Remove ${formatUtcSlot(slot)}`, "slot_remove", { minuteOfDay: slot })]);
    rows.push([await button(deps, "Back", "dashboard")]);
    await ctx.reply(`Schedule is ${deps.schedule.enabled() ? "running" : "paused"}. Slots: ${slots.map(formatUtcSlot).join(", ") || "none"}`, { reply_markup: keyboard(rows) });
  };

  const sendWhitelist = async (ctx: Context): Promise<void> => {
    const channels = deps.policy.listChannels();
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[await button(deps, "Add channel", "whitelist_add")]];
    for (const channel of channels) rows.push([await button(deps, `Remove ${cleanDisplay(channel.title || channel.username || String(channel.chatId))}`, "whitelist_remove", { chatId: channel.chatId })]);
    rows.push([await button(deps, "Back", "dashboard")]);
    const text = ["Whitelisted source channels", ...channels.map((channel) => `${channel.chatId} · ${cleanDisplay(channel.title)} ${channel.username ? `@${cleanDisplay(channel.username)}` : ""}`)].join("\n");
    await ctx.reply(text, { reply_markup: keyboard(rows) });
  };

  const sendAuthors = async (ctx: Context): Promise<void> => {
    const authors = deps.policy.listAuthors();
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[await button(deps, "Set alias", "alias_add")], [await button(deps, "Back", "dashboard")]];
    const text = ["Observed authors", ...authors.slice(0, 20).map((author) => `${author.userId} · ${cleanDisplay(author.displayName)}${author.username ? ` @${cleanDisplay(author.username)}` : ""}${author.alias ? ` → ${cleanDisplay(author.alias)}` : ""}`)].join("\n");
    await ctx.reply(text, { reply_markup: keyboard(rows) });
  };

  const sendHealth = async (ctx: Context): Promise<void> => {
    const ages = deps.queue.listRenewalAges(deps.now());
    const oldest = ages.sort((a, b) => b.ageMs - a.ageMs)[0];
    await ctx.reply(["Health", `Database: available`, `Queue sources: ${ages.length}`, `Oldest physical source: ${oldest ? `${Math.floor(oldest.ageMs / 3_600_000)}h` : "none"}`, `Scheduling: ${deps.schedule.enabled() ? "enabled" : "paused"}`].join("\n"), { reply_markup: keyboard([[await button(deps, "Back", "dashboard")]]) });
  };

  const handlePrompt = async (ctx: Context, text: string): Promise<boolean> => {
    const prompt = deps.admin.getPrompt(deps.config.adminUserId, deps.now());
    if (!prompt) return false;
    if (prompt.kind === "slot_add") {
      try {
        const slot = parseUtcSlot(text);
        deps.schedule.addSlot(slot, deps.config.adminUserId, deps.now());
        deps.admin.clearPrompt(deps.config.adminUserId);
        await ctx.reply(`Added ${formatUtcSlot(slot)}. Scheduling remains ${deps.schedule.enabled() ? "running" : "paused"}.`);
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : "Invalid UTC slot. Use HH:MM.");
      }
      return true;
    }
    if (prompt.kind === "whitelist_add") {
      if (!/^(?:@[A-Za-z0-9_]{5,32}|-?\d+)$/.test(text.trim())) {
        await ctx.reply("Enter an exact public @handle or numeric channel ID.");
        return true;
      }
      try {
        const chat = await deps.gateway.getChat(text.trim().startsWith("@") ? text.trim() : Number(text.trim()) as ChatId);
        if (chat.type !== "channel") throw new Error("The resolved chat is not a channel");
        if (chat.id === deps.config.queueChannelId || chat.id === deps.config.targetChannelId) throw new Error("Queue and destination channels cannot be whitelisted");
        const token = deps.admin.createCallbackToken(deps.config.adminUserId, "whitelist_confirm", { chatId: chat.id, username: chat.username, title: chat.title }, deps.now());
        deps.admin.clearPrompt(deps.config.adminUserId);
        await ctx.reply(`Confirm whitelist: ${cleanDisplay(chat.title)} (${chat.id})${chat.username ? ` @${cleanDisplay(chat.username)}` : ""}`, { reply_markup: keyboard([[{ text: "Confirm", callback_data: `v1:${token}` }]]) });
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : "Could not resolve that channel.");
      }
      return true;
    }
    if (prompt.kind === "alias_add") {
      const match = /^(-?\d+|@[A-Za-z0-9_]{5,32})\s+(.+)$/.exec(text.trim());
      if (!match) {
        await ctx.reply("Use `<user id or @observed_username> <alias>`.");
        return true;
      }
      try {
        const key = /^-?\d+$/.test(match[1]!) ? Number(match[1]) : match[1]!;
        deps.policy.setAlias(key, validateAlias(match[2]!), deps.config.adminUserId, deps.now());
        deps.admin.clearPrompt(deps.config.adminUserId);
        await ctx.reply("Author alias saved.");
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : "Could not save alias. Observe the user in a queue post first.");
      }
      return true;
    }
    if (prompt.kind === "recover") {
      try {
        const recovered = await deps.recovery.recover(text);
        deps.admin.clearPrompt(deps.config.adminUserId);
        await ctx.reply(`Recovered queue item #${recovered.itemId} from source IDs ${recovered.sourceIds.join(", ")}. Telegram history remains explicit; verify the supplied IDs covered the intended post.`);
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : "Recovery failed; no queue item was confirmed.");
      }
      return true;
    }
    return false;
  };

  const handleCallback = async (ctx: Context): Promise<unknown> => {
    await ctx.answerCallbackQuery();
    if (!isAuthorized(ctx, deps.config.adminUserId)) return reject(ctx);
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith("v1:")) return ctx.reply("Stale action.");
    const token = data.slice(3);
    const resolved = deps.admin.consumeCallbackToken(deps.config.adminUserId, token, deps.now());
    if (!resolved) return ctx.reply("This action expired. Open the dashboard again.");
    const payload = (resolved.payload && typeof resolved.payload === "object" ? resolved.payload : {}) as Record<string, unknown>;
    const itemId = typeof payload.itemId === "number" ? payload.itemId : undefined;
    if (itemId !== undefined && resolved.itemVersion !== undefined && deps.queue.findItemById(itemId)?.contentVersion !== resolved.itemVersion) return ctx.reply("This queue item changed. Open the queue again.");
    switch (resolved.action) {
      case "dashboard": return sendDashboard(ctx);
      case "queue": return sendQueue(ctx);
      case "schedule": return sendSchedule(ctx);
      case "whitelist": return sendWhitelist(ctx);
      case "authors": return sendAuthors(ctx);
      case "health": return sendHealth(ctx);
      case "publish": await deps.scheduler.manualPublish(); return sendDashboard(ctx);
      case "slot_add": deps.admin.setPrompt(deps.config.adminUserId, "slot_add", {}, ctx.callbackQuery?.message?.message_id, deps.now()); return ctx.reply("Send the exact daily UTC slot as HH:MM.");
      case "slot_remove": if (typeof payload.minuteOfDay === "number") deps.schedule.removeSlot(payload.minuteOfDay); return sendSchedule(ctx);
      case "schedule_pause": deps.schedule.setEnabled(false, deps.config.adminUserId, deps.now()); return sendSchedule(ctx);
      case "schedule_resume": if (deps.schedule.slots().length === 0) return ctx.reply("Add at least one UTC slot first."); deps.schedule.setEnabled(true, deps.config.adminUserId, deps.now()); return sendSchedule(ctx);
      case "whitelist_add": deps.admin.setPrompt(deps.config.adminUserId, "whitelist_add", {}, ctx.callbackQuery?.message?.message_id, deps.now()); return ctx.reply("Send an exact public @handle or numeric channel ID.");
      case "whitelist_confirm": {
        if (typeof payload.chatId !== "number") return ctx.reply("Invalid confirmation payload.");
        deps.policy.upsertChannel(payload.chatId, typeof payload.username === "string" ? payload.username : undefined, typeof payload.title === "string" ? payload.title : undefined, deps.config.adminUserId, deps.now());
        return sendWhitelist(ctx);
      }
      case "whitelist_remove": if (typeof payload.chatId === "number") deps.policy.removeChannel(payload.chatId); return sendWhitelist(ctx);
      case "alias_add": deps.admin.setPrompt(deps.config.adminUserId, "alias_add", {}, ctx.callbackQuery?.message?.message_id, deps.now()); return ctx.reply("Send `<user id or @observed_username> <alias>`.");
      case "queue_retry": if (itemId !== undefined) deps.queue.retryItem(itemId, deps.now()); return sendQueue(ctx);
      case "queue_move_end": if (itemId !== undefined) deps.queue.moveToEnd(itemId, deps.now()); return sendQueue(ctx);
      case "queue_delete": {
        if (itemId === undefined) return ctx.reply("Invalid queue item.");
        const confirm = await button(deps, `Confirm delete #${itemId}`, "queue_delete_confirm", { itemId }, resolved.itemVersion);
        return ctx.reply("Delete this queue item from Telegram and SQLite?", { reply_markup: keyboard([[confirm], [await button(deps, "Cancel", "queue")]]) });
      }
      case "queue_delete_confirm": {
        if (itemId === undefined) return ctx.reply("Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item) return ctx.reply("Queue item no longer exists.");
        try {
          await deps.gateway.deleteMessages(deps.config.queueChannelId, deps.queue.currentSourceIds(itemId));
          deps.queue.markAdminDeleted(itemId, deps.now());
          deps.admin.audit("queue_deleted", String(deps.config.adminUserId), deps.now(), itemId, undefined, { sourceCount: deps.queue.currentSourceIds(itemId).length });
          return sendQueue(ctx);
        } catch (error) {
          const normalized = classifyTelegramError(error);
          if (normalized.kind === "source_missing") {
            deps.queue.markMissing(itemId, undefined, deps.now());
            return sendQueue(ctx);
          }
          return ctx.reply(`Deletion failed (${normalized.kind}); the SQLite item was kept.`);
        }
      }
      default: return ctx.reply("Unknown or stale action.");
    }
  };

  const command = (name: string, handler: (ctx: Context) => Promise<void>): void => {
    bot.command(name, async (ctx) => {
      if (!isAuthorized(ctx, deps.config.adminUserId)) return reject(ctx);
      await handler(ctx);
    });
  };

  command("start", sendDashboard);
  command("manage", sendDashboard);
  command("queue", sendQueue);
  command("schedule", sendSchedule);
  command("whitelist", sendWhitelist);
  command("authors", sendAuthors);
  command("health", sendHealth);
  command("recover", async (ctx) => { deps.admin.setPrompt(deps.config.adminUserId, "recover", {}, ctx.message?.message_id, deps.now()); await ctx.reply("Recovery accepts a configured queue-channel message link or explicit message ID. This flow is intentionally explicit because Telegram cannot enumerate missed history."); });
  command("cancel", async (ctx) => { deps.admin.clearPrompt(deps.config.adminUserId); await ctx.reply("Pending admin prompt cancelled."); });

  bot.callbackQuery(/.*/, handleCallback);
  bot.on("message:text", async (ctx) => {
    if (!isAuthorized(ctx, deps.config.adminUserId)) return reject(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
    await handlePrompt(ctx, text);
  });
};

import type { Bot, Context } from "grammy";
import type { InlineKeyboardMarkup } from "@grammyjs/types";
import { classifyTelegramError } from "../errors";
import { validateAlias } from "../domain/byline";
import { formatUtcSlot, parseUtcSlot } from "../domain/schedule";
import { validateOrderedMessageIds } from "../domain/validation";
import type { PolicyRepository, QueueRepository, ScheduleRepository } from "../db/repositories";
import type { AdminRepository } from "../db/admin-repository";
import type { OrphanRepository } from "../db/orphan-repository";
import type { PendingUpdateRepository } from "../db/pending-update-repository";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { TelegramGateway } from "../telegram";
import type { PublicationService } from "../services/publisher";
import type { SchedulerService } from "../services/scheduler";
import type { RecoveryService } from "../services/recovery";
import type { HealthService } from "../services/health";
import type { OperationTracker } from "../services/task-supervisor";
import type { ChatId, MessageId, UserId } from "../types";

type AdminDeps = {
  config: AppConfig;
  queue: QueueRepository;
  policy: PolicyRepository;
  schedule: ScheduleRepository;
  admin: AdminRepository;
  pending: PendingUpdateRepository;
  orphan: OrphanRepository;
  gateway: TelegramGateway;
  publisher: PublicationService;
  scheduler: SchedulerService;
  recovery: RecoveryService;
  health: HealthService;
  logger: Logger;
  operationTracker?: OperationTracker;
  now: () => number;
};

const cleanDisplay = (value: string | undefined): string => (value ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 120);

const parseMessageIds = (text: string, expectedCount?: number): MessageId[] => {
  const parts = text.split(/[\s,]+/u).filter(Boolean);
  if (expectedCount !== undefined && parts.length !== expectedCount) throw new Error(`Enter exactly ${expectedCount} message ID${expectedCount === 1 ? "" : "s"}, in Telegram order.`);
  if (parts.some((part) => !/^\d+$/u.test(part))) throw new Error("Message IDs must be positive decimal integers.");
  return validateOrderedMessageIds(parts.map((part) => Number(part)), "messageIds");
};

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
    `Queue: ${counts.queued ?? 0} queued · ${counts.blocked ?? 0} blocked · ${(counts.uncertain_publish ?? 0) + deps.queue.listActive(10_000).filter((item) => item.maintenanceStatus === "uncertain_renewal").length} uncertain`,
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
    [await button(deps, "Safety review", "safety")],
  ]);

  const sendDashboard = async (ctx: Context): Promise<void> => {
    await ctx.reply(dashboardText(deps), { reply_markup: await dashboardKeyboard() });
  };

  const sendQueue = async (ctx: Context, offset = 0): Promise<void> => {
    const pageSize = 10;
    const page = deps.queue.listActive(pageSize + 1, Math.max(0, offset));
    const items = page.slice(0, pageSize);
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [];
    const lines = [`Queue (FIFO) · items ${items.length === 0 ? "none" : `${offset + 1}–${offset + items.length}`}`, ...items.map((item) => `#${item.id} · ${item.contentType} · ${item.status}${item.maintenanceStatus === "idle" ? "" : ` · maintenance ${item.maintenanceStatus}`} · age ${Math.max(0, deps.now() - item.enqueuedAt)} ms`)];
    for (const item of items) {
      const actions: Array<Awaited<ReturnType<typeof button>>> = [await button(deps, `Delete #${item.id}`, "queue_delete", { itemId: item.id }, item.contentVersion)];
      if (item.status === "uncertain_publish") actions.push(await button(deps, `Resolve #${item.id}`, "queue_uncertain", { itemId: item.id }, item.contentVersion));
      else if (item.maintenanceStatus === "uncertain_renewal") actions.push(await button(deps, `Resolve renewal #${item.id}`, "renewal_uncertain", { itemId: item.id }, item.contentVersion));
      else if (["blocked", "needs_edit", "needs_review", "delete_blocked"].includes(item.status)) actions.push(await button(deps, `Retry #${item.id}`, "queue_retry", { itemId: item.id }, item.contentVersion));
      actions.push(await button(deps, `Move #${item.id}`, "queue_move_end", { itemId: item.id }, item.contentVersion));
      rows.push(actions);
    }
    const navigation: Array<Awaited<ReturnType<typeof button>>> = [];
    if (offset > 0) navigation.push(await button(deps, "Previous", "queue", { offset: Math.max(0, offset - pageSize) }));
    if (page.length > pageSize) navigation.push(await button(deps, "Next", "queue", { offset: offset + pageSize }));
    if (navigation.length > 0) rows.push(navigation);
    rows.push([await button(deps, "Back", "dashboard")]);
    await ctx.reply(lines.join("\n"), { reply_markup: keyboard(rows) });
  };

  const sendSafety = async (ctx: Context, offset = 0): Promise<void> => {
    const pageSize = 10;
    const quarantined = deps.pending.listByState("quarantined_renewal_candidate", pageSize + 1, Math.max(0, offset));
    const terminalOrphans = deps.orphan.terminal(pageSize + 1);
    const counts = deps.pending.countByState();
    const lines = [
      `Safety review · quarantined ${counts.quarantined_renewal_candidate ?? 0} · pending ${counts.pending ?? 0}`,
      `Manual-cleanup orphans: ${deps.orphan.counts().terminal}`,
      ...quarantined.slice(0, pageSize).map((entry) => `Quarantine · ${entry.queueChatId}/${entry.telegramMessageId} · operation ${entry.candidateOperationId ?? "unknown"}`),
      ...terminalOrphans.slice(0, pageSize).map((entry) => `Manual cleanup · #${entry.itemId} generation ${entry.sourceGeneration} · ${entry.chatId}/${entry.messageId} · ${entry.terminalReason ?? entry.reason}`),
    ];
    if (quarantined.length === 0 && terminalOrphans.length === 0) lines.push("No quarantined updates or terminal orphans.");
    const navigation: Array<Awaited<ReturnType<typeof button>>> = [];
    if (offset > 0) navigation.push(await button(deps, "Previous", "safety", { offset: Math.max(0, offset - pageSize) }));
    if (quarantined.length > pageSize) navigation.push(await button(deps, "Next", "safety", { offset: offset + pageSize }));
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [];
    if (navigation.length > 0) rows.push(navigation);
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
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[await button(deps, "Set alias", "alias_add")]];
    for (const author of authors.filter((entry) => entry.alias).slice(0, 20)) rows.push([await button(deps, `Remove alias ${author.userId}`, "alias_remove", { userId: author.userId })]);
    rows.push([await button(deps, "Back", "dashboard")]);
    const text = ["Observed authors", ...authors.slice(0, 20).map((author) => `${author.userId} · ${cleanDisplay(author.displayName)}${author.username ? ` @${cleanDisplay(author.username)}` : ""}${author.alias ? ` → ${cleanDisplay(author.alias)}` : ""}`)].join("\n");
    await ctx.reply(text, { reply_markup: keyboard(rows) });
  };

  const sendHealth = async (ctx: Context): Promise<void> => {
    const health = deps.health.snapshot();
    const oldest = health.oldestPhysicalAgeMs === undefined ? "none" : `${Math.floor(health.oldestPhysicalAgeMs / 3_600_000)}h`;
    const pending = Object.entries(health.pendingUpdates).map(([state, count]) => `${state}=${count}`).join(", ") || "none";
    const rights = health.rights ? `queue post/delete=${health.rights.queue.canPostMessages}/${health.rights.queue.canDeleteMessages} · target post/edit/delete=${health.rights.target.canPostMessages}/${health.rights.target.canEditMessages}/${health.rights.target.canDeleteMessages}` : "unknown";
    await ctx.reply(["Health", `Database: ${health.databaseOk ? "available" : "failed"}`, `Boot: ${health.bootId ?? "unknown"} · lease ${health.leaseOwned ? "owned" : "lost"}`, `Queue head: ${health.queueHead ?? "empty"} · oldest physical source: ${oldest}`, `Scheduling: ${deps.schedule.enabled() ? "enabled" : "paused"}`, `Operations: ${health.activeOperations} active · ${health.uncertainOperations} uncertain`, `Pending updates: ${pending}`, `Orphans: ${health.orphanCounts.unresolved} unresolved · ${health.orphanCounts.terminal} manual`, `Renewal capacity: ${health.renewalCapacity.safe ? "safe" : "unsafe"}`, `Telegram rights: ${rights}`, `Last update: ${health.lastSuccessfulUpdateAt ? new Date(health.lastSuccessfulUpdateAt).toISOString() : "unknown"}`, `Last rights check: ${health.lastRightsCheckAt ? new Date(health.lastRightsCheckAt).toISOString() : "unknown"}`, `Last backup: ${health.lastBackupAt ? new Date(health.lastBackupAt).toISOString() : "unknown"}`, `Active alerts: ${health.alerts.active}`].join("\n"), { reply_markup: keyboard([[await button(deps, "Back", "dashboard")]]) });
  };

  const handlePrompt = async (ctx: Context, text: string): Promise<boolean> => {
    const prompt = deps.admin.getPrompt(deps.config.adminUserId, deps.now());
    if (!prompt) return false;
    if (prompt.expectedReplyToMessageId !== undefined && ctx.message?.reply_to_message?.message_id !== prompt.expectedReplyToMessageId) {
      await ctx.reply("Reply to the active admin prompt to continue, or use /cancel.");
      return true;
    }
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
        deps.admin.audit("recovery_completed", String(deps.config.adminUserId), deps.now(), recovered.itemId, undefined, { sourceIds: recovered.sourceIds });
        await ctx.reply(`Recovered queue item #${recovered.itemId} from source IDs ${recovered.sourceIds.join(", ")}. Telegram history remains explicit; verify the supplied IDs covered the intended post.`);
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : "Recovery failed; no queue item was confirmed.");
      }
      return true;
    }
    if (prompt.kind === "renewal_adopt" || prompt.kind === "renewal_manual_cleanup" || prompt.kind === "uncertain_publish_adopt") {
      const state = prompt.state && typeof prompt.state === "object" ? prompt.state as Record<string, unknown> : {};
      const itemId = typeof state.itemId === "number" ? state.itemId : undefined;
      const operationId = typeof state.operationId === "string" ? state.operationId : undefined;
      const sourceGeneration = typeof state.sourceGeneration === "number" ? state.sourceGeneration : undefined;
      const expectedCount = typeof state.expectedCount === "number" ? state.expectedCount : undefined;
      const phase = typeof state.phase === "string" ? state.phase : undefined;
      const item = itemId === undefined ? undefined : deps.queue.findItemById(itemId);
      const evidence = itemId === undefined ? undefined : deps.queue.operationEvidence(itemId);
      const renewalPrompt = prompt.kind === "renewal_adopt" || prompt.kind === "renewal_manual_cleanup";
      const validItem = renewalPrompt ? item?.maintenanceStatus === "uncertain_renewal" : item?.status === "uncertain_publish";
      if (itemId === undefined || !item || !evidence || operationId === undefined || sourceGeneration === undefined || phase === undefined || !validItem || evidence.operationId !== operationId || evidence.phase !== phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== sourceGeneration) {
        deps.admin.clearPrompt(deps.config.adminUserId);
        await ctx.reply("This renewal resolution is stale; reopen the queue.");
        return true;
      }
      try {
        if (prompt.kind === "renewal_adopt" || prompt.kind === "uncertain_publish_adopt") {
          if (expectedCount === undefined) throw new Error(prompt.kind === "renewal_adopt" ? "This renewal has no captured replacement count; use manual cleanup." : "This publication has no captured output count; use another resolution.");
          const ids = parseMessageIds(text.trim(), expectedCount);
          if (prompt.kind === "renewal_adopt") deps.queue.adoptUncertainRenewalGeneration({ operationId, itemId, capturedContentVersion: item.contentVersion, capturedSourceGeneration: sourceGeneration }, ids, deps.now());
          else deps.queue.adoptConfirmedPublicationOutputs(itemId, operationId, item.contentVersion, sourceGeneration, deps.config.targetChannelId, ids, deps.now());
          deps.admin.clearPrompt(deps.config.adminUserId);
          await ctx.reply(prompt.kind === "renewal_adopt" ? `Adopted replacement generation ${sourceGeneration + 1} for queue item #${itemId}; old-source cleanup remains durable and retryable.` : `Adopted the exact destination IDs for queue item #${itemId}; source cleanup remains durable and retryable.`);
        } else {
          const ids = parseMessageIds(text.trim());
          try {
            await deps.gateway.deleteMessages(deps.config.queueChannelId, ids);
            deps.queue.resolveUncertainRenewal(itemId, operationId, item.contentVersion, sourceGeneration, deps.now(), [], "manual_cleanup");
          } catch (error) {
            const normalized = classifyTelegramError(error);
            if (normalized.kind !== "source_missing") {
              deps.queue.resolveUncertainRenewal(itemId, operationId, item.contentVersion, sourceGeneration, deps.now(), ids, "manual_cleanup");
            } else {
              deps.queue.resolveUncertainRenewal(itemId, operationId, item.contentVersion, sourceGeneration, deps.now(), [], "manual_cleanup");
            }
          }
          deps.admin.clearPrompt(deps.config.adminUserId);
          await ctx.reply(`Recorded explicit cleanup handling for queue item #${itemId}.`);
        }
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : "Could not apply that renewal resolution.");
      }
      return true;
    }
    return false;
  };

  const handleCallback = async (ctx: Context): Promise<unknown> => {
    if (!isAuthorized(ctx, deps.config.adminUserId)) return reject(ctx);
    await ctx.answerCallbackQuery();
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
      case "queue": return sendQueue(ctx, typeof payload.offset === "number" ? payload.offset : 0);
      case "schedule": return sendSchedule(ctx);
      case "whitelist": return sendWhitelist(ctx);
      case "authors": return sendAuthors(ctx);
      case "health": return sendHealth(ctx);
      case "safety": return sendSafety(ctx, typeof payload.offset === "number" ? payload.offset : 0);
      case "publish": {
        const head = deps.queue.getHead();
        if (!head) return ctx.reply("The queue is empty.");
        if (head.status !== "queued" || head.maintenanceStatus !== "idle") return ctx.reply(`The head is ${head.status}${head.maintenanceStatus === "idle" ? "" : ` (${head.maintenanceStatus})`} and cannot be published automatically.`);
        const confirm = await button(deps, "Confirm publish", "publish_execute", { itemId: head.id, sourceGeneration: head.sourceGeneration }, head.contentVersion);
        return ctx.reply(`Publish queue head #${head.id} now? This captures the current policy and deletes the source only after complete destination output.`, { reply_markup: keyboard([[confirm], [await button(deps, "Cancel", "dashboard")]]) });
      }
      case "publish_execute": {
        const item = itemId === undefined ? undefined : deps.queue.findItemById(itemId);
        if (!item || deps.queue.getHead()?.id !== item.id || item.status !== "queued" || item.maintenanceStatus !== "idle" || typeof payload.sourceGeneration !== "number" || item.sourceGeneration !== payload.sourceGeneration) return ctx.reply("The queue head changed; reopen the dashboard.");
        const outcome = await deps.scheduler.manualPublish();
        deps.admin.audit("manual_publish", String(deps.config.adminUserId), deps.now(), item.id, "operationId" in outcome ? outcome.operationId : undefined, { outcome: outcome.kind, contentVersion: item.contentVersion, sourceGeneration: item.sourceGeneration });
        return sendDashboard(ctx);
      }
      case "slot_add": deps.admin.setPrompt(deps.config.adminUserId, "slot_add", {}, ctx.callbackQuery?.message?.message_id, deps.now()); return ctx.reply("Send the exact daily UTC slot as HH:MM.");
      case "slot_remove": if (typeof payload.minuteOfDay === "number") deps.schedule.removeSlot(payload.minuteOfDay, deps.config.adminUserId, deps.now()); return sendSchedule(ctx);
      case "schedule_pause": deps.schedule.setEnabled(false, deps.config.adminUserId, deps.now()); return sendSchedule(ctx);
      case "schedule_resume": if (deps.schedule.slots().length === 0) return ctx.reply("Add at least one UTC slot first."); deps.schedule.setEnabled(true, deps.config.adminUserId, deps.now()); return sendSchedule(ctx);
      case "whitelist_add": deps.admin.setPrompt(deps.config.adminUserId, "whitelist_add", {}, ctx.callbackQuery?.message?.message_id, deps.now()); return ctx.reply("Send an exact public @handle or numeric channel ID.");
      case "whitelist_confirm": {
        if (typeof payload.chatId !== "number") return ctx.reply("Invalid confirmation payload.");
        deps.policy.upsertChannel(payload.chatId, typeof payload.username === "string" ? payload.username : undefined, typeof payload.title === "string" ? payload.title : undefined, deps.config.adminUserId, deps.now());
        return sendWhitelist(ctx);
      }
      case "whitelist_remove": {
        if (typeof payload.chatId !== "number") return ctx.reply("Invalid channel.");
        return ctx.reply("Remove this numeric channel from the whitelist?", { reply_markup: keyboard([[await button(deps, "Confirm removal", "whitelist_remove_execute", { chatId: payload.chatId })], [await button(deps, "Cancel", "whitelist")]]) });
      }
      case "whitelist_remove_execute": if (typeof payload.chatId === "number") deps.policy.removeChannel(payload.chatId, deps.config.adminUserId, deps.now()); return sendWhitelist(ctx);
      case "alias_add": deps.admin.setPrompt(deps.config.adminUserId, "alias_add", {}, ctx.callbackQuery?.message?.message_id, deps.now()); return ctx.reply("Send `<user id or @observed_username> <alias>`.");
      case "alias_remove": if (typeof payload.userId === "number") deps.policy.removeAlias(payload.userId, deps.config.adminUserId, deps.now()); return sendAuthors(ctx);
      case "queue_retry": {
        if (itemId === undefined) return ctx.reply("Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item || !["blocked", "needs_edit", "needs_review", "delete_blocked"].includes(item.status) || item.maintenanceStatus !== "idle") return ctx.reply("Uncertain and active-maintenance items require their state-specific resolution flow.");
        return ctx.reply(`Retry queue item #${itemId} from ${item.status}?`, { reply_markup: keyboard([[await button(deps, "Confirm retry", "queue_retry_execute", { itemId }, item.contentVersion)], [await button(deps, "Cancel", "queue")]]) });
      }
      case "queue_retry_execute": {
        if (itemId === undefined) return ctx.reply("Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item || !["blocked", "needs_edit", "needs_review", "delete_blocked"].includes(item.status) || item.maintenanceStatus !== "idle") return ctx.reply("This queue item changed; reopen the queue.");
        deps.queue.retryItem(itemId, deps.now());
        deps.admin.audit("queue_retry", String(deps.config.adminUserId), deps.now(), itemId, undefined, { previousStatus: item.status });
        return sendQueue(ctx);
      }
      case "queue_move_end": {
        if (itemId === undefined) return ctx.reply("Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item) return ctx.reply("Queue item no longer exists.");
        const confirm = await button(deps, "Confirm move to end", "queue_move_execute", { itemId }, item.contentVersion);
        return ctx.reply(`Move queue item #${itemId} to the FIFO end?`, { reply_markup: keyboard([[confirm], [await button(deps, "Cancel", "queue")]]) });
      }
      case "queue_move_execute": {
        if (itemId === undefined) return ctx.reply("Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item || item.status === "done" || item.status === "deleted" || item.status === "deleted_external") return ctx.reply("Queue item changed; reopen the queue.");
        deps.queue.moveToEnd(itemId, deps.now());
        deps.admin.audit("queue_moved_to_end", String(deps.config.adminUserId), deps.now(), itemId, undefined, { contentVersion: item.contentVersion });
        return sendQueue(ctx);
      }
      case "queue_uncertain": {
        if (itemId === undefined) return ctx.reply("Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || item.status !== "uncertain_publish" || !evidence) return ctx.reply("This publication is no longer awaiting uncertainty resolution.");
        const retry = await button(deps, "I confirm nothing was published — retry", "uncertain_publish_retry", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion);
        const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[retry]];
        if (evidence.expectedOutputCount === evidence.knownDestinationIds.length && evidence.expectedOutputCount > 0) rows.push([await button(deps, "Destination is complete", "uncertain_publish_adopt_known", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        if (evidence.expectedOutputCount !== undefined) rows.push([await button(deps, "Enter exact destination IDs", "uncertain_publish_adopt_prompt", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, expectedCount: evidence.expectedOutputCount, phase: evidence.phase }, item.contentVersion)]);
        if (evidence.expectedOutputCount === evidence.knownDestinationIds.length && evidence.expectedOutputCount === evidence.sourceIds.length && evidence.expectedOutputCount > 0) rows.push([await button(deps, "Delete known outputs and retry", "uncertain_publish_delete_retry", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        rows.push([await button(deps, "Delete queue item", "queue_delete", { itemId }, item.contentVersion)], [await button(deps, "Back", "queue")]);
        return ctx.reply([`Uncertain publication #${itemId}`, `Operation: ${evidence.operationId}`, `Phase: ${evidence.phase}`, `Captured source IDs: ${evidence.sourceIds.join(", ") || "unknown"}`, `Known destination IDs: ${evidence.knownDestinationIds.join(", ") || "none"}`, `Expected destination count: ${evidence.expectedOutputCount ?? "unknown"}`, "Choose an explicit resolution; retrying can duplicate a Telegram send."].join("\n"), { reply_markup: keyboard(rows) });
      }
      case "uncertain_publish_retry": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return ctx.reply("Invalid uncertainty resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.status !== "uncertain_publish" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration) return ctx.reply("This uncertainty resolution is stale.");
        deps.queue.requeueUncertainPublication(itemId, evidence.operationId, item.contentVersion, item.sourceGeneration, deps.now(), "admin_confirmed_nothing_published");
        deps.admin.audit("uncertain_publication_retry", String(deps.config.adminUserId), deps.now(), itemId, evidence.operationId, { duplicateRiskConfirmed: true });
        return sendQueue(ctx);
      }
      case "uncertain_publish_adopt_known": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return ctx.reply("Invalid uncertainty resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.status !== "uncertain_publish" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration) return ctx.reply("This uncertainty resolution is stale.");
        try {
          deps.queue.adoptConfirmedPublicationOutputs(itemId, evidence.operationId, item.contentVersion, item.sourceGeneration, deps.config.targetChannelId, evidence.knownDestinationIds, deps.now());
          deps.admin.audit("uncertain_publication_destination_adopted", String(deps.config.adminUserId), deps.now(), itemId, evidence.operationId, { destinationIds: evidence.knownDestinationIds });
          return sendQueue(ctx);
        } catch (error) {
          return ctx.reply(error instanceof Error ? error.message : "Could not adopt those destination IDs.");
        }
      }
      case "uncertain_publish_adopt_prompt":
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.expectedCount !== "number" || typeof payload.phase !== "string") return ctx.reply("Invalid uncertainty resolution.");
        deps.admin.setPrompt(deps.config.adminUserId, "uncertain_publish_adopt", { itemId, operationId: payload.operationId, sourceGeneration: payload.sourceGeneration, expectedCount: payload.expectedCount, phase: payload.phase }, ctx.callbackQuery?.message?.message_id, deps.now());
        return ctx.reply(`Reply with exactly ${payload.expectedCount} destination message IDs in Telegram order, separated by spaces or commas.`);
      case "uncertain_publish_delete_retry": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return ctx.reply("Invalid uncertainty resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.status !== "uncertain_publish" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration || evidence.expectedOutputCount === undefined || evidence.expectedOutputCount !== evidence.knownDestinationIds.length || evidence.expectedOutputCount !== evidence.sourceIds.length) return ctx.reply("This cleanup resolution is stale or output evidence is incomplete.");
        try {
          try { await deps.gateway.deleteMessages(deps.config.targetChannelId, evidence.knownDestinationIds); }
          catch (error) { if (classifyTelegramError(error).kind !== "source_missing") throw error; }
          deps.queue.requeueUncertainPublication(itemId, evidence.operationId, item.contentVersion, item.sourceGeneration, deps.now(), "admin_deleted_known_outputs");
          deps.admin.audit("uncertain_publication_outputs_deleted_retry", String(deps.config.adminUserId), deps.now(), itemId, evidence.operationId, { destinationIds: evidence.knownDestinationIds });
          return sendQueue(ctx);
        } catch (error) {
          return ctx.reply(error instanceof Error ? error.message : "Known output cleanup failed; the item remains uncertain.");
        }
      }
      case "renewal_uncertain": {
        if (itemId === undefined) return ctx.reply("Invalid renewal item.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || item.maintenanceStatus !== "uncertain_renewal" || !evidence) return ctx.reply("This renewal is no longer awaiting resolution.");
        const rows: Array<Awaited<ReturnType<typeof button>>[]> = [];
        if (evidence.expectedSourceCount !== undefined && evidence.knownReplacementIds.length === evidence.expectedSourceCount) rows.push([await button(deps, "Adopt known replacements", "renewal_adopt_known", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        if (evidence.expectedSourceCount !== undefined) rows.push([await button(deps, "Enter exact replacements", "renewal_adopt_prompt", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, expectedCount: evidence.expectedSourceCount, phase: evidence.phase }, item.contentVersion)]);
        if (evidence.knownReplacementIds.length === 0) rows.push([await button(deps, "Confirm no replacement exists", "renewal_no_replacement", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        else rows.push([await button(deps, "Delete known replacements", "renewal_delete_replacements", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        rows.push([await button(deps, "Enter manual cleanup IDs", "renewal_cleanup_prompt", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        rows.push([await button(deps, "Back", "queue")]);
        return ctx.reply([`Uncertain renewal #${itemId}`, `Operation: ${evidence.operationId}`, `Captured source IDs: ${evidence.sourceIds.join(", ") || "unknown"}`, `Known replacement IDs: ${evidence.knownReplacementIds.join(", ") || "none"}`, `Expected replacement count: ${evidence.expectedSourceCount ?? "unknown"}`, "The logical publication status remains unchanged until a physical resolution is confirmed."].join("\n"), { reply_markup: keyboard(rows) });
      }
      case "renewal_adopt_known": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return ctx.reply("Invalid renewal resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.maintenanceStatus !== "uncertain_renewal" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration || evidence.expectedSourceCount !== evidence.knownReplacementIds.length) return ctx.reply("This renewal evidence is incomplete or stale; enter the exact replacement IDs instead.");
        try {
          deps.queue.adoptUncertainRenewalGeneration({ operationId: evidence.operationId, itemId, capturedContentVersion: item.contentVersion, capturedSourceGeneration: item.sourceGeneration }, evidence.knownReplacementIds, deps.now());
          return sendQueue(ctx);
        } catch (error) {
          return ctx.reply(error instanceof Error ? error.message : "Could not adopt those replacement IDs.");
        }
      }
      case "renewal_adopt_prompt":
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.expectedCount !== "number" || typeof payload.phase !== "string") return ctx.reply("Invalid renewal resolution.");
        deps.admin.setPrompt(deps.config.adminUserId, "renewal_adopt", { itemId, operationId: payload.operationId, sourceGeneration: payload.sourceGeneration, expectedCount: payload.expectedCount, phase: payload.phase }, ctx.callbackQuery?.message?.message_id, deps.now());
        return ctx.reply(`Reply with exactly ${payload.expectedCount} replacement message IDs in Telegram order, separated by spaces or commas.`);
      case "renewal_cleanup_prompt":
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return ctx.reply("Invalid renewal resolution.");
        deps.admin.setPrompt(deps.config.adminUserId, "renewal_manual_cleanup", { itemId, operationId: payload.operationId, sourceGeneration: payload.sourceGeneration, phase: payload.phase }, ctx.callbackQuery?.message?.message_id, deps.now());
        return ctx.reply("Reply with the exact replacement message IDs to delete or retry, in Telegram order. The item remains blocked until this explicit cleanup decision is recorded.");
      case "renewal_no_replacement": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return ctx.reply("Invalid renewal resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.maintenanceStatus !== "uncertain_renewal" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration || evidence.knownReplacementIds.length > 0) return ctx.reply("This renewal resolution is stale or replacements are known.");
        deps.queue.resolveUncertainRenewal(itemId, evidence.operationId, item.contentVersion, item.sourceGeneration, deps.now(), [], "no_replacement");
        return sendQueue(ctx);
      }
      case "renewal_delete_replacements": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return ctx.reply("Invalid renewal resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.maintenanceStatus !== "uncertain_renewal" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration) return ctx.reply("This renewal resolution is stale.");
        try {
          try {
            await deps.gateway.deleteMessages(deps.config.queueChannelId, evidence.knownReplacementIds);
          } catch (error) {
            const normalized = classifyTelegramError(error);
            if (normalized.kind !== "source_missing") throw error;
          }
          deps.queue.resolveUncertainRenewal(itemId, evidence.operationId, item.contentVersion, item.sourceGeneration, deps.now(), [], "manual_cleanup");
          return sendQueue(ctx);
        } catch (error) {
          return ctx.reply(`Replacement cleanup failed (${classifyTelegramError(error).kind}); the item remains uncertain.`);
        }
      }
      case "queue_delete": {
        if (itemId === undefined) return ctx.reply("Invalid queue item.");
        const confirm = await button(deps, `Confirm delete #${itemId}`, "queue_delete_confirm", { itemId }, resolved.itemVersion);
        return ctx.reply("Delete this queue item from Telegram and SQLite?", { reply_markup: keyboard([[confirm], [await button(deps, "Cancel", "queue")]]) });
      }
      case "queue_delete_confirm": {
        if (itemId === undefined) return ctx.reply("Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item) return ctx.reply("Queue item no longer exists.");
        const finish = deps.operationTracker?.begin(`delete:${itemId}:${deps.now()}`);
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
        } finally {
          finish?.();
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

  command("start", async (ctx) => {
    await ctx.api.setMyCommands([
      { command: "start", description: "Open queue manager" },
      { command: "manage", description: "Open queue manager" },
      { command: "queue", description: "Browse FIFO queue" },
      { command: "schedule", description: "Manage UTC slots" },
      { command: "whitelist", description: "Manage channel whitelist" },
      { command: "authors", description: "Manage author aliases" },
      { command: "health", description: "Show health" },
      { command: "recover", description: "Recover an explicit queue message" },
      { command: "cancel", description: "Cancel the current prompt" },
    ], { scope: { type: "chat", chat_id: deps.config.adminUserId } });
    await sendDashboard(ctx);
  });
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

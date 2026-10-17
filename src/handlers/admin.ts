import type { Bot, Context } from "grammy";
import { classifyTelegramError } from "../errors";
import { safeDisplayName, validateAlias } from "../domain/byline";
import { formatAge } from "../domain/age";
import { formatUtcSlot, parseUtcSlot } from "../domain/schedule";
import { buildQueueMessageLink } from "../domain/telegram-message-link";
import { validateOrderedMessageIds } from "../domain/validation";
import type { PolicyRepository, QueueRepository, ScheduleRepository } from "../db/repositories";
import type { AdminRepository } from "../db/admin-repository";
import type { AdminResponseRepository, AdminResponseKind } from "../db/admin-response-repository";
import { createHash, randomUUID } from "node:crypto";
import type { AdminActionButton, AdminReplyMarkupIntent, AdminResponseDescriptor } from "../services/admin-response-worker";
import type { AdminUpdateRepository } from "../db/admin-update-repository";
import type { OrphanRepository } from "../db/orphan-repository";
import type { PendingUpdateRepository } from "../db/pending-update-repository";
import type { PreparationRepository } from "../db/preparation-repository";
import type { AppConfig } from "../config";
import type { Logger } from "../logger";
import type { TelegramGateway } from "../telegram";
import type { PublicationOutcome, PublicationService } from "../services/publisher";
import type { SchedulerService } from "../services/scheduler";
import type { RecoveryService } from "../services/recovery";
import type { HealthService } from "../services/health";
import type { OperationTracker } from "../services/task-supervisor";
import { asChatId, asMessageId, type ChatId, type MessageId, type UserId } from "../types";

type AdminDeps = {
  config: AppConfig;
  queue: QueueRepository;
  policy: PolicyRepository;
  schedule: ScheduleRepository;
  admin: AdminRepository;
  responses: AdminResponseRepository;
  updates: AdminUpdateRepository;
  bootId: string;
  pending: PendingUpdateRepository;
  preparation: PreparationRepository;
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

type PromptSpec = {
  kind: string;
  state: unknown;
  text: string;
  placeholder?: string;
};

const cleanDisplay = (value: string | undefined): string => (value ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 120);

const parseMessageIds = (text: string, expectedCount?: number): MessageId[] => {
  const parts = text.split(/[\s,]+/u).filter(Boolean);
  if (expectedCount !== undefined && parts.length !== expectedCount) throw new Error(`Enter exactly ${expectedCount} message ID${expectedCount === 1 ? "" : "s"}, in Telegram order.`);
  if (parts.some((part) => !/^\d+$/u.test(part))) throw new Error("Message IDs must be positive decimal integers.");
  return validateOrderedMessageIds(parts.map((part) => Number(part)), "messageIds");
};

const isAuthorized = (ctx: Context, adminUserId: UserId): boolean => ctx.from?.id === adminUserId && ctx.chat?.type === "private";

const button = (_deps: AdminDeps, text: string, action: string, payload: unknown = {}, itemVersion?: number): AdminActionButton => ({ text, action, payload, ...(itemVersion === undefined ? {} : { itemVersion }) });

const keyboard = (rows: AdminActionButton[][]): AdminReplyMarkupIntent => ({ kind: "inline_keyboard", rows });

const dashboardText = (deps: AdminDeps): string => {
  const now = deps.now();
  const counts = deps.queue.statusCounts();
  const activeItems = deps.queue.listActive(10_000);
  const head = deps.queue.getHead();
  const ready = deps.queue.peekNextReady(now);
  const slots = deps.schedule.slots();
  const next = deps.scheduler.nextAt();
  const nextText = next === undefined ? "not configured" : new Date(next).toISOString();
  const status = deps.schedule.enabled() ? "running" : "paused";
  const headText = head ? `#${head.id} · ${head.status} · logical age ${formatAge(Math.max(0, now - head.enqueuedAt))}` : "empty";
  const readyText = ready ? `#${ready.id} · logical age ${formatAge(Math.max(0, now - ready.enqueuedAt))}` : "none currently ready";
  return [
    "Telegram queue manager",
    `Schedule: ${status} · ${slots.map(formatUtcSlot).join(", ") || "no UTC slots"}`,
    `Next run: ${nextText}`,
    `Queue: ${counts.queued ?? 0} queued · ${counts.blocked ?? 0} blocked · ${(counts.uncertain_publish ?? 0) + activeItems.filter((item) => item.maintenanceStatus === "uncertain_renewal" || item.preparationState === "uncertain").length} uncertain`,
    `Next to publish: ${readyText}`,
    `Earliest active item: ${headText}`,
    `Renewal warnings: ${deps.queue.listRenewalAges(deps.now()).filter((entry) => entry.ageMs >= 42 * 60 * 60 * 1000).length}`,
  ].join("\n");
};

export const registerAdminHandlers = (bot: Bot, deps: AdminDeps): void => {
  bot.use(async (ctx, next) => {
    if (!isAuthorized(ctx, deps.config.adminUserId)) return next();
    const updateId = ctx.update.update_id;
    const callbackData = ctx.callbackQuery?.data;
    const text = ctx.message?.text;
    const prompt = text === undefined ? undefined : deps.admin.getPrompt(deps.config.adminUserId, deps.now());
    const actionKind = callbackData !== undefined
      ? "callback"
      : text?.startsWith("/") ? `command:${text.slice(1).split(/[\s@]/u, 1)[0]?.toLowerCase() ?? "unknown"}`
        : prompt === undefined ? "message" : `prompt:${prompt.kind}`;
    const actionPayload = callbackData !== undefined
      ? { callbackDigest: createHash("sha256").update(callbackData).digest("hex") }
      : prompt === undefined ? {} : { promptKind: prompt.kind };
    if (!deps.updates.begin({ updateId, adminId: deps.config.adminUserId, actionKind, actionPayload, bootId: deps.bootId, now: deps.now() })) {
      if (ctx.callbackQuery) { try { await ctx.answerCallbackQuery({ text: "This action was already processed." }); } catch { /* Callback acknowledgement is best effort. */ } }
      return;
    }
    try {
      await next();
      deps.updates.finish(updateId, "applied", { handled: true }, deps.now());
    } catch (error) {
      try { deps.updates.finish(updateId, "uncertain", { reason: classifyTelegramError(error).kind }, deps.now()); }
      catch { /* Preserve the first durable state if another path already resolved it. */ }
      throw error;
    }
  });
  const enqueueReply = (ctx: Context, text: string, options: Record<string, unknown> = {}, responseKind: AdminResponseKind = "confirmation", coalesceKey?: string): void => {
    const updateId = ctx.update.update_id;
    const markup = options.reply_markup as AdminReplyMarkupIntent | undefined;
    const descriptor: AdminResponseDescriptor = { version: 1, text };
    if (Array.isArray(options.entities)) {
      const entities = options.entities as NonNullable<AdminResponseDescriptor["entities"]>;
      descriptor.entities = entities;
    }
    const linkOptions = options.link_preview_options as { is_disabled?: unknown } | undefined;
    if (linkOptions?.is_disabled === true) descriptor.disableLinkPreview = true;
    if (markup !== undefined) descriptor.replyMarkup = markup;
    const row = deps.responses.enqueue({ adminChatId: deps.config.adminUserId, updateId, kind: responseKind, descriptor, ...(coalesceKey === undefined ? {} : { coalesceKey }), now: deps.now() });
    void row;
  };

  const deferAction = (ctx: Context, actionKind: string, payload: unknown): void => {
    if (!deps.updates.defer(ctx.update.update_id, actionKind, payload, deps.now())) throw new Error("Admin update receipt could not be moved to durable action work");
  };

  const deferPromptAction = (ctx: Context, actionKind: string, payload: unknown): void => deps.updates.transaction(() => {
    clearPrompt();
    deferAction(ctx, actionKind, payload);
  });

  const clearPrompt = (): void => {
    const existing = deps.admin.getPrompt(deps.config.adminUserId, deps.now());
    if (existing?.deliveryOutboxId !== undefined) deps.responses.cancel(existing.deliveryOutboxId, deps.now());
    deps.admin.clearPrompt(deps.config.adminUserId);
  };

  const reject = async (ctx: Context): Promise<void> => {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Not authorized", show_alert: true });
    else if (ctx.chat?.type === "private") await ctx.reply("Not authorized.");
  };

  const beginPrompt = async (ctx: Context, spec: PromptSpec): Promise<void> => {
    const generationId = randomUUID();
    const descriptor: AdminResponseDescriptor = { version: 1, text: spec.text, replyMarkup: { kind: "force_reply", ...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder }) }, prompt: { adminId: deps.config.adminUserId, generationId, kind: spec.kind } };
    deps.updates.transaction(() => {
      clearPrompt();
      const queued = deps.responses.enqueue({ adminChatId: deps.config.adminUserId, updateId: ctx.update.update_id, kind: "prompt", descriptor, now: deps.now() });
      deps.admin.setPendingPrompt(deps.config.adminUserId, spec.kind, spec.state, generationId, queued.record.id, deps.now());
      deps.updates.finish(ctx.update.update_id, "applied", { handled: true, promptQueued: true }, deps.now());
    });
  };

  const deleteCallbackMenu = async (ctx: Context, action: string): Promise<void> => {
    void ctx;
    void action;
  };

  const dashboardKeyboard = async (): Promise<AdminReplyMarkupIntent> => keyboard([
    [await button(deps, "Queue", "queue"), await button(deps, "Publish next now", "publish")],
    [await button(deps, "Schedule", "schedule"), await button(deps, "Whitelist", "whitelist")],
    [await button(deps, "Author names", "authors"), await button(deps, "Health", "health")],
    [await button(deps, "Safety review", "safety")],
  ]);

  const sendDashboard = async (ctx: Context): Promise<void> => {
    await enqueueReply(ctx, dashboardText(deps), { reply_markup: await dashboardKeyboard() }, "view", `admin:${deps.config.adminUserId}:view:dashboard`);
  };

  const uncertainPublicationResponse = async (itemId: number): Promise<{ text: string; replyMarkup: AdminReplyMarkupIntent } | undefined> => {
    const item = deps.queue.findItemById(itemId);
    const evidence = deps.queue.operationEvidence(itemId);
    if (!item || item.status !== "uncertain_publish" || !evidence) return undefined;
    const retry = await button(deps, "I confirm nothing was published — retry", "uncertain_publish_retry", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion);
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[retry]];
    if (evidence.expectedOutputCount === evidence.knownDestinationIds.length && evidence.expectedOutputCount > 0) rows.push([await button(deps, "Destination is complete", "uncertain_publish_adopt_known", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
    if (evidence.expectedOutputCount !== undefined) rows.push([await button(deps, "Enter exact destination IDs", "uncertain_publish_adopt_prompt", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, expectedCount: evidence.expectedOutputCount, phase: evidence.phase }, item.contentVersion)]);
    if (evidence.expectedOutputCount === evidence.knownDestinationIds.length && evidence.expectedOutputCount === evidence.sourceIds.length && evidence.expectedOutputCount > 0) rows.push([await button(deps, "Delete known outputs and retry", "uncertain_publish_delete_retry", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
    rows.push([await button(deps, "Delete queue item", "queue_delete", { itemId }, item.contentVersion)], [await button(deps, "Back", "queue")]);
    return {
      text: [`Uncertain publication #${itemId}`, `Operation: ${evidence.operationId}`, `Phase: ${evidence.phase}`, `Captured source IDs: ${evidence.sourceIds.join(", ") || "unknown"}`, `Known destination IDs: ${evidence.knownDestinationIds.join(", ") || "none"}`, `Expected destination count: ${evidence.expectedOutputCount ?? "unknown"}`, "The destination may already contain this post. It will not be retried until you resolve it; other ready posts can use later slots.", "Choose an explicit resolution; retrying can duplicate a Telegram send."].join("\n"),
      replyMarkup: keyboard(rows),
    };
  };

  const uncertainPreparationResponse = async (itemId: number): Promise<{ text: string; replyMarkup: AdminReplyMarkupIntent } | undefined> => {
    const item = deps.queue.findItemById(itemId);
    const evidence = deps.preparation.operationEvidence(itemId).find((entry) => entry.state === "uncertain");
    if (!item || item.status !== "needs_review" || item.preparationState !== "uncertain" || !evidence) return undefined;
    const outputs = evidence.outputs as Array<{ chat_id: number; telegram_message_id: number; ordinal: number; step_key: string; source_member_key: string | null; role: string }>;
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [];
    if (outputs.length === 0) {
      rows.push([await button(deps, "Confirm no output and retry", "preparation_uncertain_retry", { itemId, operationId: evidence.operationId, phase: evidence.phase }, item.contentVersion)]);
      rows.push([await button(deps, "Keep in review", "preparation_uncertain_discard", { itemId, operationId: evidence.operationId, phase: evidence.phase }, item.contentVersion)]);
    } else {
      rows.push([await button(deps, "Delete tracked outputs and retry", "preparation_uncertain_cleanup_retry", { itemId, operationId: evidence.operationId, phase: evidence.phase }, item.contentVersion)]);
      rows.push([await button(deps, "Delete tracked outputs and keep in review", "preparation_uncertain_cleanup_discard", { itemId, operationId: evidence.operationId, phase: evidence.phase }, item.contentVersion)]);
    }
    rows.push([await button(deps, "Back", "queue")]);
    const outputLines = outputs.map((output) => `Output ${output.chat_id}/${output.telegram_message_id} · ${output.role} · ${output.step_key}${output.source_member_key ? ` · member ${output.source_member_key}` : ""}`);
    return {
      text: [`Uncertain preparation #${itemId}`, `Operation: ${evidence.operationId}`, `Phase: ${evidence.phase}`, `Known output count: ${outputs.length}`, ...outputLines, "The original source remains in the queue. Retrying is allowed only after you confirm that no result exists or delete the tracked outputs.", "Any output Telegram created but did not return cannot be reconciled automatically; choose a resolution only after checking the queue channel."].join("\n"),
      replyMarkup: keyboard(rows),
    };
  };

  const sendQueue = async (ctx: Context, offset = 0): Promise<void> => {
    const now = deps.now();
    const pageSize = 10;
    const page = deps.queue.listActive(pageSize + 1, Math.max(0, offset));
    const items = page.slice(0, pageSize);
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [];
    const ready = deps.queue.peekNextReady(now);
    const lines = [`Queue · logical order · items ${items.length === 0 ? "none" : `${offset + 1}–${offset + items.length}`}`, `Next to publish: ${ready ? `#${ready.id}` : "none currently ready"}`];
    let text = lines.join("\n");
    const entities: Array<{ type: "text_link"; offset: number; length: number; url: string }> = [];
    for (const item of items) {
      const label = `#${item.id}`;
      const preparationState = item.preparationState ?? "unprepared";
      const preparation = preparationState === "ready" ? "ready to publish" : preparationState.replaceAll("_", " ");
      const row = `${label} · ${item.contentType} · ${item.status} · ${preparation}${item.maintenanceStatus === "idle" ? "" : ` · maintenance ${item.maintenanceStatus}`} · age ${formatAge(Math.max(0, now - item.enqueuedAt))}`;
      const rowOffset = text.length + 1;
      text += `\n${row}`;
      const sourceMessageId = deps.queue.currentSourceIds(item.id)[0];
      if (sourceMessageId !== undefined) {
        const url = buildQueueMessageLink(deps.config.queueChannelId, sourceMessageId);
        if (url !== undefined) entities.push({ type: "text_link", offset: rowOffset, length: label.length, url });
      }
      const actions: Array<Awaited<ReturnType<typeof button>>> = [await button(deps, `Delete #${item.id}`, "queue_delete", { itemId: item.id }, item.contentVersion)];
      if (item.status === "uncertain_publish") actions.push(await button(deps, `Resolve #${item.id}`, "queue_uncertain", { itemId: item.id }, item.contentVersion));
      else if (item.preparationState === "uncertain") actions.push(await button(deps, `Resolve preparation #${item.id}`, "preparation_uncertain", { itemId: item.id }, item.contentVersion));
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
    await enqueueReply(ctx, text, { entities, link_preview_options: { is_disabled: true }, reply_markup: keyboard(rows) }, "view", `admin:${deps.config.adminUserId}:view:queue`);
  };

  const sendPublicationOutcome = async (ctx: Context, outcome: PublicationOutcome): Promise<void> => {
    const queue = await button(deps, "Queue", "queue");
    const dashboard = await button(deps, "Dashboard", "dashboard");
    switch (outcome.kind) {
      case "published":
        await enqueueReply(ctx, `Queue item #${outcome.itemId} was published and source cleanup completed.`, { reply_markup: keyboard([[queue], [dashboard]]) });
        return;
      case "cleanup_pending":
        await enqueueReply(ctx, `Queue item #${outcome.itemId} was published, but source cleanup is pending. Do not republish it; cleanup will be retried safely.`, { reply_markup: keyboard([[queue], [dashboard]]) });
        return;
      case "uncertain": {
        const response = await uncertainPublicationResponse(outcome.itemId);
        if (response) {
          await enqueueReply(ctx, response.text, { reply_markup: response.replyMarkup });
          return;
        }
        await enqueueReply(ctx, `Publication for queue item #${outcome.itemId} may already exist. Automatic retry is unsafe; other ready posts remain eligible for later slots. Reopen Queue to resolve it.`, { reply_markup: keyboard([[await button(deps, `Resolve #${outcome.itemId}`, "queue_uncertain", { itemId: outcome.itemId })], [queue]]) });
        return;
      }
      case "retry_scheduled":
        await enqueueReply(ctx, `Queue item #${outcome.itemId} was not published; retry is scheduled for ${new Date(outcome.retryAt).toISOString()}.`, { reply_markup: keyboard([[queue], [dashboard]]) });
        return;
      case "blocked":
        await enqueueReply(ctx, `Queue item #${outcome.itemId} remains blocked in status ${outcome.status}: ${outcome.reason}. Review the item before retrying.`, { reply_markup: keyboard([[queue], [dashboard]]) });
        return;
      case "failed":
        await enqueueReply(ctx, `Queue item #${outcome.itemId} failed in status ${outcome.status}: ${outcome.error}. Review the item and choose a safe next action.`, { reply_markup: keyboard([[queue], [dashboard]]) });
        return;
      case "deleted_external":
        await enqueueReply(ctx, `Queue source for item #${outcome.itemId} was already missing; the item was removed without publishing.`, { reply_markup: keyboard([[queue], [dashboard]]) });
        return;
      case "empty":
        await enqueueReply(ctx, "No prepared queue item is currently ready to publish.", { reply_markup: keyboard([[queue], [dashboard]]) });
        return;
    }
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
    await enqueueReply(ctx, lines.join("\n"), { reply_markup: keyboard(rows) }, "view", `admin:${deps.config.adminUserId}:view:safety`);
  };

  const sendSchedule = async (ctx: Context, notice?: string): Promise<void> => {
    const slots = deps.schedule.slots();
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[await button(deps, "Add UTC slot", "slot_add"), await button(deps, deps.schedule.enabled() ? "Pause" : "Resume", deps.schedule.enabled() ? "schedule_pause" : "schedule_resume")]];
    for (const slot of slots) rows.push([await button(deps, `Remove ${formatUtcSlot(slot)}`, "slot_remove", { minuteOfDay: slot })]);
    rows.push([await button(deps, "Back", "dashboard")]);
    const lines = [`Schedule is ${deps.schedule.enabled() ? "running" : "paused"}. Slots: ${slots.map(formatUtcSlot).join(", ") || "none"}`];
    if (notice !== undefined) lines.unshift(notice);
    await enqueueReply(ctx, lines.join("\n"), { reply_markup: keyboard(rows) }, "view", `admin:${deps.config.adminUserId}:view:schedule`);
  };

  const sendWhitelist = async (ctx: Context): Promise<void> => {
    const channels = deps.policy.listChannels();
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[await button(deps, "Add channel", "whitelist_add")]];
    for (const channel of channels) rows.push([await button(deps, `Remove ${cleanDisplay(channel.title || channel.username || String(channel.chatId))}`, "whitelist_remove", { chatId: channel.chatId })]);
    rows.push([await button(deps, "Back", "dashboard")]);
    const text = ["Whitelisted source channels", ...channels.map((channel) => `${channel.chatId} · ${cleanDisplay(channel.title)} ${channel.username ? `@${cleanDisplay(channel.username)}` : ""}`)].join("\n");
    await enqueueReply(ctx, text, { reply_markup: keyboard(rows) }, "view", `admin:${deps.config.adminUserId}:view:whitelist`);
  };

  const sendAuthors = async (ctx: Context, notice?: string, offset = 0): Promise<void> => {
    const authors = deps.policy.listAuthors();
    const page = authors.slice(offset, offset + 20);
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[await button(deps, "Set alias", "alias_add"), await button(deps, "Hidden sender names", "hidden_authors", { offset: 0 })]];
    for (const author of page.filter((entry) => entry.alias)) rows.push([await button(deps, `Remove alias ${author.userId}`, "alias_remove", { userId: author.userId })]);
    if (offset > 0 || offset + 20 < authors.length) rows.push([
      ...(offset > 0 ? [await button(deps, "Previous", "authors_page", { offset: Math.max(0, offset - 20) })] : []),
      ...(offset + 20 < authors.length ? [await button(deps, "Next", "authors_page", { offset: offset + 20 })] : []),
    ]);
    rows.push([await button(deps, "Back", "dashboard")]);
    const lines = [`Observed user authors (${authors.length === 0 ? 0 : offset + 1}–${Math.min(offset + 20, authors.length)} of ${authors.length})`, ...page.map((author) => `${author.userId} · ${cleanDisplay(author.displayName)}${author.username ? ` @${cleanDisplay(author.username)}` : ""}${author.alias ? ` → ${cleanDisplay(author.alias)}` : ""}`)];
    if (notice !== undefined) lines.unshift(notice);
    await enqueueReply(ctx, lines.join("\n"), { reply_markup: keyboard(rows) }, "view", `admin:${deps.config.adminUserId}:view:authors`);
  };

  const sendHiddenAuthors = async (ctx: Context, offset = 0, notice?: string): Promise<void> => {
    const authors = deps.policy.listHiddenAuthors(20, offset);
    const count = deps.policy.countHiddenAuthors();
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [];
    for (const author of authors) rows.push([await button(deps, `${safeDisplayName(author.senderName)}${author.alias ? ` → ${cleanDisplay(author.alias)}` : ""}`, "hidden_author_select", { hiddenAuthorId: author.hiddenAuthorId })]);
    if (offset > 0 || offset + authors.length < count) rows.push([
      ...(offset > 0 ? [await button(deps, "Previous", "hidden_authors", { offset: Math.max(0, offset - 20) })] : []),
      ...(offset + authors.length < count ? [await button(deps, "Next", "hidden_authors", { offset: offset + 20 })] : []),
    ]);
    rows.push([await button(deps, "Back to users", "authors"), await button(deps, "Dashboard", "dashboard")]);
    const lines = [`Hidden sender names (${count === 0 ? 0 : offset + 1}–${Math.min(offset + authors.length, count)} of ${count})`, ...authors.map((author) => `${safeDisplayName(author.senderName)}${author.alias ? ` → ${cleanDisplay(author.alias)}` : ""}`)];
    if (notice !== undefined) lines.unshift(notice);
    await enqueueReply(ctx, lines.join("\n"), { reply_markup: keyboard(rows) }, "view", `admin:${deps.config.adminUserId}:view:hidden-authors`);
  };

  const sendHiddenAuthor = async (ctx: Context, hiddenAuthorId: number, notice?: string): Promise<void> => {
    const author = deps.policy.getHiddenAuthor(hiddenAuthorId);
    if (!author) { await sendHiddenAuthors(ctx, 0, "That hidden sender is no longer available."); return; }
    const rows: Array<Awaited<ReturnType<typeof button>>[]> = [[await button(deps, "Set or replace nickname", "hidden_alias_set", { hiddenAuthorId })]];
    if (author.alias) rows.push([await button(deps, "Remove nickname", "hidden_alias_remove", { hiddenAuthorId })]);
    rows.push([await button(deps, "Back", "hidden_authors", { offset: 0 })]);
    const lines = [safeDisplayName(author.senderName), "A nickname is shared by queue posts with this exact hidden sender name.", `Current nickname: ${author.alias ? cleanDisplay(author.alias) : "none"}`];
    if (notice !== undefined) lines.unshift(notice);
    await enqueueReply(ctx, lines.join("\n"), { reply_markup: keyboard(rows) }, "view", `admin:${deps.config.adminUserId}:view:hidden-author`);
  };

  const sendHealth = async (ctx: Context): Promise<void> => {
    const health = deps.health.snapshot();
    const oldest = health.oldestPhysicalAgeMs === undefined ? "none" : formatAge(health.oldestPhysicalAgeMs);
    const pending = Object.entries(health.pendingUpdates).map(([state, count]) => `${state}=${count}`).join(", ") || "none";
    const rights = health.rights ? `queue post/delete=${health.rights.queue.canPostMessages}/${health.rights.queue.canDeleteMessages} · target post/edit/delete=${health.rights.target.canPostMessages}/${health.rights.target.canEditMessages}/${health.rights.target.canDeleteMessages}` : "unknown";
    const responseCounts = health.adminResponses;
    const responseLine = responseCounts ? `Admin replies: ${responseCounts.pending} pending · ${responseCounts.sending} sending · ${responseCounts.uncertain} uncertain · ${responseCounts.failed} failed` : undefined;
    const updateCounts = health.adminUpdates;
    const updateLine = updateCounts ? `Admin actions: ${updateCounts.active} active · ${updateCounts.uncertain} uncertain` : undefined;
    const incident = health.floodIncident;
    const incidentLine = incident ? `Flood wait: ${incident.state} · latest wait until ${new Date(incident.cooldownUntil).toISOString()} · stable check ${new Date(incident.quietUntil).toISOString()} · opening warning ${incident.warningDeliveredAt === undefined ? "not delivered" : "delivered"} · recovery ${incident.recoveryDeliveredAt === undefined ? "not delivered" : "delivered"}` : "Flood wait: no open incident";
    const retry = health.scheduledRetry;
    const retryLine = retry ? `Scheduled retry: ${new Date(retry.occurrenceAt).toISOString()} · ${retry.attemptCount} attempts · next ${retry.retryNotBefore === undefined ? "ready" : new Date(retry.retryNotBefore).toISOString()} · deadline ${retry.deadlineAt === undefined ? "unknown" : new Date(retry.deadlineAt).toISOString()}` : "Scheduled retry: none pending";
    const protection = health.editorialProtection;
    const protectionLine = protection ? `Frozen posts: ${protection.adminEdit} admin-edited · ${protection.legacyEditEvidence + protection.legacyUnverified} legacy-protected · ${protection.editCollisions} collisions needing review` : undefined;
    await enqueueReply(ctx, ["Health", `Database: ${health.databaseOk ? "available" : "failed"}`, `Boot: ${health.bootId ?? "unknown"} · lease ${health.leaseOwned ? "owned" : "lost"}`, `Queue head: ${health.queueHead ?? "empty"} · oldest physical source age: ${oldest}`, `Scheduling: ${deps.schedule.enabled() ? "enabled" : "paused"}`, `Operations: ${health.activeOperations} active · ${health.uncertainOperations} uncertain`, `Pending updates: ${pending}`, updateLine, `Orphans: ${health.orphanCounts.unresolved} unresolved · ${health.orphanCounts.terminal} manual`, `Renewal capacity: ${health.renewalCapacity.safe ? "safe" : "unsafe"}`, `Shared Telegram pause: ${health.sharedCooldown?.remainingMs ? `until ${new Date(health.sharedCooldown.notBefore).toISOString()}` : "inactive"}`, incidentLine, retryLine, responseLine, protectionLine, `Telegram rights: ${rights}`, `Last update: ${health.lastSuccessfulUpdateAt ? new Date(health.lastSuccessfulUpdateAt).toISOString() : "unknown"}`, `Last rights check: ${health.lastRightsCheckAt ? new Date(health.lastRightsCheckAt).toISOString() : "unknown"}`, `Last backup: ${health.lastBackupAt ? new Date(health.lastBackupAt).toISOString() : "unknown"}`, `Active alerts: ${health.alerts.active}`].filter((line): line is string => line !== undefined).join("\n"), { reply_markup: keyboard([[await button(deps, "Back", "dashboard")]]) }, "view", `admin:${deps.config.adminUserId}:view:health`);
  };

  const handlePrompt = async (ctx: Context, text: string): Promise<boolean> => {
    const prompt = deps.admin.getPrompt(deps.config.adminUserId, deps.now());
    if (!prompt) return false;
    if (prompt.deliveryState === "pending") {
      await enqueueReply(ctx, "The prompt is still waiting for Telegram delivery. Reply after it appears, or use /cancel.");
      return true;
    }
    if (prompt.expectedReplyToMessageId === undefined || ctx.message?.reply_to_message?.message_id !== prompt.expectedReplyToMessageId) {
      await enqueueReply(ctx, "Reply to the active admin prompt to continue, or use /cancel.");
      return true;
    }
    if (prompt.kind === "slot_add") {
      try {
        const slot = parseUtcSlot(text);
        deps.schedule.addSlot(slot, deps.config.adminUserId, deps.now());
        clearPrompt();
        await sendSchedule(ctx, `Added ${formatUtcSlot(slot)}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid UTC slot. Use HH:MM.";
        await beginPrompt(ctx, {
          kind: "slot_add",
          state: prompt.state,
          text: `${message}\nReply with the daily UTC slot as HH:MM.`,
          placeholder: "HH:MM UTC",
        });
      }
      return true;
    }
    if (prompt.kind === "whitelist_add") {
      if (!/^(?:@[A-Za-z0-9_]{5,32}|-?\d+)$/.test(text.trim())) {
        await enqueueReply(ctx, "Enter an exact public @handle or numeric channel ID.");
        return true;
      }
      deferPromptAction(ctx, "whitelist_lookup", { reference: text.trim() });
      return true;
    }
    if (prompt.kind === "alias_add") {
      const match = /^(-?\d+|@[A-Za-z0-9_]{5,32})\s+(.+)$/.exec(text.trim());
      if (!match) {
        await enqueueReply(ctx, "Use `<user id or @observed_username> <alias>`.");
        return true;
      }
      try {
        const key = /^-?\d+$/.test(match[1]!) ? Number(match[1]) : match[1]!;
        deps.policy.setAlias(key, validateAlias(match[2]!), deps.config.adminUserId, deps.now());
        clearPrompt();
        await sendAuthors(ctx, "Author alias saved.");
      } catch (error) {
        await enqueueReply(ctx, error instanceof Error ? error.message : "Could not save alias. Observe the user in a queue post first.");
      }
      return true;
    }
    if (prompt.kind === "hidden_alias") {
      const state = prompt.state && typeof prompt.state === "object" ? prompt.state as Record<string, unknown> : {};
      const hiddenAuthorId = typeof state.hiddenAuthorId === "number" ? state.hiddenAuthorId : undefined;
      if (hiddenAuthorId === undefined) { clearPrompt(); await enqueueReply(ctx, "The selected hidden sender has expired."); return true; }
      try {
        deps.policy.setHiddenAlias(hiddenAuthorId, validateAlias(text), deps.config.adminUserId, deps.now());
        clearPrompt();
        await sendHiddenAuthor(ctx, hiddenAuthorId, "Hidden sender nickname saved.");
      } catch (error) {
        await enqueueReply(ctx, error instanceof Error ? error.message : "Could not save nickname.");
      }
      return true;
    }
    if (prompt.kind === "recover") {
      deferPromptAction(ctx, "recover", { reference: text });
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
        clearPrompt();
        await enqueueReply(ctx, "This renewal resolution is stale; reopen the queue.");
        return true;
      }
      try {
        if (prompt.kind === "renewal_adopt" || prompt.kind === "uncertain_publish_adopt") {
          if (expectedCount === undefined) throw new Error(prompt.kind === "renewal_adopt" ? "This renewal has no captured replacement count; use manual cleanup." : "This publication has no captured output count; use another resolution.");
          const ids = parseMessageIds(text.trim(), expectedCount);
          if (prompt.kind === "renewal_adopt") deps.queue.adoptUncertainRenewalGeneration({ operationId, itemId, capturedContentVersion: item.contentVersion, capturedSourceGeneration: sourceGeneration }, ids, deps.now());
          else deps.queue.adoptConfirmedPublicationOutputs(itemId, operationId, item.contentVersion, sourceGeneration, deps.config.targetChannelId, ids, deps.now());
          clearPrompt();
          await enqueueReply(ctx, prompt.kind === "renewal_adopt" ? `Adopted replacement generation ${sourceGeneration + 1} for queue item #${itemId}; old-source cleanup remains durable and retryable.` : `Adopted the exact destination IDs for queue item #${itemId}; source cleanup remains durable and retryable.`);
          await sendQueue(ctx);
      } else {
          const ids = parseMessageIds(text.trim());
          deferPromptAction(ctx, "renewal_manual_cleanup", { itemId, operationId, sourceGeneration, phase, chatId: Number(deps.config.queueChannelId), messageIds: ids.map(Number) });
        }
      } catch (error) {
        await enqueueReply(ctx, error instanceof Error ? error.message : "Could not apply that renewal resolution.");
      }
      return true;
    }
    return false;
  };

  const handleCallback = async (ctx: Context): Promise<unknown> => {
    if (!isAuthorized(ctx, deps.config.adminUserId)) return reject(ctx);
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith("v1:")) return enqueueReply(ctx, "Stale action.");
    const token = data.slice(3);
    const resolved = deps.admin.consumeCallbackToken(deps.config.adminUserId, token, deps.now());
    if (!resolved) return enqueueReply(ctx, "This action expired. Open the dashboard again.");
    await deleteCallbackMenu(ctx, resolved.action);
    const payload = (resolved.payload && typeof resolved.payload === "object" ? resolved.payload : {}) as Record<string, unknown>;
    const itemId = typeof payload.itemId === "number" ? payload.itemId : undefined;
    if (itemId !== undefined && resolved.itemVersion !== undefined && deps.queue.findItemById(itemId)?.contentVersion !== resolved.itemVersion) return enqueueReply(ctx, "This queue item changed. Open the queue again.");
    switch (resolved.action) {
      case "dashboard": return sendDashboard(ctx);
      case "queue": return sendQueue(ctx, typeof payload.offset === "number" ? payload.offset : 0);
      case "queue_item": {
        if (itemId === undefined) return sendQueue(ctx);
        const active = deps.queue.listActive(10_000);
        const index = active.findIndex((item) => item.id === itemId);
        return sendQueue(ctx, index < 0 ? 0 : Math.floor(index / 10) * 10);
      }
      case "schedule": return sendSchedule(ctx);
      case "whitelist": return sendWhitelist(ctx);
      case "authors": return sendAuthors(ctx);
      case "authors_page": return sendAuthors(ctx, undefined, typeof payload.offset === "number" ? Math.max(0, payload.offset) : 0);
      case "hidden_authors": return sendHiddenAuthors(ctx, typeof payload.offset === "number" ? Math.max(0, payload.offset) : 0);
      case "hidden_author_select": return typeof payload.hiddenAuthorId === "number" ? sendHiddenAuthor(ctx, payload.hiddenAuthorId) : enqueueReply(ctx, "Invalid hidden sender selection.");
      case "hidden_alias_set": {
        if (typeof payload.hiddenAuthorId !== "number" || !deps.policy.getHiddenAuthor(payload.hiddenAuthorId)) return enqueueReply(ctx, "This hidden sender is no longer available.");
        return beginPrompt(ctx, { kind: "hidden_alias", state: { hiddenAuthorId: payload.hiddenAuthorId }, text: "Reply with the nickname for this exact hidden sender name.", placeholder: "Nickname" });
      }
      case "hidden_alias_remove": {
        if (typeof payload.hiddenAuthorId !== "number") return enqueueReply(ctx, "Invalid hidden sender.");
        deps.policy.removeHiddenAlias(payload.hiddenAuthorId, deps.config.adminUserId, deps.now());
        return sendHiddenAuthor(ctx, payload.hiddenAuthorId, "Hidden sender nickname removed.");
      }
      case "health": return sendHealth(ctx);
      case "recovery_apply_preparation": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid recovered item.");
        const item = deps.queue.findItemById(itemId);
        if (!item) return enqueueReply(ctx, "This recovered item no longer exists.");
        const deliveryMode = item.origin.kind === "channel" && deps.policy.isChannelWhitelisted(item.origin.chatId) ? "forward" : "copy";
        try {
          deps.queue.reprocessRecoveredItem(itemId, deliveryMode, deps.now(), deps.now());
          deps.admin.audit("recovery_preparation_requested", String(deps.config.adminUserId), deps.now(), itemId, undefined, { deliveryMode });
          await enqueueReply(ctx, `Preparation rules were requested for queue item #${itemId}. It will remain unscheduled until preparation finishes.`);
          return sendQueue(ctx);
        } catch (error) {
          return enqueueReply(ctx, error instanceof Error ? error.message : "Could not schedule preparation for this recovered item.");
        }
      }
      case "safety": return sendSafety(ctx, typeof payload.offset === "number" ? payload.offset : 0);
      case "preparation_uncertain": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid preparation resolution.");
        const response = await uncertainPreparationResponse(itemId);
        if (!response) return enqueueReply(ctx, "This preparation is no longer awaiting resolution.");
        return enqueueReply(ctx, response.text, { reply_markup: response.replyMarkup });
      }
      case "preparation_uncertain_retry":
      case "preparation_uncertain_discard": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid preparation resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.preparation.operationEvidence(itemId).find((entry) => entry.operationId === payload.operationId);
        if (!item || item.preparationState !== "uncertain" || item.status !== "needs_review" || !evidence || evidence.state !== "uncertain" || evidence.phase !== payload.phase || evidence.outputs.length > 0) return enqueueReply(ctx, "This preparation resolution is stale or output evidence is incomplete.");
        try {
          deps.preparation.releaseForResolution(evidence.operationId, resolved.action === "preparation_uncertain_retry" ? "retry" : "discard", deps.now());
          deps.admin.audit(resolved.action, String(deps.config.adminUserId), deps.now(), itemId, evidence.operationId, { phase: evidence.phase, trackedOutputs: evidence.outputs.length });
          await enqueueReply(ctx, resolved.action === "preparation_uncertain_retry" ? `Preparation for queue item #${itemId} was requeued. It remains unscheduled until preparation finishes.` : `Preparation for queue item #${itemId} was discarded and left in review; the original source remains available.`);
          return sendQueue(ctx);
        } catch (error) {
          return enqueueReply(ctx, error instanceof Error ? error.message : "Could not apply the preparation resolution.");
        }
      }
      case "preparation_uncertain_cleanup_retry":
      case "preparation_uncertain_cleanup_discard": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid preparation resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.preparation.operationEvidence(itemId).find((entry) => entry.operationId === payload.operationId);
        if (!item || item.preparationState !== "uncertain" || item.status !== "needs_review" || !evidence || evidence.state !== "uncertain" || evidence.phase !== payload.phase || evidence.outputs.length === 0) return enqueueReply(ctx, "This preparation resolution is stale or output evidence is incomplete.");
        try {
          const outputs = evidence.outputs as Array<{ chat_id: number; telegram_message_id: number }>;
          if (outputs.some((output) => !Number.isSafeInteger(output.chat_id) || !Number.isSafeInteger(output.telegram_message_id) || output.telegram_message_id <= 0)) throw new Error("Tracked output evidence is malformed; no outputs were cleaned automatically.");
          const action = resolved.action === "preparation_uncertain_cleanup_retry" ? "retry_after_cleanup" : "discard_after_cleanup";
          clearPrompt();
          deferAction(ctx, "preparation_cleanup", {
            action,
            itemId,
            operationId: evidence.operationId,
            outputs: outputs.map((output) => ({ chatId: output.chat_id, messageId: output.telegram_message_id })),
          });
          return;
        } catch (error) {
          return enqueueReply(ctx, error instanceof Error ? error.message : "Tracked output cleanup failed; the item remains uncertain.");
        }
      }
      case "publish": {
        const candidate = deps.queue.peekNextReady(deps.now());
        if (!candidate) return enqueueReply(ctx, "No prepared queue item is currently ready to publish.", { reply_markup: keyboard([[await button(deps, "Queue", "queue")], [await button(deps, "Cancel", "dashboard")]]) });
        const confirm = await button(deps, "Confirm publish next", "publish_execute", { itemId: candidate.id, contentVersion: candidate.contentVersion, sourceGeneration: candidate.sourceGeneration }, candidate.contentVersion);
        return enqueueReply(ctx, `Publish next available item #${candidate.id} now? If an item fails definitively before producing output, this run may skip it and try a later ready item.`, { reply_markup: keyboard([[confirm], [await button(deps, "Cancel", "dashboard")]]) });
      }
      case "publish_execute": {
        const item = itemId === undefined ? undefined : deps.queue.findItemById(itemId);
        if (!item || typeof payload.contentVersion !== "number" || item.contentVersion !== payload.contentVersion || typeof payload.sourceGeneration !== "number" || item.sourceGeneration !== payload.sourceGeneration) return enqueueReply(ctx, "The ready candidate changed; reopen the dashboard.");
        const candidate = deps.queue.peekNextReady(deps.now());
        if (!candidate || candidate.id !== item.id || candidate.contentVersion !== item.contentVersion || candidate.sourceGeneration !== item.sourceGeneration) return enqueueReply(ctx, "The ready queue changed; reopen the dashboard.");
        deferAction(ctx, "manual_publish", { itemId: item.id, contentVersion: item.contentVersion, sourceGeneration: item.sourceGeneration });
        return;
      }
      case "slot_add": return beginPrompt(ctx, { kind: "slot_add", state: {}, text: "Reply with the daily UTC slot as HH:MM.", placeholder: "HH:MM UTC" });
      case "slot_remove": if (typeof payload.minuteOfDay === "number") deps.schedule.removeSlot(payload.minuteOfDay, deps.config.adminUserId, deps.now()); return sendSchedule(ctx);
      case "schedule_pause": deps.schedule.setEnabled(false, deps.config.adminUserId, deps.now()); return sendSchedule(ctx);
      case "schedule_resume": if (deps.schedule.slots().length === 0) return sendSchedule(ctx, "Add at least one UTC slot before resuming."); deps.schedule.setEnabled(true, deps.config.adminUserId, deps.now()); return sendSchedule(ctx);
      case "whitelist_add": return beginPrompt(ctx, { kind: "whitelist_add", state: {}, text: "Reply with an exact public @handle or numeric channel ID.", placeholder: "@channel or numeric ID" });
      case "whitelist_confirm": {
        if (typeof payload.chatId !== "number") return enqueueReply(ctx, "Invalid confirmation payload.");
        deps.policy.upsertChannel(payload.chatId, typeof payload.username === "string" ? payload.username : undefined, typeof payload.title === "string" ? payload.title : undefined, deps.config.adminUserId, deps.now());
        return sendWhitelist(ctx);
      }
      case "whitelist_remove": {
        if (typeof payload.chatId !== "number") return enqueueReply(ctx, "Invalid channel.");
        return enqueueReply(ctx, "Remove this numeric channel from the whitelist?", { reply_markup: keyboard([[await button(deps, "Confirm removal", "whitelist_remove_execute", { chatId: payload.chatId })], [await button(deps, "Cancel", "whitelist")]]) });
      }
      case "whitelist_remove_execute": if (typeof payload.chatId === "number") deps.policy.removeChannel(payload.chatId, deps.config.adminUserId, deps.now()); return sendWhitelist(ctx);
      case "alias_add": return beginPrompt(ctx, { kind: "alias_add", state: {}, text: "Reply with a user ID or @observed_username followed by the alias.", placeholder: "user and alias" });
      case "alias_remove": if (typeof payload.userId === "number") deps.policy.removeAlias(payload.userId, deps.config.adminUserId, deps.now()); return sendAuthors(ctx);
      case "queue_retry": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item || !["blocked", "needs_edit", "needs_review", "delete_blocked"].includes(item.status) || item.maintenanceStatus !== "idle") return enqueueReply(ctx, "Uncertain and active-maintenance items require their state-specific resolution flow.");
        return enqueueReply(ctx, `Retry queue item #${itemId} from ${item.status}?`, { reply_markup: keyboard([[await button(deps, "Confirm retry", "queue_retry_execute", { itemId }, item.contentVersion)], [await button(deps, "Cancel", "queue")]]) });
      }
      case "queue_retry_execute": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item || !["blocked", "needs_edit", "needs_review", "delete_blocked"].includes(item.status) || item.maintenanceStatus !== "idle") return enqueueReply(ctx, "This queue item changed; reopen the queue.");
        deps.queue.retryItem(itemId, deps.now());
        deps.admin.audit("queue_retry", String(deps.config.adminUserId), deps.now(), itemId, undefined, { previousStatus: item.status });
        return sendQueue(ctx);
      }
      case "queue_move_end": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item) return enqueueReply(ctx, "Queue item no longer exists.");
        const confirm = await button(deps, "Confirm move to end", "queue_move_execute", { itemId }, item.contentVersion);
        return enqueueReply(ctx, `Move queue item #${itemId} to the FIFO end?`, { reply_markup: keyboard([[confirm], [await button(deps, "Cancel", "queue")]]) });
      }
      case "queue_move_execute": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item || item.status === "done" || item.status === "deleted" || item.status === "deleted_external") return enqueueReply(ctx, "Queue item changed; reopen the queue.");
        deps.queue.moveToEnd(itemId, deps.now());
        deps.admin.audit("queue_moved_to_end", String(deps.config.adminUserId), deps.now(), itemId, undefined, { contentVersion: item.contentVersion });
        return sendQueue(ctx);
      }
      case "queue_uncertain": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid queue item.");
        const response = await uncertainPublicationResponse(itemId);
        if (!response) return enqueueReply(ctx, "This publication is no longer awaiting uncertainty resolution.");
        return enqueueReply(ctx, response.text, { reply_markup: response.replyMarkup });
      }
      case "uncertain_publish_retry": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid uncertainty resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.status !== "uncertain_publish" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration) return enqueueReply(ctx, "This uncertainty resolution is stale.");
        deps.queue.requeueUncertainPublication(itemId, evidence.operationId, item.contentVersion, item.sourceGeneration, deps.now(), "admin_confirmed_nothing_published");
        deps.admin.audit("uncertain_publication_retry", String(deps.config.adminUserId), deps.now(), itemId, evidence.operationId, { duplicateRiskConfirmed: true });
        return sendQueue(ctx);
      }
      case "uncertain_publish_adopt_known": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid uncertainty resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.status !== "uncertain_publish" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration) return enqueueReply(ctx, "This uncertainty resolution is stale.");
        try {
          deps.queue.adoptConfirmedPublicationOutputs(itemId, evidence.operationId, item.contentVersion, item.sourceGeneration, deps.config.targetChannelId, evidence.knownDestinationIds, deps.now());
          deps.admin.audit("uncertain_publication_destination_adopted", String(deps.config.adminUserId), deps.now(), itemId, evidence.operationId, { destinationIds: evidence.knownDestinationIds });
          return sendQueue(ctx);
        } catch (error) {
          return enqueueReply(ctx, error instanceof Error ? error.message : "Could not adopt those destination IDs.");
        }
      }
      case "uncertain_publish_adopt_prompt":
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.expectedCount !== "number" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid uncertainty resolution.");
        return beginPrompt(ctx, {
          kind: "uncertain_publish_adopt",
          state: { itemId, operationId: payload.operationId, sourceGeneration: payload.sourceGeneration, expectedCount: payload.expectedCount, phase: payload.phase },
          text: `Reply with exactly ${payload.expectedCount} destination message IDs in Telegram order, separated by spaces or commas.`,
          placeholder: "message IDs",
        });
      case "uncertain_publish_delete_retry": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid uncertainty resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.status !== "uncertain_publish" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration || evidence.expectedOutputCount === undefined || evidence.expectedOutputCount !== evidence.knownDestinationIds.length || evidence.expectedOutputCount !== evidence.sourceIds.length) return enqueueReply(ctx, "This cleanup resolution is stale or output evidence is incomplete.");
        try {
          deferAction(ctx, "uncertain_publish_delete_retry", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase, chatId: Number(deps.config.targetChannelId), messageIds: evidence.knownDestinationIds.map(Number) });
          return;
        } catch (error) {
          return enqueueReply(ctx, error instanceof Error ? error.message : "Known output cleanup failed; the item remains uncertain.");
        }
      }
      case "renewal_uncertain": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid renewal item.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || item.maintenanceStatus !== "uncertain_renewal" || !evidence) return enqueueReply(ctx, "This renewal is no longer awaiting resolution.");
        const rows: Array<Awaited<ReturnType<typeof button>>[]> = [];
        if (evidence.expectedSourceCount !== undefined && evidence.knownReplacementIds.length === evidence.expectedSourceCount) rows.push([await button(deps, "Adopt known replacements", "renewal_adopt_known", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        if (evidence.expectedSourceCount !== undefined) rows.push([await button(deps, "Enter exact replacements", "renewal_adopt_prompt", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, expectedCount: evidence.expectedSourceCount, phase: evidence.phase }, item.contentVersion)]);
        if (evidence.knownReplacementIds.length === 0) rows.push([await button(deps, "Confirm no replacement exists", "renewal_no_replacement", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        else rows.push([await button(deps, "Delete known replacements", "renewal_delete_replacements", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        rows.push([await button(deps, "Enter manual cleanup IDs", "renewal_cleanup_prompt", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, item.contentVersion)]);
        rows.push([await button(deps, "Back", "queue")]);
        const replacementCount = evidence.expectedSourceCount === undefined ? `${evidence.knownReplacementIds.length} known` : `${evidence.knownReplacementIds.length} of ${evidence.expectedSourceCount}`;
        const details = [`Uncertain renewal #${itemId}`, `Operation: ${evidence.operationId}`, `Captured source IDs: ${evidence.sourceIds.join(", ") || "unknown"}`, `Known replacement IDs (${evidence.knownReplacementIds.length}): ${evidence.knownReplacementIds.join(", ") || "none"}`, `Known replacement count: ${replacementCount}`, `Expected replacement count: ${evidence.expectedSourceCount ?? "unknown"}`];
        if (evidence.errorCode === "partial_replacement") details.push("Resolution reason: partial_replacement. The incomplete set cannot be adopted as-is; originals remain current until a complete replacement is verified.");
        details.push("The logical publication status remains unchanged until a physical resolution is confirmed.");
        return enqueueReply(ctx, details.join("\n"), { reply_markup: keyboard(rows) });
      }
      case "renewal_adopt_known": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid renewal resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.maintenanceStatus !== "uncertain_renewal" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration || evidence.expectedSourceCount !== evidence.knownReplacementIds.length) return enqueueReply(ctx, "This renewal evidence is incomplete or stale; enter the exact replacement IDs instead.");
        try {
          deps.queue.adoptUncertainRenewalGeneration({ operationId: evidence.operationId, itemId, capturedContentVersion: item.contentVersion, capturedSourceGeneration: item.sourceGeneration }, evidence.knownReplacementIds, deps.now());
          return sendQueue(ctx);
        } catch (error) {
          return enqueueReply(ctx, error instanceof Error ? error.message : "Could not adopt those replacement IDs.");
        }
      }
      case "renewal_adopt_prompt":
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.expectedCount !== "number" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid renewal resolution.");
        return beginPrompt(ctx, {
          kind: "renewal_adopt",
          state: { itemId, operationId: payload.operationId, sourceGeneration: payload.sourceGeneration, expectedCount: payload.expectedCount, phase: payload.phase },
          text: `Reply with exactly ${payload.expectedCount} replacement message IDs in Telegram order, separated by spaces or commas.`,
          placeholder: "message IDs",
        });
      case "renewal_cleanup_prompt":
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid renewal resolution.");
        return beginPrompt(ctx, {
          kind: "renewal_manual_cleanup",
          state: { itemId, operationId: payload.operationId, sourceGeneration: payload.sourceGeneration, phase: payload.phase },
          text: "Reply with the exact replacement message IDs to delete or retry, in Telegram order. The item remains blocked until this explicit cleanup decision is recorded.",
          placeholder: "message IDs",
        });
      case "renewal_no_replacement": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid renewal resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.maintenanceStatus !== "uncertain_renewal" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration || evidence.knownReplacementIds.length > 0) return enqueueReply(ctx, "This renewal resolution is stale or replacements are known.");
        deps.queue.resolveUncertainRenewal(itemId, evidence.operationId, item.contentVersion, item.sourceGeneration, deps.now(), [], "no_replacement");
        return sendQueue(ctx);
      }
      case "renewal_delete_replacements": {
        if (itemId === undefined || typeof payload.operationId !== "string" || typeof payload.sourceGeneration !== "number" || typeof payload.phase !== "string") return enqueueReply(ctx, "Invalid renewal resolution.");
        const item = deps.queue.findItemById(itemId);
        const evidence = deps.queue.operationEvidence(itemId);
        if (!item || !evidence || item.maintenanceStatus !== "uncertain_renewal" || evidence.operationId !== payload.operationId || evidence.phase !== payload.phase || evidence.phase !== "uncertain" || evidence.capturedSourceGeneration !== payload.sourceGeneration) return enqueueReply(ctx, "This renewal resolution is stale.");
        try {
          deferAction(ctx, "renewal_delete_replacements", { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase, chatId: Number(deps.config.queueChannelId), messageIds: evidence.knownReplacementIds.map(Number) });
          return;
        } catch (error) {
          return enqueueReply(ctx, `Replacement cleanup failed (${classifyTelegramError(error).kind}); the item remains uncertain.`);
        }
      }
      case "queue_delete": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid queue item.");
        const confirm = await button(deps, `Confirm delete #${itemId}`, "queue_delete_confirm", { itemId }, resolved.itemVersion);
        return enqueueReply(ctx, "Delete this queue item from Telegram and SQLite?", { reply_markup: keyboard([[confirm], [await button(deps, "Cancel", "queue")]]) });
      }
      case "queue_delete_confirm": {
        if (itemId === undefined) return enqueueReply(ctx, "Invalid queue item.");
        const item = deps.queue.findItemById(itemId);
        if (!item) return enqueueReply(ctx, "Queue item no longer exists.");
        const sourceIds = deps.queue.currentSourceIds(itemId).map(Number);
        if (sourceIds.length === 0) return enqueueReply(ctx, "Queue item has no current source messages to delete.");
        deferAction(ctx, "queue_delete", { itemId, contentVersion: item.contentVersion, sourceGeneration: item.sourceGeneration, chatId: Number(item.queueChatId), sourceIds });
        return;
      }
      default: return enqueueReply(ctx, "Unknown or stale action.");
    }
  };

  const command = (name: string, handler: (ctx: Context) => Promise<void>): void => {
    bot.command(name, async (ctx) => {
      if (!isAuthorized(ctx, deps.config.adminUserId)) return reject(ctx);
      await handler(ctx);
    });
  };

  command("start", async (ctx) => {
    const replyMarkup = await dashboardKeyboard();
    deps.updates.transaction(() => {
      deferAction(ctx, "set_commands", {});
      enqueueReply(ctx, dashboardText(deps), { reply_markup: replyMarkup }, "view", `admin:${deps.config.adminUserId}:view:dashboard`);
    });
  });
  command("manage", sendDashboard);
  command("queue", sendQueue);
  command("schedule", sendSchedule);
  command("whitelist", sendWhitelist);
  command("authors", sendAuthors);
  command("health", sendHealth);
  command("recover", async (ctx) => {
    await beginPrompt(ctx, {
      kind: "recover",
      state: {},
      text: "Recover one queue-channel message or enter an ordered bundle of message IDs. Recovery keeps each selected message's shown forwarding mode and is ready to publish as shown. For a content bundle with one standalone text credit, append --credit-last. Telegram cannot enumerate missed history.",
      placeholder: "message IDs [--credit-last]",
    });
  });
  command("cancel", async (ctx) => { clearPrompt(); await enqueueReply(ctx, "Pending admin prompt cancelled."); });

  bot.callbackQuery(/.*/, handleCallback);
  bot.on("message:text", async (ctx) => {
    if (!isAuthorized(ctx, deps.config.adminUserId)) return reject(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
    await handlePrompt(ctx, text);
  });
};

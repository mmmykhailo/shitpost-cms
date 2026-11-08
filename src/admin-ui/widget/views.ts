import type { QueueItemRecord } from "../../domain/queue-item";
import { canReorder, isSourceBearing } from "../../domain/queue-item";
import { buildQueueMessageLink } from "../../domain/telegram-message-link";
import { formatUtcSlot } from "../../domain/schedule";
import { formatAge } from "../../domain/age";
import type { QueueRepository, ScheduleRepository, PolicyRepository } from "../../db/repositories";
import type { HealthService } from "../../services/health";
import type { AdminRepository } from "../../db/admin-repository";
import type { AdminUpdateRepository } from "../../db/admin-update-repository";
import type { AdminActionButton } from "../../services/admin-response-worker";
import type { DeskRoute, DeskAction, DeskScreen } from "./model";

export const deskHome = { name: "desk" } as const;
const queueHome = { name: "queue", offset: 0 } as const;
const more = { name: "more" } as const;
const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export const deskAction = (label: string, route: DeskRoute, style?: DeskAction["style"]): DeskAction =>
  ({ label, route, ...(style ? { style } : {}) });
export const adminRoute = (button: AdminActionButton): DeskRoute => ({ name: "admin", button });

type ViewDeps = {
  admin: AdminRepository;
  updates: AdminUpdateRepository;
  queue: QueueRepository;
  schedule: ScheduleRepository;
  policy: PolicyRepository;
  health: HealthService;
  adminId: number;
  queueChannelId: number;
  now(): number;
  nextAt(): number | undefined;
  button(label: string, action: string, payload?: unknown, version?: number): AdminActionButton;
};

const itemState = (item: QueueItemRecord, now: number, next?: number) => {
  if (item.id === next) return "Ready · Next";
  if (item.status === "uncertain_publish") return "Publish uncertain";
  if (item.preparationState === "uncertain") return "Preparation uncertain";
  if (item.maintenanceStatus === "uncertain_renewal") return "Renewal uncertain";
  if (item.status !== "queued") return item.status.replaceAll("_", " ");
  if (item.maintenanceStatus !== "idle") return item.maintenanceStatus.replaceAll("_", " ");
  if (item.retryNotBefore !== undefined && item.retryNotBefore > now) return "Waiting to retry";
  if (item.preparationState !== "ready") return "Preparing";
  return "Prepared";
};

export const createDeskViews = (deps: ViewDeps) => {
  const admin = (label: string, action: string, payload?: unknown, version?: number, style?: DeskAction["style"]) =>
    deskAction(label, adminRoute(deps.button(label, action, payload, version)), style);
  const review = (item: QueueItemRecord) => {
    const payload = { itemId: item.id };
    if (item.status === "uncertain_publish") return admin("Review publication", "queue_uncertain", payload, item.contentVersion, "primary");
    if (item.preparationState === "uncertain") return admin("Review preparation", "preparation_uncertain", payload, item.contentVersion, "primary");
    if (item.maintenanceStatus === "uncertain_renewal") return admin("Review renewal", "renewal_uncertain", payload, item.contentVersion, "primary");
    if (["blocked", "needs_edit", "needs_review", "delete_blocked"].includes(item.status) && item.maintenanceStatus === "idle") {
      return admin("Review retry", "queue_retry", payload, item.contentVersion, "primary");
    }
  };

  return (route: Exclude<DeskRoute, { name: "admin" }>): DeskScreen => {
    const now = deps.now();
    switch (route.name) {
      case "desk": {
        const next = deps.queue.peekNextReady(now);
        const run = deps.nextAt();
        const state = deps.schedule.slots().length === 0 ? "No UTC slots" : deps.schedule.enabled() ? "Running" : "Paused";
        const { count: waiting } = deps.queue.deskItems(false, 5, 0);
        const { count: attention } = deps.queue.deskItems(true, 5, 0);
        return {
          title: "Shitpost Desk", hero: next ? `#${next.id} · ${next.contentType}` : "No post ready",
          body: `${state}\n${run === undefined ? "No scheduled run" : when(run)}`,
          actions: [
            ...(next ? [admin("Review next publish", "publish", {}, undefined, "primary")] : []),
            deskAction(`${waiting} in queue`, queueHome),
            deskAction(`${attention} items need attention`, { name: "attention", offset: 0 }),
            deskAction("Schedule", { name: "schedule", offset: 0 }),
            deskAction("More", more),
          ],
          refresh: route,
        };
      }
      case "queue":
      case "attention": {
        const attention = route.name === "attention";
        const next = deps.queue.peekNextReady(now)?.id;
        const { items, count, offset } = deps.queue.deskItems(attention, 4, route.offset);
        const actions = items.map((item, i) => deskAction(
          `${attention ? "" : `${offset + i + 1} · `}#${item.id} · ${item.contentType} · ${itemState(item, now, next)} · ${formatAge(Math.max(0, now - item.enqueuedAt))}`,
          { name: "item", itemId: item.id, offset, attention }, "row"));
        if (offset > 0) actions.push(deskAction("‹ Previous", { ...route, offset: offset - 4 }));
        if (offset + items.length < count) actions.push(deskAction("Next ›", { ...route, offset: offset + 4 }));
        if (attention) actions.push(deskAction("System issues", { name: "system" }));
        return {
          title: attention ? "Needs attention" : "Queue",
          body: count ? `${offset + 1}–${offset + items.length} of ${count}${!attention && next ? ` · Up next #${next}` : ""}`
            : attention ? "No queue items need attention." : "The queue is empty.",
          actions, back: deskHome, refresh: { ...route, offset },
        };
      }
      case "item":
      case "item_actions": {
        const item = deps.queue.findItemById(route.itemId);
        const list = { name: route.attention ? "attention" : "queue", offset: route.offset } as const;
        if (!item || !isSourceBearing(item.status)) {
          return { title: "Item unavailable", body: `#${route.itemId} is no longer in the queue.`, actions: [], back: list };
        }
        const actions: DeskAction[] = [];
        const payload = { itemId: item.id };
        const source = deps.queue.currentSourceIds(item.id)[0];
        const link = source === undefined ? undefined : buildQueueMessageLink(deps.queueChannelId, source);
        const next = deps.queue.peekNextReady(now)?.id;
        const retryAt = item.retryNotBefore ?? item.maintenanceRetryNotBefore;
        const reason = item.lastErrorCode?.replaceAll("_", " ");
        const detail = `${itemState(item, now, next)} · Position ${deps.queue.deskPosition(item.logicalSequence)}\nQueued ${formatAge(Math.max(0, now - item.enqueuedAt))} ago`;
        const canDelete = item.maintenanceStatus === "idle" && item.claimedOperationId === undefined &&
          item.preparationOperationId === undefined && item.status !== "published_cleanup_pending" && item.status !== "uncertain_publish";
        const actionable = canReorder(item) || canDelete;
        if (route.name === "item_actions") {
          if (canReorder(item)) actions.push(admin("Move first", "queue_move_first", payload), admin("Move last", "queue_move_end", payload));
          if (canDelete) actions.push(admin("Review delete", "queue_delete", payload));
        } else {
          const issue = review(item);
          if (issue) actions.push(issue);
          if (item.id === next) actions.push(admin("Review next publish", "publish", {}, undefined, "primary"));
          if (actionable) actions.push(deskAction("Actions", { ...route, name: "item_actions" }));
        }
        return {
          title: `#${item.id} · ${item.contentType}`,
          body: [detail, reason, retryAt !== undefined && retryAt > now ? `Retry after ${when(retryAt)}` : undefined].filter(Boolean).join("\n"),
          ...(link ? { link } : {}), actions, refresh: route,
          back: route.name === "item_actions" ? { ...route, name: "item" } : list,
        };
      }
      case "schedule": {
        const slots = deps.schedule.slots();
        const offset = Math.min(route.offset, Math.max(0, Math.floor((slots.length - 1) / 3) * 3));
        const run = deps.nextAt();
        const enabled = deps.schedule.enabled();
        const actions = slots.slice(offset, offset + 3).map((slot) =>
          admin(formatUtcSlot(slot) + " UTC", "widget_slot_review", { minuteOfDay: slot }, undefined, "row"));
        actions.push(admin("Add UTC slot", "slot_add"));
        if (enabled || slots.length) actions.push(admin(enabled ? "Pause…" : "Resume…", "widget_schedule_review", { enabled }));
        if (offset > 0) actions.push(deskAction("‹ Earlier", { ...route, offset: offset - 3 }));
        if (offset + 3 < slots.length) actions.push(deskAction("Later ›", { ...route, offset: offset + 3 }));
        return { title: "Schedule", body: `${enabled ? "Running" : "Paused"} · ${slots.length} UTC slots\n${run === undefined ? "No scheduled run" : when(run)}`, actions, refresh: route, back: deskHome };
      }
      case "sources": {
        const channels = deps.policy.listChannels();
        const offset = Math.min(route.offset, Math.max(0, Math.floor((channels.length - 1) / 4) * 4));
        const actions = channels.slice(offset, offset + 4).map((channel) =>
          admin(channel.title || channel.username || String(channel.chatId), "whitelist_remove", { chatId: channel.chatId }, undefined, "row"));
        actions.push(admin("Add channel", "whitelist_add"));
        if (offset > 0) actions.push(deskAction("‹ Previous", { ...route, offset: offset - 4 }));
        if (offset + 4 < channels.length) actions.push(deskAction("Next ›", { ...route, offset: offset + 4 }));
        return { title: "Whitelisted sources", body: `${channels.length} channels · Select a channel to review removal.`, actions, refresh: route, back: more };
      }
      case "system": {
        const health = deps.health.snapshot();
        return {
          title: "System issues",
          body: [`${health.pendingUpdates.quarantined_renewal_candidate ?? 0} quarantined · ${health.orphanCounts.terminal} manual cleanups`,
            health.sharedCooldown?.remainingMs ? `Telegram cooldown until ${when(health.sharedCooldown.notBefore)}` : "No Telegram cooldown",
            `${health.alerts.active} active alerts`].join("\n"),
          actions: [admin("Review quarantine and cleanup", "safety"), admin("Health", "widget_health")],
          refresh: route, back: { name: "attention", offset: 0 },
        };
      }
      case "authors":
        return {
          title: "Author names", back: more, refresh: route,
          actions: [
            admin("Telegram accounts", "authors", {}, undefined, "row"),
            admin("Hidden sender names", "hidden_authors", {}, undefined, "row"),
            admin("Queue signatures", "signature_authors", {}, undefined, "row"),
          ],
        };
      case "more": {
        const prompt = deps.admin.getPrompt(deps.adminId, now);
        return { title: "More", back: deskHome, refresh: route,
          actions: [
            deskAction("Authors", { name: "authors" }, "row"),
            deskAction("Whitelisted sources", { name: "sources", offset: 0 }, "row"),
            admin("Health", "widget_health", {}, undefined, "row"),
            admin("Recent logs", "widget_logs", {}, undefined, "row"),
            admin(prompt ? "Resume prompt" : "Recover", prompt ? "widget_resume_prompt" : "widget_recover", {}, undefined, "row"),
          ],
        };
      }
      case "prompt": {
        const prompt = deps.admin.getPrompt(deps.adminId, now);
        const delivery = prompt?.deliveryOutboxId;
        return { title: "Reply in chat", back: more, refresh: route,
          body: !prompt ? "No prompt is waiting. Check the latest bot message." : prompt.deliveryState === "active" || !delivery
            ? "Reply to the bot’s prompt in this chat." : "The bot is sending a reply prompt. Check the chat or refresh.",
          actions: prompt ? [admin("Cancel prompt", "widget_cancel_prompt")] : [],
        };
      }
      case "result": {
        const receipt = deps.updates.find(route.updateId);
        const state = receipt?.state;
        const result = receipt?.result as { text?: string } | undefined;
        return {
          title: state === "queued" || state === "running" ? "Request accepted" : "Operation result",
          body: result?.text ?? (state === "queued" || state === "running" ? "Waiting for the bot to record the outcome."
            : "Check the bot’s message and the queue for the recorded result."),
          actions: [deskAction("Queue", queueHome), deskAction("Needs attention", { name: "attention", offset: 0 })],
          refresh: route, back: deskHome,
        };
      }
    }
  };
};

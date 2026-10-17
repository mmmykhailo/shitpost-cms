import { asChatId, asMessageId } from "../types";
import type { AdminRepository } from "../db/admin-repository";
import type { AdminResponseRepository } from "../db/admin-response-repository";
import type { AdminUpdateRepository } from "../db/admin-update-repository";
import type { QueueRepository } from "../db/repositories";
import type { PreparationRepository } from "../db/preparation-repository";
import type { Logger } from "../logger";
import type { TelegramGateway } from "../telegram";
import type { SchedulerService } from "./scheduler";
import type { RecoveryService } from "./recovery";
import type { OperationTracker } from "./task-supervisor";
import type { Clock, UserId } from "../types";
import { classifyTelegramError, TelegramLocalDeferralError } from "../errors";
import { withTelegramMutationScope } from "../telegram-request-context";
import { abortableSleep } from "./task-supervisor";
import type { AdminReplyMarkupIntent } from "./admin-response-worker";

type ActionResult = { text?: string; replyMarkup?: AdminReplyMarkupIntent; state?: "applied" | "rejected" | "uncertain"; noResponse?: boolean; reconciliationAttempted?: boolean };
type ClaimedAction = NonNullable<ReturnType<AdminUpdateRepository["claimNext"]>> & { reconcileOnly?: boolean };

const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const numbers = (value: unknown): number[] | undefined => Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0) ? value as number[] : undefined;

export const createAdminActionWorker = (input: {
  updates: AdminUpdateRepository;
  responses: AdminResponseRepository;
  admin: AdminRepository;
  queue: QueueRepository;
  preparation: PreparationRepository;
  gateway: TelegramGateway;
  scheduler: SchedulerService;
  recovery: RecoveryService;
  adminChatId: number;
  adminUserId: UserId;
  queueChatId: number;
  targetChatId: number;
  bootId: string;
  clock: Clock;
  logger: Logger;
  operationTracker?: OperationTracker;
  incidents?: { snapshot(): { id: string } | undefined; setActionRequired(id: string, required: boolean): boolean };
  setCommands?: () => Promise<unknown>;
}) => {
  const button = (text: string, action: string, payload: unknown = {}): AdminReplyMarkupIntent => ({ kind: "inline_keyboard", rows: [[{ text, action, payload }]] });

  const uncertainPublicationResult = (itemId: number): ActionResult => {
    const item = input.queue.findItemById(itemId);
    const evidence = input.queue.operationEvidence(itemId);
    if (!item || item.status !== "uncertain_publish" || !evidence) return { state: "uncertain", text: `Publication for queue item #${itemId} may already exist. Automatic retry is stopped; open Queue to review the saved operation evidence.`, replyMarkup: button("Open queue", "queue") };
    const rows: AdminReplyMarkupIntent & { kind: "inline_keyboard" } = {
      kind: "inline_keyboard",
      rows: [[{ text: "I confirm nothing was published — retry", action: "uncertain_publish_retry", payload: { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, itemVersion: item.contentVersion }]],
    };
    if (evidence.expectedOutputCount === evidence.knownDestinationIds.length && evidence.expectedOutputCount > 0) rows.rows.push([{ text: "Destination is complete", action: "uncertain_publish_adopt_known", payload: { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, itemVersion: item.contentVersion }]);
    if (evidence.expectedOutputCount !== undefined) rows.rows.push([{ text: "Enter exact destination IDs", action: "uncertain_publish_adopt_prompt", payload: { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, expectedCount: evidence.expectedOutputCount, phase: evidence.phase }, itemVersion: item.contentVersion }]);
    if (evidence.expectedOutputCount === evidence.knownDestinationIds.length && evidence.expectedOutputCount === evidence.sourceIds.length && evidence.expectedOutputCount > 0) rows.rows.push([{ text: "Delete known outputs and retry", action: "uncertain_publish_delete_retry", payload: { itemId, operationId: evidence.operationId, sourceGeneration: evidence.capturedSourceGeneration, phase: evidence.phase }, itemVersion: item.contentVersion }]);
    rows.rows.push([{ text: `Delete queue item #${itemId}`, action: "queue_delete", payload: { itemId }, itemVersion: item.contentVersion }], [{ text: "Back", action: "queue", payload: {} }]);
    return {
      state: "uncertain",
      text: [`Uncertain publication #${itemId}`, `Operation: ${evidence.operationId}`, `Phase: ${evidence.phase}`, `Captured source IDs: ${evidence.sourceIds.join(", ") || "unknown"}`, `Known destination IDs: ${evidence.knownDestinationIds.join(", ") || "none"}`, `Expected destination count: ${evidence.expectedOutputCount ?? "unknown"}`, "The destination may already contain this post. It will not be retried until you resolve it; other ready posts can use later slots.", "Choose an explicit resolution; retrying can duplicate a Telegram send."].join("\n"),
      replyMarkup: rows,
    };
  };

  const finish = (claim: ClaimedAction, result: ActionResult): void => input.updates.transaction(() => {
    const state = result.state ?? "applied";
    if (!input.updates.finish(claim.updateId, state, { ...(result.text === undefined ? {} : { text: result.text }), operationId: input.updates.find(claim.updateId)?.operationId, ...(result.reconciliationAttempted ? { reconciliationAttempted: true } : {}) }, input.clock.now(), claim.claimToken)) return;
    if (result.noResponse || result.text === undefined) return;
    input.responses.enqueue({ updateId: claim.updateId, adminChatId: input.adminChatId, kind: "confirmation", descriptor: { version: 1, text: result.text, ...(result.replyMarkup === undefined ? {} : { replyMarkup: result.replyMarkup }) }, now: input.clock.now() });
  });

  const saveOperationId = (claim: ClaimedAction, operationId: string): void => {
    if (!input.updates.setOperationId(claim.updateId, claim.claimToken, operationId, input.clock.now())) throw new Error("Admin action lost its durable receipt claim");
  };

  const reconcileManualPublish = (claim: ClaimedAction): ActionResult => {
    const payload = object(claim.actionPayload);
    const itemId = payload.itemId;
    if (typeof itemId !== "number" || claim.operationId === undefined) return { state: "uncertain", reconciliationAttempted: true, text: "The publication attempt has no matching saved operation. It was not repeated; review Queue." };
    const item = input.queue.findItemById(itemId);
    const evidence = input.queue.operationEvidence(itemId);
    if (!item || evidence?.operationId !== claim.operationId) return { state: "uncertain", reconciliationAttempted: true, text: `Publication for queue item #${itemId} could not be matched to its saved operation. It was not repeated; review Queue.` };
    if (item.status === "done") return { reconciliationAttempted: true, text: `Queue item #${itemId} was published and source cleanup completed before restart.`, replyMarkup: button("Queue", "queue") };
    if (item.status === "published_cleanup_pending") return { reconciliationAttempted: true, text: `Queue item #${itemId} was published before restart. Source cleanup is pending and will be retried safely.`, replyMarkup: button("Queue", "queue") };
    if (item.status === "uncertain_publish") return { ...uncertainPublicationResult(itemId), reconciliationAttempted: true };
    if (item.status === "deleted_external") return { reconciliationAttempted: true, text: `Queue item #${itemId} was already missing from Telegram and was marked as externally deleted.`, replyMarkup: button("Queue", "queue") };
    if (item.retryNotBefore !== undefined) return { reconciliationAttempted: true, text: `Queue item #${itemId} was not published before restart. A safe retry is scheduled for ${new Date(item.retryNotBefore).toISOString()}.`, replyMarkup: button("Queue", "queue") };
    if (["blocked", "needs_edit", "needs_review", "delete_blocked"].includes(item.status)) return { reconciliationAttempted: true, text: `Queue item #${itemId} remains ${item.status.replaceAll("_", " ")}${item.lastErrorCode ? ` (${item.lastErrorCode})` : ""}. Open Queue to review it.`, replyMarkup: button("Queue", "queue") };
    return { state: "uncertain", reconciliationAttempted: true, text: `The saved publication operation for queue item #${itemId} is still unresolved. It was not repeated; review Queue and the operation evidence.`, replyMarkup: button("Queue", "queue") };
  };

  const deleteMessages = async (claim: ClaimedAction, chatId: number, messageIds: readonly number[], stepKey: string, beforeDispatch?: () => void): Promise<boolean> => {
    let requestStarted = input.gateway.dispatchManaged !== true;
    const operationId = input.updates.find(claim.updateId)?.operationId;
    const scope = {
      family: "cleanup" as const,
      priority: "admin" as const,
      stepKey,
      ...(operationId === undefined ? {} : { operationId }),
      beforeDispatch: () => { beforeDispatch?.(); requestStarted = true; },
    };
    try {
      await withTelegramMutationScope(scope, () => input.gateway.deleteMessages(asChatId(chatId), messageIds.map(asMessageId)));
    } catch (error) {
      const normalized = classifyTelegramError(error, "deleteMessages");
      if (normalized.kind === "source_missing") return true;
      const marked = error instanceof Error ? error : Object.assign(new Error(normalized.description), normalized);
      Object.defineProperty(marked, "adminActionRequestStarted", { value: requestStarted, configurable: true });
      throw marked;
    }
    return false;
  };

  const execute = async (claim: ClaimedAction): Promise<ActionResult> => {
    const payload = object(claim.actionPayload);
    switch (claim.actionKind) {
      case "set_commands": {
        if (!input.setCommands) return { state: "rejected", text: "The command list could not be configured in this runtime." };
        saveOperationId(claim, `admin-control:${claim.updateId}`);
        await withTelegramMutationScope({ family: "control", priority: "admin", operationId: `admin-action:${claim.updateId}` }, () => input.setCommands!());
        return { noResponse: true };
      }
      case "manual_publish": {
        const { itemId, contentVersion, sourceGeneration } = payload;
        if (![itemId, contentVersion, sourceGeneration].every((value) => typeof value === "number")) return { state: "rejected", text: "The saved publication request is invalid." };
        const outcome = await input.scheduler.manualPublish({ itemId: itemId as number, contentVersion: contentVersion as number, sourceGeneration: sourceGeneration as number }, { updateId: claim.updateId, claimToken: claim.claimToken });
        const item = "itemId" in outcome ? outcome.itemId : itemId as number;
        input.admin.audit("manual_publish", String(input.adminUserId), input.clock.now(), item, "operationId" in outcome ? outcome.operationId : input.updates.find(claim.updateId)?.operationId, { outcome: outcome.kind, requestedItemId: itemId, contentVersion, sourceGeneration });
        if (outcome.kind === "published") return { text: `Queue item #${item} was published and source cleanup completed.`, replyMarkup: button("Queue", "queue") };
        if (outcome.kind === "cleanup_pending") return { text: `Queue item #${item} was published. Source cleanup is pending and will be retried safely.`, replyMarkup: button("Queue", "queue") };
        if (outcome.kind === "uncertain") return uncertainPublicationResult(item);
        if (outcome.kind === "retry_scheduled") return { text: `Queue item #${item} was not published. A safe retry is scheduled for ${new Date(outcome.retryAt).toISOString()}.`, replyMarkup: button("Queue", "queue") };
        if (outcome.kind === "empty") return { text: "No prepared queue item is currently ready to publish.", replyMarkup: button("Queue", "queue") };
        if (outcome.kind === "blocked") return { text: `Queue item #${item} remains blocked: ${outcome.reason}. Open Queue to review it.`, replyMarkup: button("Queue", "queue") };
        if (outcome.kind === "deleted_external") return { text: `Queue item #${item} was already missing from Telegram and was marked as externally deleted.`, replyMarkup: button("Queue", "queue") };
        if (outcome.kind === "failed") return { text: `Queue item #${item} failed (${outcome.error}). Open Queue to review it.`, replyMarkup: button("Queue", "queue") };
        return { text: "The publication result could not be summarized. Open Queue to review the item.", replyMarkup: button("Queue", "queue") };
      }
      case "recover": {
        if (typeof payload.reference !== "string") return { state: "rejected", text: "The saved recovery request is invalid." };
        const operationId = `admin-recovery-${claim.updateId}`;
        saveOperationId(claim, operationId);
        const recovered = await input.recovery.recover(payload.reference, operationId);
        input.admin.audit(recovered.reused ? "recovery_existing_item_reused" : "recovery_completed", String(input.adminUserId), input.clock.now(), recovered.itemId, operationId, { sourceIds: recovered.sourceIds, creditLast: recovered.creditLast ?? false });
        if (recovered.reused) return { text: `Those messages already belong to queue item #${recovered.itemId}; I reused that item and did not create a duplicate.`, replyMarkup: button("Queue", "queue") };
        const replyMarkup = recovered.canApplyPreparationRules
          ? { kind: "inline_keyboard" as const, rows: [[{ text: "Apply preparation rules", action: "recovery_apply_preparation", payload: { itemId: recovered.itemId } }], [{ text: "Queue", action: "queue", payload: {} }]] }
          : button("Queue", "queue");
        const suffix = recovered.creditLast ? " The final message was recorded as a separate credit." : " It is ready to publish as shown; no author was inferred from its text.";
        return { text: `Recovered queue item #${recovered.itemId} from source IDs ${recovered.sourceIds.join(", ")}.${suffix}`, replyMarkup };
      }
      case "whitelist_lookup": {
        if (typeof payload.reference !== "string") return { state: "rejected", text: "The saved channel lookup is invalid." };
        const reference = payload.reference.trim();
        const chat = await input.gateway.getChat(reference.startsWith("@") ? reference : Number(reference) as never);
        if (chat.type !== "channel") return { state: "rejected", text: "The resolved chat is not a channel." };
        if (chat.id === input.queueChatId || chat.id === input.targetChatId) return { state: "rejected", text: "Queue and destination channels cannot be whitelisted." };
        return {
          text: `Confirm whitelist: ${chat.title} (${chat.id})${chat.username ? ` @${chat.username}` : ""}`,
          replyMarkup: button("Confirm", "whitelist_confirm", { chatId: chat.id, username: chat.username, title: chat.title }),
        };
      }
      case "queue_delete": {
        const itemId = payload.itemId;
        const generation = payload.sourceGeneration;
        const version = payload.contentVersion;
        const chatId = payload.chatId;
        const ids = numbers(payload.sourceIds);
        if (typeof itemId !== "number" || typeof generation !== "number" || typeof version !== "number" || typeof chatId !== "number" || !ids?.length) return { state: "rejected", text: "The saved deletion request is invalid." };
        const operationId = `admin-delete-${claim.updateId}`;
        saveOperationId(claim, operationId);
        const current = () => {
          const item = input.queue.findItemById(itemId);
          const currentIds = input.queue.currentSourceIds(itemId).map(Number);
          return item !== undefined && item.sourceGeneration === generation && item.contentVersion === version && item.queueChatId === chatId && JSON.stringify(currentIds) === JSON.stringify(ids);
        };
        if (!current()) return { state: "rejected", text: "The queue item changed before deletion. Reopen Queue and confirm the current item." };
        const sourceMissing = await deleteMessages(claim, chatId, ids, "confirmed-queue-delete", () => {
          if (!current()) throw new TelegramLocalDeferralError("protection_changed", input.clock.now(), "The queue item changed before deletion dispatch");
        });
        if (sourceMissing) {
          input.queue.markMissing(itemId, undefined, input.clock.now());
          input.admin.audit("queue_delete_source_missing", String(input.adminUserId), input.clock.now(), itemId, operationId, { sourceIds: ids, sourceGeneration: generation });
          return { text: `The Telegram source for queue item #${itemId} was already missing; the item was marked as externally deleted.`, replyMarkup: button("Queue", "queue") };
        }
        if (current()) input.queue.markAdminDeleted(itemId, input.clock.now());
        else return { state: "uncertain", text: `The captured queue messages were deleted, but item #${itemId} changed during the request. Review Queue before taking another action.`, replyMarkup: button("Queue", "queue") };
        input.admin.audit("queue_deleted", String(input.adminUserId), input.clock.now(), itemId, operationId, { sourceIds: ids, sourceGeneration: generation });
        return { text: `Queue item #${itemId} was deleted.`, replyMarkup: button("Queue", "queue") };
      }
      case "uncertain_publish_delete_retry": {
        const itemId = payload.itemId; const operationId = payload.operationId; const generation = payload.sourceGeneration; const phase = payload.phase;
        const ids = numbers(payload.messageIds); const chatId = payload.chatId;
        if (typeof itemId !== "number" || typeof operationId !== "string" || typeof generation !== "number" || typeof phase !== "string" || typeof chatId !== "number" || !ids) return { state: "rejected", text: "The publication cleanup request is invalid." };
        const item = input.queue.findItemById(itemId); const evidence = input.queue.operationEvidence(itemId);
        if (!item || !evidence || item.status !== "uncertain_publish" || item.sourceGeneration !== generation || evidence.operationId !== operationId || evidence.phase !== phase || phase !== "uncertain" || chatId !== input.targetChatId || JSON.stringify(evidence.knownDestinationIds.map(Number)) !== JSON.stringify(ids)) return { state: "rejected", text: "This publication resolution is stale." };
        saveOperationId(claim, `admin-action:${claim.updateId}`);
        await deleteMessages(claim, chatId, ids, "known-publication-output-cleanup");
        input.queue.requeueUncertainPublication(itemId, operationId, item.contentVersion, item.sourceGeneration, input.clock.now(), "admin_deleted_known_outputs");
        input.admin.audit("uncertain_publication_outputs_deleted_retry", String(input.adminUserId), input.clock.now(), itemId, operationId, { destinationIds: ids });
        return { text: `Known publication outputs for queue item #${itemId} were deleted and the item was requeued.`, replyMarkup: button("Queue", "queue") };
      }
      case "preparation_cleanup": {
        const itemId = payload.itemId; const operationId = payload.operationId; const action = payload.action; const outputs = payload.outputs;
        if (typeof itemId !== "number" || typeof operationId !== "string" || (action !== "retry_after_cleanup" && action !== "discard_after_cleanup") || !Array.isArray(outputs)) return { state: "rejected", text: "The preparation cleanup request is invalid." };
        const evidence = input.preparation.operationEvidence(itemId).find((entry) => entry.operationId === operationId);
        const expectedOutputs = evidence?.outputs.map((entry) => {
          const row = object(entry);
          return { chatId: Number(row.chat_id), messageId: Number(row.telegram_message_id) };
        });
        if (!evidence || evidence.state !== "uncertain" || JSON.stringify(expectedOutputs) !== JSON.stringify(outputs)) return { state: "rejected", text: "This preparation cleanup is stale." };
        saveOperationId(claim, `admin-action:${claim.updateId}`);
        for (const [index, outputValue] of outputs.entries()) {
          const output = object(outputValue); const chatId = output.chatId; const messageId = output.messageId;
          if (typeof chatId !== "number" || typeof messageId !== "number" || messageId <= 0) return { state: "rejected", text: "Tracked output evidence is malformed; no further outputs were deleted." };
          await deleteMessages(claim, chatId, [messageId], `preparation-output-${index + 1}`);
        }
        input.preparation.releaseForResolution(operationId, action, input.clock.now());
        input.admin.audit("preparation_uncertain_cleanup", String(input.adminUserId), input.clock.now(), itemId, operationId, { action, outputCount: outputs.length });
        return { text: `Tracked outputs for queue item #${itemId} were deleted. Reopen Queue to review the updated preparation state.`, replyMarkup: button("Queue", "queue") };
      }
      case "renewal_delete_replacements":
      case "renewal_manual_cleanup": {
        const itemId = payload.itemId; const operationId = payload.operationId; const generation = payload.sourceGeneration; const phase = payload.phase; const chatId = payload.chatId; const ids = numbers(payload.messageIds);
        if (typeof itemId !== "number" || typeof operationId !== "string" || typeof generation !== "number" || typeof phase !== "string" || typeof chatId !== "number" || !ids) return { state: "rejected", text: "The renewal cleanup request is invalid." };
        const item = input.queue.findItemById(itemId); const evidence = input.queue.operationEvidence(itemId);
        if (!item || !evidence || item.maintenanceStatus !== "uncertain_renewal" || item.sourceGeneration !== generation || evidence.operationId !== operationId || evidence.phase !== phase || phase !== "uncertain" || chatId !== input.queueChatId) return { state: "rejected", text: "This renewal cleanup is stale." };
        if (claim.actionKind === "renewal_delete_replacements" && JSON.stringify(evidence.knownReplacementIds.map(Number)) !== JSON.stringify(ids)) return { state: "rejected", text: "This renewal cleanup is stale." };
        saveOperationId(claim, `admin-action:${claim.updateId}`);
        try {
          await deleteMessages(claim, chatId, ids, "renewal-output-cleanup");
          input.queue.resolveUncertainRenewal(itemId, operationId, item.contentVersion, item.sourceGeneration, input.clock.now(), [], "manual_cleanup");
          return { text: `Known replacements for queue item #${itemId} were deleted. Reopen Queue to review the current generation.`, replyMarkup: button("Queue", "queue") };
        } catch (error) {
          input.queue.resolveUncertainRenewal(itemId, operationId, item.contentVersion, item.sourceGeneration, input.clock.now(), ids.map(asMessageId), "manual_cleanup");
          throw error;
        }
      }
      default: return { state: "rejected", text: `The saved admin action (${claim.actionKind}) is not supported by this worker.` };
    }
  };

  const runOnce = async (): Promise<boolean> => {
    const claim = input.updates.claimNext(input.bootId, input.clock.now()) ?? input.updates.claimManualPublishReconciliation(input.bootId, input.clock.now());
    if (!claim) return false;
    const finishOperation = input.operationTracker?.begin(`admin-update:${claim.updateId}`);
    let requestStarted = false;
    try {
      const result = (claim as { reconcileOnly?: boolean }).reconcileOnly === true ? reconcileManualPublish(claim as ClaimedAction) : await execute(claim as ClaimedAction);
      finish(claim, result);
    } catch (error) {
      const normalized = classifyTelegramError(error);
      const operationRecorded = input.updates.find(claim.updateId)?.operationId !== undefined;
      requestStarted = (error as { adminActionRequestStarted?: boolean })?.adminActionRequestStarted ?? operationRecorded;
      if (normalized.kind === "local_deferral" && (normalized.localDeferralReason === "shutdown" || normalized.localDeferralReason === "shared_cooldown" || normalized.localDeferralReason === "deadline")) {
        if (normalized.localDeferralReason === "shared_cooldown") {
          const incident = input.incidents?.snapshot();
          if (incident !== undefined) input.incidents?.setActionRequired(incident.id, true);
        }
        input.updates.requeue(claim.updateId, claim.claimToken, input.clock.now(), normalized.localDeferralReason);
      } else if (normalized.kind === "rate_limited" || (normalized.kind === "local_deferral" && normalized.localDeferralReason === "protection_changed")) {
        if (normalized.localDeferralReason === "protection_changed") finish(claim, { state: "rejected", text: "The action became stale before Telegram received it. Reopen Queue and try again." });
        else input.updates.requeue(claim.updateId, claim.claimToken, input.clock.now(), "telegram_rate_limited");
      } else {
        const state = requestStarted && ["transient_network", "transient_server", "ambiguous_send_result", "unknown_permanent"].includes(normalized.kind) ? "uncertain" : "rejected";
        const actionText = claim.actionKind === "queue_delete"
          ? `Deletion failed (${normalized.kind}); the SQLite item was kept.`
          : claim.actionKind === "preparation_cleanup"
            ? `Tracked output cleanup failed (${normalized.kind}); the item remains uncertain.`
            : claim.actionKind === "uncertain_publish_delete_retry"
              ? `Known output cleanup failed (${normalized.kind}); the item remains uncertain.`
              : claim.actionKind === "renewal_delete_replacements" || claim.actionKind === "renewal_manual_cleanup"
                ? `Replacement cleanup failed (${normalized.kind}); the item remains uncertain.`
                : `The action failed (${normalized.kind}); no action retry was started.`;
        finish(claim, { state, text: state === "uncertain" ? "The Telegram action may have completed, so it was not repeated. Review Queue and the saved operation evidence." : actionText });
      }
      input.logger.error("admin_action_failed", { updateId: claim.updateId, actionKind: claim.actionKind, errorKind: normalized.kind, requestStarted });
    } finally {
      finishOperation?.();
    }
    return true;
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      try { if (!await runOnce()) await abortableSleep(input.clock, 250, signal); }
      catch (error) { input.logger.error("admin_action_worker_failed", { error: error instanceof Error ? error.message : "unknown" }); await abortableSleep(input.clock, 1_000, signal); }
    }
  };
  return { runOnce, run };
};

import type { AdminRepository } from "../db/admin-repository";
import type { FeedbackClaim, InstagramFeedbackRepository } from "../db/instagram-feedback-repository";
import { classifyTelegramError, TelegramLocalDeferralError } from "../errors";
import { safeErrorDescription, type Logger } from "../logger";
import type { TelegramGateway } from "../telegram";
import type { TelegramCooldown } from "../telegram-cooldown";
import { withTelegramMutationScope, type TelegramRequestResult } from "../telegram-request-context";
import { asChatId, asMessageId, type Clock } from "../types";
import type { AdminReplyMarkupIntent } from "./admin-response-worker";
import { abortableSleep } from "./task-supervisor";

export const createInstagramFeedbackWorker = (input: {
  feedback: InstagramFeedbackRepository;
  admin: AdminRepository;
  gateway: TelegramGateway;
  clock: Clock;
  logger: Logger;
  bootId: string;
  cooldown?: TelegramCooldown;
  adminUserId: number;
}) => {
  const keyboard = (markup: AdminReplyMarkupIntent | undefined): unknown => {
    if (!markup) return { inline_keyboard: [] };
    if (markup.kind === "force_reply") return { force_reply: true, ...(markup.placeholder === undefined ? {} : { input_field_placeholder: markup.placeholder }) };
    return { inline_keyboard: markup.rows.map(row => row.map(button => ({ text: button.text, callback_data: `v1:${input.admin.createCallbackToken(input.adminUserId, button.action, button.payload, input.clock.now(), button.itemVersion)}` }))) };
  };
  const methodFor = (claim: FeedbackClaim): string => claim.action === "send" ? "sendMessage" : claim.action === "edit" ? "editMessageText" : "deleteMessages";
  const runOnce = async (): Promise<boolean> => {
    if (input.cooldown?.isActive()) return false;
    const claim = input.feedback.claim(input.clock.now(), input.bootId);
    if (!claim) return false;
    let started = false;
    let settled = false;
    const complete = (messageId = claim.messageId): void => {
      input.feedback.complete(claim, messageId, input.clock.now());
      settled = true;
    };
    const retry = (code: string, retryAt = input.clock.now() + 5_000): void => {
      input.feedback.retry(claim, retryAt, code, input.clock.now());
      settled = true;
    };
    const fail = (code: string): void => {
      input.feedback.fail(claim, code, input.clock.now());
      settled = true;
      input.logger.warn("instagram_feedback_delivery_failed", { itemId: claim.itemId, actionKind: claim.action, errorKind: code });
    };
    const result = (outcome: TelegramRequestResult): void => {
      if (settled) return;
      if (outcome.state === "accepted") {
        if (claim.action === "send") {
          const messageId = outcome.knownOutputIds?.[0];
          if (messageId === undefined || !Number.isSafeInteger(messageId) || messageId <= 0) fail("missing_delivery_receipt");
          else complete(messageId);
        } else complete();
      } else if (outcome.errorKind === "rate_limited") {
        retry("rate_limited", Math.max(input.clock.now() + 1_000, input.cooldown?.notBefore() ?? input.clock.now() + 60_000));
      } else if (outcome.state === "unknown") {
        if (claim.action === "send") fail("uncertain_send");
        else retry(outcome.errorKind ?? "unknown_result");
      } else if (["transient_network", "transient_server"].includes(outcome.errorKind ?? "")) retry(outcome.errorKind!);
      else if (claim.action === "delete" && outcome.errorKind === "source_missing") complete();
      else if (outcome.errorKind && outcome.errorKind !== "unknown_permanent") fail(outcome.errorKind);
      // Unknown permanent rejections need their full description (e.g. "not modified").
    };
    const beforeDispatch = (method?: string, payload?: unknown): void => {
      if (method !== methodFor(claim)) throw new Error("Unexpected Instagram feedback Telegram method");
      if (input.cooldown?.isActive()) throw new TelegramLocalDeferralError("shared_cooldown", input.cooldown.notBefore());
      if (claim.action !== "delete") {
        if (typeof payload !== "object" || payload === null) throw new Error("Instagram feedback dispatch payload is unavailable");
        (payload as Record<string, unknown>).reply_markup = keyboard(claim.replyMarkup);
      }
      if (!input.feedback.begin(claim, input.clock.now())) throw new TelegramLocalDeferralError("cancelled", input.clock.now());
      started = true;
    };
    const invoke = async (markup: unknown): Promise<number | undefined> => {
      const chatId = asChatId(claim.adminChatId);
      if (claim.action === "send") return Number(await input.gateway.sendAdminMessage({ chatId, text: claim.text, linkPreviewIsDisabled: true, replyMarkup: markup as never }));
      if (claim.messageId === undefined) throw new Error("Instagram feedback message ID is missing");
      if (claim.action === "edit") await input.gateway.editAdminMessage({ chatId, messageId: asMessageId(claim.messageId), text: claim.text, linkPreviewIsDisabled: true, replyMarkup: markup as never });
      else await input.gateway.deleteMessages(chatId, [asMessageId(claim.messageId)]);
      return claim.messageId;
    };
    try {
      if (input.gateway.dispatchManaged) {
        await withTelegramMutationScope({ family: "admin_response", priority: "admin", operationId: `instagram-feedback:${claim.itemId}:${claim.revision}`, itemId: claim.itemId, beforeDispatch, onResult: result }, () => invoke({ inline_keyboard: [] }));
        if (!settled) {
          if (claim.action === "send") fail("missing_delivery_receipt");
          else retry("missing_delivery_receipt");
        }
      } else {
        const payload: Record<string, unknown> = {};
        beforeDispatch(methodFor(claim), payload);
        const messageId = await invoke(payload.reply_markup);
        if (claim.action === "send" && (messageId === undefined || !Number.isSafeInteger(messageId) || messageId <= 0)) fail("missing_delivery_receipt");
        else complete(messageId);
      }
    } catch (error) {
      if (settled) return true;
      const normalized = classifyTelegramError(error, methodFor(claim));
      if (claim.action === "edit" && normalized.description.toLowerCase().includes("message is not modified") || claim.action === "delete" && normalized.kind === "source_missing") complete();
      else if (normalized.kind === "local_deferral") retry("local_deferral", Math.max(input.clock.now() + 1_000, normalized.retryAt ?? 0));
      else if (normalized.kind === "rate_limited") {
        const deadline = input.cooldown?.extendForRetryAfter(normalized.retryAfterSeconds) ?? input.clock.now() + (normalized.retryAfterSeconds ?? 60) * 1_000;
        retry("rate_limited", Math.max(input.clock.now() + 1_000, deadline));
      } else if (["transient_network", "transient_server", "ambiguous_send_result"].includes(normalized.kind) && (claim.action !== "send" || !started)) retry(normalized.kind);
      else fail(started && claim.action === "send" && ["transient_network", "transient_server", "ambiguous_send_result"].includes(normalized.kind) ? "uncertain_send" : normalized.kind);
    }
    return true;
  };
  const run = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      try { if (!await runOnce()) await abortableSleep(input.clock, 250, signal); }
      catch (error) {
        input.logger.error("instagram_feedback_worker_failed", { error: safeErrorDescription(error) });
        await abortableSleep(input.clock, 1_000, signal);
      }
    }
  };
  return { runOnce, run };
};

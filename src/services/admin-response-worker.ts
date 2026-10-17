import { randomUUID } from "node:crypto";
import type { AdminResponseKind, AdminResponseRecord, AdminResponseRepository } from "../db/admin-response-repository";
import type { AdminRepository } from "../db/admin-repository";
import { classifyTelegramError, TelegramLocalDeferralError } from "../errors";
import { safeErrorDescription, type Logger } from "../logger";
import type { TelegramGateway } from "../telegram";
import type { Clock } from "../types";
import { withTelegramMutationScope, type TelegramRequestResult } from "../telegram-request-context";
import type { TelegramCooldown } from "../telegram-cooldown";
import { abortableSleep } from "./task-supervisor";

export type AdminActionButton = { text: string; action: string; payload: unknown; itemVersion?: number };
export type AdminReplyMarkupIntent =
  | { kind: "inline_keyboard"; rows: AdminActionButton[][] }
  | { kind: "force_reply"; placeholder?: string };
export type AdminResponseDescriptor = {
  version: 1;
  text: string;
  entities?: readonly { type: string; offset: number; length: number; url?: string }[];
  disableLinkPreview?: boolean;
  replyMarkup?: AdminReplyMarkupIntent;
  prompt?: { adminId: number; generationId: string; kind: string };
  incident?: { id: string; kind: "warning" | "recovery" };
  alert?: { dedupeKey: string; fingerprint?: string; mode: "periodic" | "on_change" | "resolution" };
};

type Row = AdminResponseRecord & { descriptor: AdminResponseDescriptor };

const parseDescriptor = (record: AdminResponseRecord): Row => {
  const descriptor = record.descriptor as Partial<AdminResponseDescriptor> | null;
  if (!descriptor || descriptor.version !== 1 || typeof descriptor.text !== "string") throw new Error("Stored admin response descriptor is invalid");
  return { ...record, descriptor: descriptor as AdminResponseDescriptor };
};

export const createAdminResponseWorker = (input: {
  responses: AdminResponseRepository;
  admin: AdminRepository;
  gateway: TelegramGateway;
  adminChatId: number;
  adminUserId: number;
  bootId: string;
  clock: Clock;
  logger: Logger;
  cooldown?: TelegramCooldown;
  incidents?: {
    canDeliver(incidentId: string, kind: "warning" | "recovery", now: number): boolean;
    acknowledgeDelivered(incidentId: string, kind: "warning" | "recovery", outboxId: string, now: number): boolean;
  };
  alerts?: {
    canDeliver(dedupeKey: string, fingerprint: string | undefined, mode: "periodic" | "on_change" | "resolution"): boolean;
    acknowledgeDelivered(dedupeKey: string, fingerprint: string | undefined, mode: "periodic" | "on_change" | "resolution", now: number): void;
  };
}) => {
  const renderKeyboard = (markup: AdminReplyMarkupIntent, now: number): unknown => {
    if (markup.kind === "force_reply") return { force_reply: true, ...(markup.placeholder === undefined ? {} : { input_field_placeholder: markup.placeholder }) };
    return { inline_keyboard: markup.rows.map((row) => row.map((button) => ({
      text: button.text,
      callback_data: `v1:${input.admin.createCallbackToken(input.adminUserId, button.action, button.payload, now, button.itemVersion)}`,
    }))) };
  };

  const acknowledgeAccepted = (record: Row, claimToken: string, result: TelegramRequestResult): void => {
    const messageId = result.knownOutputIds?.[0];
    if (messageId === undefined) {
      input.responses.finishFailed(record.id, claimToken, "uncertain", "missing_delivery_receipt", "Telegram accepted the response without a usable message ID");
      return;
    }
    input.responses.markSentWithAcknowledgement(record.id, claimToken, messageId, input.clock.now(), () => {
      if (record.descriptor.prompt) {
        const prompt = record.descriptor.prompt;
        input.admin.activatePendingPrompt(prompt.adminId, prompt.generationId, record.id, messageId, input.clock.now());
      }
      if (record.descriptor.incident) input.incidents?.acknowledgeDelivered(record.descriptor.incident.id, record.descriptor.incident.kind, record.id, input.clock.now());
      if (record.descriptor.alert) input.alerts?.acknowledgeDelivered(record.descriptor.alert.dedupeKey, record.descriptor.alert.fingerprint, record.descriptor.alert.mode, input.clock.now());
    });
  };

  const recordResult = (record: Row, claimToken: string, result: TelegramRequestResult): void => {
    if (result.state === "accepted") {
      acknowledgeAccepted(record, claimToken, result);
      return;
    }
    if (result.state === "unknown") {
      input.responses.finishFailed(record.id, claimToken, "uncertain", result.errorKind ?? "unknown", "Telegram may have delivered this response");
      return;
    }
    if (result.errorKind === "rate_limited") {
      input.responses.retry(record.id, claimToken, Math.max(input.clock.now() + 1_000, input.cooldown?.notBefore() ?? input.clock.now() + 60_000), "rate_limited", "Telegram asked the response worker to retry later");
      return;
    }
    input.responses.finishFailed(record.id, claimToken, "failed", result.errorKind ?? "telegram_rejected", "Telegram rejected the response");
  };

  const runOnce = async (): Promise<boolean> => {
    const claim = input.responses.claimDue(input.clock.now(), input.bootId);
    if (!claim) return false;
    let record: Row;
    try { record = parseDescriptor(claim); }
    catch (error) {
      input.responses.finishFailed(claim.id, claim.claimToken!, "failed", "invalid_descriptor", error instanceof Error ? error.message : "Invalid response descriptor");
      return true;
    }
    const claimToken = claim.claimToken!;
    let started = false;
    const ensureStillEligible = (): void => {
      if (record.descriptor.incident && input.incidents?.canDeliver(record.descriptor.incident.id, record.descriptor.incident.kind, input.clock.now()) === false) {
        input.responses.cancel(record.id, input.clock.now());
        throw new TelegramLocalDeferralError("cancelled", input.clock.now(), "Telegram incident notification is no longer eligible");
      }
      if (record.descriptor.alert && input.alerts?.canDeliver(record.descriptor.alert.dedupeKey, record.descriptor.alert.fingerprint, record.descriptor.alert.mode) === false) {
        input.responses.cancel(record.id, input.clock.now());
        throw new TelegramLocalDeferralError("cancelled", input.clock.now(), "Admin alert is no longer current");
      }
    };
    const beforeDispatch = (method?: string, payload?: unknown): void => {
      if (method !== "sendMessage") throw new Error("Admin outbox only supports sendMessage");
      const recordPayload = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : undefined;
      if (recordPayload === undefined) throw new Error("Telegram send payload is unavailable at dispatch");
      ensureStillEligible();
      if (record.descriptor.replyMarkup !== undefined) recordPayload.reply_markup = renderKeyboard(record.descriptor.replyMarkup, input.clock.now());
      if (!input.responses.markRequestStarted(record.id, claimToken, input.clock.now())) throw new TelegramLocalDeferralError("cancelled", input.clock.now(), "Admin response was cancelled before delivery");
      started = true;
    };
    const onResult = (result: TelegramRequestResult): void => recordResult(record, claimToken, result);
    const scope = { family: "admin_response" as const, priority: "admin" as const, operationId: record.id, beforeDispatch, onResult };

    try {
      if (input.gateway.dispatchManaged === true) {
        const placeholder = record.descriptor.replyMarkup === undefined ? undefined
          : record.descriptor.replyMarkup.kind === "force_reply" ? renderKeyboard(record.descriptor.replyMarkup, input.clock.now())
            : { inline_keyboard: [] };
        const replyMarkup = placeholder as Parameters<TelegramGateway["sendAdminMessage"]>[0]["replyMarkup"];
        await withTelegramMutationScope(scope, () => input.gateway.sendAdminMessage({
          chatId: record.adminChatId as never,
          text: record.descriptor.text,
          ...(record.descriptor.entities === undefined ? {} : { entities: record.descriptor.entities as never }),
          ...(record.descriptor.disableLinkPreview === undefined ? {} : { linkPreviewIsDisabled: record.descriptor.disableLinkPreview }),
          ...(replyMarkup === undefined ? {} : { replyMarkup }),
        }));
      } else {
        ensureStillEligible();
        const now = input.clock.now();
        const replyMarkup = record.descriptor.replyMarkup === undefined ? undefined : renderKeyboard(record.descriptor.replyMarkup, now) as Parameters<TelegramGateway["sendAdminMessage"]>[0]["replyMarkup"];
        if (!input.responses.markRequestStarted(record.id, claimToken, now)) throw new TelegramLocalDeferralError("cancelled", now, "Admin response was cancelled before delivery");
        started = true;
        const messageId = await input.gateway.sendAdminMessage({ chatId: record.adminChatId as never, text: record.descriptor.text, ...(record.descriptor.entities === undefined ? {} : { entities: record.descriptor.entities as never }), ...(record.descriptor.disableLinkPreview === undefined ? {} : { linkPreviewIsDisabled: record.descriptor.disableLinkPreview }), ...(replyMarkup === undefined ? {} : { replyMarkup }) });
        acknowledgeAccepted(record, claimToken, { state: "accepted", knownOutputIds: [Number(messageId)] });
      }
      const fresh = input.responses.find(record.id);
      if (fresh?.state === "sending") {
        input.responses.finishFailed(record.id, claimToken, "uncertain", "missing_delivery_receipt", "Gateway returned without a durable delivery receipt");
      }
    } catch (error) {
      const normalized = classifyTelegramError(error, "sendMessage");
      if (normalized.kind === "local_deferral") {
        const current = input.clock.now();
        input.responses.retry(record.id, claimToken, Math.max(current + 1_000, normalized.retryAt ?? current + 1_000), "local_deferral", normalized.description);
      } else if (normalized.kind === "rate_limited") {
        input.responses.retry(record.id, claimToken, Math.max(input.clock.now() + 1_000, input.cooldown?.notBefore() ?? input.clock.now() + Math.max(1, normalized.retryAfterSeconds ?? 60) * 1_000), "rate_limited", normalized.description);
      } else if (started && ["transient_network", "transient_server", "ambiguous_send_result"].includes(normalized.kind)) {
        input.responses.finishFailed(record.id, claimToken, "uncertain", normalized.kind, normalized.description);
      } else {
        input.responses.finishFailed(record.id, claimToken, "failed", normalized.kind, normalized.description);
      }
      if (input.responses.find(record.id)?.state !== "cancelled") input.logger.error("admin_response_delivery_failed", { responseId: record.id, errorKind: normalized.kind, requestStarted: started });
    }
    return true;
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      try {
        const worked = await runOnce();
        if (!worked) await abortableSleep(input.clock, 250, signal);
      } catch (error) {
        input.logger.error("admin_response_worker_failed", { error: safeErrorDescription(error) });
        await abortableSleep(input.clock, 1_000, signal);
      }
    }
  };

  return { runOnce, run };
};

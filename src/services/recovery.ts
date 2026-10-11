import { randomUUID } from "node:crypto";
import type { Message } from "@grammyjs/types";
import { classifyTelegramError } from "../errors";
import { snapshotFromMessage } from "../domain/message";
import type { RecoveryRepository } from "../db/recovery-repository";
import type { PolicyRepository, QueueRepository } from "../db/repositories";
import type { Logger } from "../logger";
import type { ChatId, Clock, MessageId, SemanticOrigin, UserId } from "../types";
import { asChatId, asMessageId } from "../types";
import type { TelegramGateway } from "../telegram";
import type { OperationTracker } from "./task-supervisor";

export const queueInternalId = (queueChannelId: ChatId): string => {
  const value = String(Math.abs(queueChannelId));
  if (!value.startsWith("100") || value.length <= 3) throw new Error("Private queue links require a -100… channel ID");
  return value.slice(3);
};

export const parseRecoveryReference = (input: string, queueChannelId: ChatId): number[] => {
  const value = input.trim();
  const link = /^https?:\/\/t\.me\/c\/(\d+)\/(\d+)(?:\?.*)?$/i.exec(value) ?? /^t\.me\/c\/(\d+)\/(\d+)(?:\?.*)?$/i.exec(value);
  if (link) {
    if (link[1] !== queueInternalId(queueChannelId)) throw new Error("Recovery link is not from the configured queue channel");
    return [Number(link[2])];
  }
  if (/^https?:\/\/t\.me\//i.test(value) || /^t\.me\//i.test(value)) throw new Error("Only private queue-channel links are accepted in recovery");
  const tokens = value.split(/[\s,]+/u).filter(Boolean);
  if (tokens.length === 0) throw new Error("Provide a queue message link or message ID");
  const ids: number[] = [];
  for (const token of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start || end - start > 9) throw new Error("A recovery album range must contain 1–10 increasing IDs");
      for (let id = start; id <= end; id += 1) ids.push(id);
    } else if (/^\d+$/.test(token)) ids.push(Number(token));
    else throw new Error("Recovery accepts numeric IDs, an increasing range, or a private queue link");
  }
  if (ids.length > 10 || new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)) throw new Error("Recovery IDs must be unique, increasing, and contain at most 10 messages");
  return ids;
};

const originForRecoveredMessage = (origin: SemanticOrigin, queueChannelId: ChatId): SemanticOrigin => origin.kind === "channel" && origin.chatId === queueChannelId ? { kind: "absent" } : origin;

const assertCompatibleAlbum = (snapshots: readonly ReturnType<typeof snapshotFromMessage>[]): void => {
  if (snapshots.length <= 1) return;
  const first = snapshots[0]!;
  if (snapshots.some((snapshot) => snapshot.mediaGroupId === undefined || snapshot.mediaGroupId !== first.mediaGroupId)) throw new Error("Recovery messages are not members of one Telegram album");
  if (snapshots.some((snapshot) => ["text", "service", "unknown", "paid_media", "giveaway"].includes(snapshot.contentType))) throw new Error("Recovery album contains incompatible content");
  if (snapshots.some((snapshot) => JSON.stringify(snapshot.origin) !== JSON.stringify(first.origin))) throw new Error("Recovery album members have different semantic origins");
};

export type RecoveryService = ReturnType<typeof createRecoveryService>;

export const createRecoveryService = (input: {
  queue: QueueRepository;
  policy: PolicyRepository;
  gateway: TelegramGateway;
  queueChannelId: ChatId;
  adminChatId: ChatId;
  clock: Clock;
  logger: Logger;
  recovery?: RecoveryRepository;
  bootId?: string;
  operationId?: () => string;
  operationTracker?: OperationTracker;
}) => {
  const newOperationId = input.operationId ?? randomUUID;
  const bootId = input.bootId ?? "manual-recovery";

  const cleanupPreviews = async (operationId: string, previewIds: readonly MessageId[], itemId?: number): Promise<boolean> => {
    if (previewIds.length === 0) {
      input.recovery?.complete(operationId, input.clock.now());
      return true;
    }
    try {
      await input.gateway.deleteMessages(input.adminChatId, previewIds);
      input.recovery?.complete(operationId, input.clock.now());
      return true;
    } catch (error) {
      const description = error instanceof Error ? error.message : "preview cleanup failed";
      input.recovery?.markPreviewCleanupPending(operationId, input.clock.now(), description);
      input.logger.error("recovery_preview_cleanup_failed", { operationId, itemId, error: description });
      return false;
    }
  };

  const recoverUntracked = async (operationId: string, reference: string | readonly number[]): Promise<{ itemId: number; sourceIds: MessageId[] }> => {
    const numericIds = typeof reference === "string" ? parseRecoveryReference(reference, input.queueChannelId) : [...reference];
    if (numericIds.length < 1 || numericIds.length > 10) throw new Error("Recovery accepts 1–10 messages");
    if (numericIds.some((id) => !Number.isSafeInteger(id) || id < 1) || numericIds.some((id, index) => index > 0 && id <= numericIds[index - 1]!)) throw new Error("Recovery IDs must be strictly increasing");
    const sourceIds = numericIds.map(asMessageId);
    for (const sourceId of sourceIds) if (input.queue.findBySource(input.queueChannelId, sourceId)) throw new Error(`Queue message ${sourceId} is already known`);
    const now = input.clock.now();
    input.recovery?.createSession(operationId, sourceIds, bootId, now);
    const previews: MessageId[] = [];
    const snapshots: ReturnType<typeof snapshotFromMessage>[] = [];
    let insertedItemId: number | undefined;
    try {
      for (const [ordinal, sourceId] of sourceIds.entries()) {
        input.recovery?.addPreviewPending(operationId, sourceId, ordinal, input.clock.now());
        input.recovery?.setPhase(operationId, "preview_pending", input.clock.now());
        const preview = await input.gateway.forwardMessage({ targetChatId: input.adminChatId, sourceChatId: input.queueChannelId, messageId: sourceId });
        const previewId = preview.message_id as unknown as MessageId;
        previews.push(previewId);
        const captured = snapshotFromMessage(preview);
        const origin = originForRecoveredMessage(captured.origin, input.queueChannelId);
        const snapshot = { ...captured, chatId: input.queueChannelId, messageId: sourceId, ordinal, origin };
        snapshots.push(snapshot);
        input.recovery?.recordPreview(operationId, sourceId, input.adminChatId, previewId, snapshot, input.clock.now());
      }
      assertCompatibleAlbum(snapshots);
      const item = input.queue.insertRecoveredSnapshots(snapshots, input.clock.now());
      insertedItemId = item.id;
      input.recovery?.linkItem(operationId, item.id, input.clock.now());
      for (const snapshot of snapshots) input.policy.observeAuthor(snapshot.origin, input.clock.now());
      await cleanupPreviews(operationId, previews, insertedItemId);
      return { itemId: item.id, sourceIds };
    } catch (error) {
      if (previews.length > 0) await cleanupPreviews(operationId, previews, insertedItemId);
      else input.recovery?.setPhase(operationId, "failed", input.clock.now(), error instanceof Error ? error.message : "recovery failed");
      throw error;
    }
  };

  const recover = async (reference: string | readonly number[]): Promise<{ itemId: number; sourceIds: MessageId[] }> => {
    const operationId = newOperationId();
    const finish = input.operationTracker?.begin(operationId);
    try { return await recoverUntracked(operationId, reference); }
    finally { finish?.(); }
  };

  const reconcileExpiredSessions = async (): Promise<{ completed: number; blocked: number }> => {
    if (!input.recovery) return { completed: 0, blocked: 0 };
    let completed = 0;
    let blocked = 0;
    for (const session of input.recovery.listRecoverable(input.clock.now())) {
      try {
        const previews = input.recovery.previews(session.id);
        if (previews.some((preview) => preview.previewMessageId === undefined || preview.previewChatId === undefined)) {
          input.recovery.markPreviewCleanupPending(session.id, input.clock.now(), "A recovery preview call may have succeeded without a recorded response ID");
          input.logger.error("recovery_preview_output_unknown", { operationId: session.id, itemId: session.itemId });
          blocked += 1;
          continue;
        }
        const previewIds = previews.map((preview) => preview.previewMessageId!);
        if (previewIds.length > 0) {
          try {
            await input.gateway.deleteMessages(input.adminChatId, previewIds);
          } catch (error) {
            if (classifyTelegramError(error).kind !== "source_missing") throw error;
          }
        }
        input.recovery.complete(session.id, input.clock.now());
        completed += 1;
      } catch (error) {
        input.recovery.markPreviewCleanupPending(session.id, input.clock.now(), error instanceof Error ? error.message : "recovery preview cleanup failed");
        input.logger.error("recovery_preview_reconciliation_failed", { operationId: session.id, itemId: session.itemId, error: error instanceof Error ? error.message : "unknown" });
        blocked += 1;
      }
    }
    return { completed, blocked };
  };

  return { recover, reconcileExpiredSessions };
};

export const adminChatIdFromUserId = (userId: UserId): ChatId => asChatId(Number(userId));

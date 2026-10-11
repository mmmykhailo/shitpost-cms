import { randomUUID } from "node:crypto";
import type { Message } from "@grammyjs/types";
import { snapshotFromMessage } from "../domain/message";
import type { PolicyRepository, QueueRepository } from "../db/repositories";
import type { Logger } from "../logger";
import type { ChatId, Clock, MessageId, SemanticOrigin, UserId } from "../types";
import { asChatId, asMessageId } from "../types";
import type { TelegramGateway } from "../telegram";

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

export type RecoveryService = ReturnType<typeof createRecoveryService>;

export const createRecoveryService = (input: {
  queue: QueueRepository;
  policy: PolicyRepository;
  gateway: TelegramGateway;
  queueChannelId: ChatId;
  adminChatId: ChatId;
  clock: Clock;
  logger: Logger;
  operationId?: () => string;
}) => {
  const newOperationId = input.operationId ?? randomUUID;

  const recover = async (reference: string | readonly number[]): Promise<{ itemId: number; sourceIds: MessageId[] }> => {
    const operationId = newOperationId();
    const sourceIds = (typeof reference === "string" ? parseRecoveryReference(reference, input.queueChannelId) : [...reference]).map(asMessageId);
    if (sourceIds.length < 1 || sourceIds.length > 10) throw new Error("Recovery accepts 1–10 messages");
    if (sourceIds.some((id, index) => index > 0 && id <= sourceIds[index - 1]!)) throw new Error("Recovery IDs must be strictly increasing");
    for (const sourceId of sourceIds) if (input.queue.findBySource(input.queueChannelId, sourceId)) throw new Error(`Queue message ${sourceId} is already known`);
    const previews: MessageId[] = [];
    const snapshots = [];
    try {
      for (const [ordinal, sourceId] of sourceIds.entries()) {
        const preview = await input.gateway.forwardMessage({ targetChatId: input.adminChatId, sourceChatId: input.queueChannelId, messageId: sourceId });
        previews.push(preview.message_id as unknown as MessageId);
        const captured = snapshotFromMessage(preview);
        const origin = originForRecoveredMessage(captured.origin, input.queueChannelId);
        const snapshot = { ...captured, chatId: input.queueChannelId, messageId: sourceId, ordinal, origin, ...(sourceIds.length > 1 ? { mediaGroupId: `recovery:${operationId}` } : {}) };
        snapshots.push(snapshot);
        input.policy.observeAuthor(origin, input.clock.now());
      }
      const now = input.clock.now();
      const first = input.queue.observeQueueSnapshot(snapshots[0]!, now).item;
      for (const snapshot of snapshots.slice(1)) input.queue.addAlbumMember(first.id, snapshot, now);
      if (sourceIds.length > 1) input.queue.finalizeAlbums(now + 11_000);
      try {
        await input.gateway.deleteMessages(input.adminChatId, previews);
      } catch (error) {
        input.logger.warn("recovery_preview_cleanup_failed", { operationId, error: error instanceof Error ? error.message : "unknown" });
      }
      return { itemId: first.id, sourceIds };
    } catch (error) {
      if (previews.length > 0) {
        try { await input.gateway.deleteMessages(input.adminChatId, previews); }
        catch (cleanupError) { input.logger.error("recovery_failed_preview_cleanup", { operationId, error: cleanupError instanceof Error ? cleanupError.message : "unknown" }); }
      }
      throw error;
    }
  };

  return { recover };
};

export const adminChatIdFromUserId = (userId: UserId): ChatId => asChatId(Number(userId));

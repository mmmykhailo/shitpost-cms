import type { Message } from "@grammyjs/types";
import type { Logger } from "../logger";
import type { PendingUpdateRepository } from "../db/pending-update-repository";
import { snapshotFromMessage } from "../domain/message";
import type { GeneratedMessageRepository, PolicyRepository, QueueRepository } from "../db/repositories";
import type { ChatId, StoredMessageSnapshot } from "../types";

export type IngestionResult = {
  accepted: boolean;
  itemId?: number;
  ignoredReason?: "wrong_chat" | "generated_message" | "duplicate" | "pending_update";
};

export type IngestionService = ReturnType<typeof createIngestionService>;

export const createIngestionService = (input: {
  queueChannelId: ChatId;
  queue: QueueRepository;
  policy: PolicyRepository;
  generated: GeneratedMessageRepository;
  pending?: PendingUpdateRepository;
  logger: Logger;
  now: () => number;
}) => {
  const ingestLogicalSnapshot = (snapshot: StoredMessageSnapshot, now: number): IngestionResult => {
    input.policy.observeAuthor(snapshot.origin, now);
    if (snapshot.mediaGroupId !== undefined) {
      const existing = input.queue.findBySource(snapshot.chatId, snapshot.messageId);
      if (existing) return { accepted: false, itemId: existing.id, ignoredReason: "duplicate" };
      const album = input.queue.findCollectingAlbum(snapshot.chatId, snapshot.mediaGroupId);
      if (album) {
        const item = input.queue.addAlbumMember(album.id, snapshot, now);
        return { accepted: true, itemId: item.id };
      }
      const finalizedAlbum = input.queue.findAlbum(snapshot.chatId, snapshot.mediaGroupId);
      if (finalizedAlbum) {
        const item = input.queue.addLateAlbumMember(finalizedAlbum.id, snapshot);
        input.logger.warn("late_album_member_requires_review", { itemId: item.id, messageId: snapshot.messageId });
        return { accepted: true, itemId: item.id };
      }
    }
    const result = input.queue.observeQueueSnapshot(snapshot, now);
    return result.inserted
      ? { accepted: true, itemId: result.item.id }
      : { accepted: false, itemId: result.item.id, ignoredReason: "duplicate" };
  };

  const observe = (snapshot: StoredMessageSnapshot, now: number): IngestionResult => {
    const generated = input.generated.consume(snapshot.chatId, snapshot.messageId);
    if (generated) {
      input.logger.debug("generated_queue_message_suppressed", { chatId: snapshot.chatId, messageId: snapshot.messageId, operationId: generated.operationId, kind: generated.kind });
      return { accepted: false, ignoredReason: "generated_message" };
    }
    return ingestLogicalSnapshot(snapshot, now);
  };

  const handleChannelPost = (message: Message): IngestionResult => {
    if (message.chat.id !== input.queueChannelId) return { accepted: false, ignoredReason: "wrong_chat" };
    const snapshot = snapshotFromMessage(message);
    if (!input.pending) return observe(snapshot, input.now());
    input.pending.upsert(snapshot, input.now());
    return { accepted: false, ignoredReason: "pending_update" };
  };

  const handleEditedChannelPost = (message: Message): IngestionResult => {
    if (message.chat.id !== input.queueChannelId) return { accepted: false, ignoredReason: "wrong_chat" };
    const snapshot = snapshotFromMessage(message);
    const existing = input.queue.findBySource(snapshot.chatId, snapshot.messageId);
    if (!input.pending) {
      if (!existing) {
        input.logger.debug("edit_for_unknown_queue_message", { chatId: snapshot.chatId, messageId: snapshot.messageId });
        return { accepted: false, ignoredReason: "duplicate" };
      }
      input.policy.observeAuthor(snapshot.origin, input.now());
      input.queue.updateSnapshot(snapshot.chatId, snapshot.messageId, snapshot);
      return { accepted: true, itemId: existing.id };
    }
    // Persist first. If the process stops after this write, the finalizer can
    // replay the edit from SQLite without relying on Telegram update replay.
    input.pending.upsert(snapshot, input.now(), input.now());
    if (!existing) return { accepted: false, ignoredReason: "pending_update" };
    input.policy.observeAuthor(snapshot.origin, input.now());
    const updated = input.queue.updateSnapshot(snapshot.chatId, snapshot.messageId, snapshot);
    input.pending.markState(snapshot.chatId, snapshot.messageId, "ingested", input.now());
    return { accepted: true, itemId: updated?.id ?? existing.id };
  };

  const finalizePendingUpdates = (): number[] => {
    if (!input.pending) return [];
    const now = input.now();
    const ingested: number[] = [];
    for (const pending of input.pending.due(now)) {
      const generated = input.generated.consume(pending.queueChatId, pending.telegramMessageId);
      if (generated) {
        input.pending.markState(pending.queueChatId, pending.telegramMessageId, "consumed_generated", now, generated.operationId);
        input.logger.debug("generated_queue_message_suppressed", { chatId: pending.queueChatId, messageId: pending.telegramMessageId, operationId: generated.operationId, kind: generated.kind });
        continue;
      }
      const candidate = input.queue.renewalCandidateOperation(pending.queueChatId);
      if (candidate) {
        input.pending.markState(pending.queueChatId, pending.telegramMessageId, "quarantined_renewal_candidate", now, candidate.operationId, "A renewal operation may have created this update");
        input.logger.warn("renewal_candidate_quarantined", { operationId: candidate.operationId, itemId: candidate.itemId, messageId: pending.telegramMessageId });
        continue;
      }
      const existing = input.queue.findBySource(pending.queueChatId, pending.telegramMessageId);
      const result = existing
        ? (input.policy.observeAuthor(pending.snapshot.origin, now), input.queue.updateSnapshot(pending.queueChatId, pending.telegramMessageId, pending.snapshot), { accepted: true, itemId: existing.id })
        : ingestLogicalSnapshot(pending.snapshot, now);
      input.pending.markState(pending.queueChatId, pending.telegramMessageId, "ingested", now);
      if (result.itemId !== undefined) ingested.push(result.itemId);
    }
    return ingested;
  };

  const finalizeAlbums = (): number[] => {
    finalizePendingUpdates();
    return input.queue.finalizeAlbums(input.now()).map((item) => item.id);
  };

  return { handleChannelPost, handleEditedChannelPost, finalizeAlbums, finalizePendingUpdates, observe };
};

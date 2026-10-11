import type { Message } from "@grammyjs/types";
import type { Logger } from "../logger";
import { snapshotFromMessage } from "../domain/message";
import type { GeneratedMessageRepository, PolicyRepository, QueueRepository } from "../db/repositories";
import type { ChatId, StoredMessageSnapshot } from "../types";

export type IngestionResult = {
  accepted: boolean;
  itemId?: number;
  ignoredReason?: "wrong_chat" | "generated_message" | "duplicate";
};

export type IngestionService = ReturnType<typeof createIngestionService>;

export const createIngestionService = (input: {
  queueChannelId: ChatId;
  queue: QueueRepository;
  policy: PolicyRepository;
  generated: GeneratedMessageRepository;
  logger: Logger;
  now: () => number;
}) => {
  const observe = (snapshot: StoredMessageSnapshot, now: number): IngestionResult => {
    const generated = input.generated.consume(snapshot.chatId, snapshot.messageId);
    if (generated) {
      input.logger.debug("generated_queue_message_suppressed", { chatId: snapshot.chatId, messageId: snapshot.messageId, operationId: generated.operationId, kind: generated.kind });
      return { accepted: false, ignoredReason: "generated_message" };
    }
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

  const handleChannelPost = (message: Message): IngestionResult => {
    if (message.chat.id !== input.queueChannelId) return { accepted: false, ignoredReason: "wrong_chat" };
    return observe(snapshotFromMessage(message), input.now());
  };

  const handleEditedChannelPost = (message: Message): IngestionResult => {
    if (message.chat.id !== input.queueChannelId) return { accepted: false, ignoredReason: "wrong_chat" };
    const snapshot = snapshotFromMessage(message);
    const existing = input.queue.findBySource(snapshot.chatId, snapshot.messageId);
    if (!existing) {
      input.logger.debug("edit_for_unknown_queue_message", { chatId: snapshot.chatId, messageId: snapshot.messageId });
      return { accepted: false, ignoredReason: "duplicate" };
    }
    input.policy.observeAuthor(snapshot.origin, input.now());
    input.queue.updateSnapshot(snapshot.chatId, snapshot.messageId, snapshot);
    return { accepted: true, itemId: existing.id };
  };

  const finalizeAlbums = (): number[] => input.queue.finalizeAlbums(input.now()).map((item) => item.id);

  return { handleChannelPost, handleEditedChannelPost, finalizeAlbums, observe };
};

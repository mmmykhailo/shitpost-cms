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

const assertRecoverableBundle = (snapshots: readonly ReturnType<typeof snapshotFromMessage>[], creditLast: boolean): void => {
  if (creditLast) {
    const credit = snapshots.at(-1);
    if (snapshots.length < 2 || credit?.contentType !== "text" || credit.text === undefined || credit.mediaGroupId !== undefined) throw new Error("The last selected message must be standalone text to mark it as the separate credit.");
  }
  const albumPositions = new Map<string, number[]>();
  for (const [index, snapshot] of snapshots.entries()) {
    if (snapshot.mediaGroupId === undefined || (creditLast && index === snapshots.length - 1)) continue;
    const positions = albumPositions.get(snapshot.mediaGroupId) ?? [];
    positions.push(index);
    albumPositions.set(snapshot.mediaGroupId, positions);
  }
  for (const positions of albumPositions.values()) {
    if (positions.length <= 1) continue;
    if (positions.some((position, index) => index > 0 && position !== positions[index - 1]! + 1)) throw new Error("Selected Telegram album members must be contiguous in the recovery order");
    if (positions.some((position) => ["text", "service", "unknown", "paid_media", "giveaway"].includes(snapshots[position]!.contentType))) throw new Error("A selected Telegram album contains incompatible content");
  }
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
      if (classifyTelegramError(error).kind === "source_missing") {
        input.recovery?.complete(operationId, input.clock.now());
        return true;
      }
      const description = error instanceof Error ? error.message : "preview cleanup failed";
      input.recovery?.markPreviewCleanupPending(operationId, input.clock.now(), description);
      input.logger.error("recovery_preview_cleanup_failed", { operationId, itemId, error: description });
      return false;
    }
  };

  const recoverUntracked = async (operationId: string, reference: string | readonly number[]): Promise<{ itemId: number; sourceIds: MessageId[]; reused?: boolean; creditLast?: boolean; canApplyPreparationRules?: boolean }> => {
    const creditLast = typeof reference === "string" && /\s+--credit-last\s*$/iu.test(reference);
    const normalizedReference = typeof reference === "string" && creditLast ? reference.replace(/\s+--credit-last\s*$/iu, "") : reference;
    const numericIds = typeof normalizedReference === "string" ? parseRecoveryReference(normalizedReference, input.queueChannelId) : [...normalizedReference];
    if (numericIds.length < 1 || numericIds.length > 10) throw new Error("Recovery accepts 1–10 messages");
    if (creditLast && numericIds.length < 2) throw new Error("A content-plus-credit recovery needs at least one content message and a final text credit.");
    if (numericIds.some((id) => !Number.isSafeInteger(id) || id < 1) || numericIds.some((id, index) => index > 0 && id <= numericIds[index - 1]!)) throw new Error("Recovery IDs must be strictly increasing");
    const sourceIds = numericIds.map(asMessageId);
    const known = sourceIds.map((sourceId) => input.queue.findKnownSource(input.queueChannelId, sourceId));
    if (known.some((entry) => entry !== undefined)) {
      const sameCurrentItem = known.every((entry) => entry !== undefined && entry.current && !entry.removed && entry.itemId === known[0]?.itemId);
      if (sameCurrentItem && !creditLast) return { itemId: known[0]!.itemId, sourceIds, reused: true };
      const historical = known.find((entry) => entry !== undefined && (!entry.current || entry.removed));
      if (historical) throw new Error(`Message ${sourceIds[known.indexOf(historical)]} is already recorded in queue item #${historical.itemId} as an old or removed source.`);
      throw new Error("Some selected messages already belong to a queue item; reopen that item instead of recovering a duplicate.");
    }
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
        const previewId = asMessageId(preview.message_id);
        previews.push(previewId);
        const captured = snapshotFromMessage(preview);
        const origin = originForRecoveredMessage(captured.origin, input.queueChannelId);
        const snapshot = { ...captured, chatId: input.queueChannelId, messageId: sourceId, ordinal, origin };
        snapshots.push(snapshot);
        input.recovery?.recordPreview(operationId, sourceId, input.adminChatId, previewId, snapshot, input.clock.now());
      }
      assertRecoverableBundle(snapshots, creditLast);
      const item = input.queue.insertRecoveredSnapshots(snapshots, input.clock.now(), { creditLast });
      insertedItemId = item.id;
      input.recovery?.linkItem(operationId, item.id, input.clock.now());
      for (const [index, snapshot] of snapshots.entries()) if (!creditLast || index < snapshots.length - 1) input.policy.observeAuthor(snapshot.origin, input.clock.now());
      await cleanupPreviews(operationId, previews, insertedItemId);
      const oneRecordedAlbum = snapshots.length <= 1 || (snapshots[0]?.mediaGroupId !== undefined && snapshots.every((snapshot) => snapshot.mediaGroupId === snapshots[0]!.mediaGroupId));
      return { itemId: item.id, sourceIds, ...(creditLast ? { creditLast: true } : {}), canApplyPreparationRules: !creditLast && oneRecordedAlbum };
    } catch (error) {
      if (previews.length > 0) await cleanupPreviews(operationId, previews, insertedItemId);
      else input.recovery?.setPhase(operationId, "failed", input.clock.now(), error instanceof Error ? error.message : "recovery failed");
      throw error;
    }
  };

  const recover = async (reference: string | readonly number[]): Promise<{ itemId: number; sourceIds: MessageId[]; reused?: boolean; creditLast?: boolean; canApplyPreparationRules?: boolean }> => {
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

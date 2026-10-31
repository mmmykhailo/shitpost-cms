import type { AdminResponseRepository } from "../db/admin-response-repository";
import type { QueueRepository } from "../db/repositories";
import { buildQueueMessageLink } from "../domain/telegram-message-link";
import { sanitizeRecentLog } from "../logger";
import type { ChatId } from "../types";

export type InstagramProgress = {
  itemId: number;
  operationId: string;
  phase: "downloading" | "uploading" | "ready" | "retry" | "failed" | "uncertain" | "cancelled";
  reason?: string;
  retryAt?: number;
};

export const createInstagramFeedback = (input: {
  responses: AdminResponseRepository;
  queue: QueueRepository;
  adminUserId: number;
  queueChannelId: ChatId;
  now: () => number;
}) => (progress: InstagramProgress): void => {
  const item = input.queue.findItemById(progress.itemId);
  const stages: Record<InstagramProgress["phase"], string> = {
    downloading: "Downloading the Instagram video…",
    uploading: "Uploading the video to the queue…",
    ready: "Video prepared and waiting for publication.",
    retry: "Import paused; a retry is scheduled.",
    failed: "Import failed. The original submission remains in the queue. Review it with /queue.",
    uncertain: "Upload result is uncertain. The original submission remains available. Check for an existing video before retrying; review with /queue.",
    cancelled: "Import stopped because the queue item changed or was removed. Review its current state with /queue.",
  };
  const sourceId = input.queue.currentSourceIds(progress.itemId)[0];
  const sourceLink = sourceId === undefined ? undefined : buildQueueMessageLink(input.queueChannelId, sourceId);
  const reason = sanitizeRecentLog("instagram_import", { reason: progress.reason }).fields.reason;
  const text = [
    `Instagram import · queue #${progress.itemId}`,
    stages[progress.phase],
    ...(reason ? [`Details: ${reason}`] : []),
    ...(progress.retryAt === undefined ? [] : [`Retry at ${new Date(progress.retryAt).toISOString()} (UTC).`]),
    ...(sourceLink === undefined ? [] : [`Queue source: ${sourceLink}`]),
  ].join("\n");
  input.responses.enqueue({
    adminChatId: input.adminUserId,
    kind: "view",
    dedupeKey: `instagram-progress:${progress.operationId}:${progress.phase}`,
    coalesceKey: `instagram-progress:${progress.itemId}`,
    descriptor: {
      version: 1, text, disableLinkPreview: true,
      replyMarkup: { kind: "inline_keyboard", rows: [[
        ...(item === undefined ? [] : [{ text: "Queue item", action: "queue_item", payload: { itemId: item.id }, itemVersion: item.contentVersion }]),
        { text: "Logs", action: "logs", payload: {} },
      ]] },
    },
    now: input.now(),
  });
};

export type ChatId = number & { readonly __brand: "ChatId" };
export type MessageId = number & { readonly __brand: "MessageId" };
export type UserId = number & { readonly __brand: "UserId" };

export const asChatId = (value: number): ChatId => value as ChatId;
export const asMessageId = (value: number): MessageId => value as MessageId;
export const asUserId = (value: number): UserId => value as UserId;

export type ContentType =
  | "text"
  | "photo"
  | "video"
  | "animation"
  | "audio"
  | "document"
  | "voice"
  | "sticker"
  | "video_note"
  | "contact"
  | "location"
  | "venue"
  | "dice"
  | "poll"
  | "game"
  | "paid_media"
  | "giveaway"
  | "service"
  | "unknown";

export type SemanticOrigin =
  | {
      kind: "channel";
      chatId: ChatId;
      username?: string;
      title?: string;
      authorSignature?: string;
    }
  | {
      kind: "user";
      userId: UserId;
      username?: string;
      displayName: string;
    }
  | {
      kind: "hidden_user";
      senderUserName: string;
    }
  | {
      kind: "chat";
      chatId: ChatId;
      title?: string;
      username?: string;
    }
  | { kind: "absent" }
  | { kind: "unknown"; type: string };

export type MessageEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: { id: UserId; firstName: string; lastName?: string };
  language?: string;
  customEmojiId?: string;
};

export type StoredMessageSnapshot = {
  schemaVersion: 1;
  chatId: ChatId;
  messageId: MessageId;
  ordinal: number;
  mediaGroupId?: string;
  contentType: ContentType;
  text?: string;
  entities?: readonly MessageEntity[];
  caption?: string;
  captionEntities?: readonly MessageEntity[];
  showCaptionAboveMedia?: boolean;
  origin: SemanticOrigin;
  telegramDate: number;
  editDate?: number;
  hasReplyMarkup: boolean;
};

export type QueueItemStatus =
  | "collecting"
  | "queued"
  | "publishing"
  | "published_cleanup_pending"
  | "blocked"
  | "needs_edit"
  | "needs_review"
  | "uncertain_publish"
  | "delete_blocked"
  | "done"
  | "deleted"
  | "deleted_external";

/** Status values that were used by schema versions before maintenance was orthogonal. */
export type LegacyQueueItemStatus = "renewing" | "renewed_cleanup_pending" | "uncertain_renewal";

export type MaintenanceStatus =
  | "idle"
  | "renewing"
  | "renewal_cleanup_pending"
  | "uncertain_renewal";

export type OperationType = "publish" | "manual_publish" | "renew" | "delete" | "recover";
export type OperationState = "running" | "outputs_recorded" | "cleanup_pending" | "uncertain" | "done" | "failed";

export type PublicationPhase =
  | "claimed"
  | "transfer_pending"
  | "base_outputs_recorded"
  | "attribution_pending"
  | "output_complete"
  | "source_cleanup_pending"
  | "partial_cleanup_pending"
  | "uncertain"
  | "completed"
  | "failed";

export type RenewalPhase =
  | "claimed"
  | "replacement_pending"
  | "replacement_outputs_recorded"
  | "generation_installed"
  | "old_source_cleanup_pending"
  | "partial_cleanup_pending"
  | "uncertain"
  | "completed"
  | "failed";

export type OperationPhase = PublicationPhase | RenewalPhase | "legacy";
export type RecoveryPhase = "claimed" | "preview_pending" | "previews_recorded" | "item_inserted" | "preview_cleanup_pending" | "completed" | "failed";

export type OperationOutputRole = "transferred" | "separate_byline" | "replacement" | "temporary_preview" | "legacy";

export type OperationGuard = {
  operationId: string;
  itemId: number;
  capturedContentVersion: number;
  capturedSourceGeneration: number;
};

export type PublicationContract = {
  capturedLogicalStatus: QueueItemStatus;
  capturedContentVersion: number;
  capturedSourceGeneration: number;
  sourceIds: readonly MessageId[];
  policy: PublicationPlan;
  expectedTransferredMessageCount: number;
  expectedOutputMessageCount: number;
  requiresInlineEdit: boolean;
  requiresSeparateByline: boolean;
  bylineText?: string;
};

export type RenewalContract = {
  capturedLogicalStatus: QueueItemStatus;
  capturedContentVersion: number;
  capturedSourceGeneration: number;
  sourceIds: readonly MessageId[];
  expectedReplacementCount: number;
};

export type PendingQueueUpdateState =
  | "pending"
  | "quarantined_renewal_candidate"
  | "consumed_generated"
  | "ingested"
  | "discarded";

export type AdminResolution =
  | { kind: "publication_destination_complete"; destinationMessageIds: readonly MessageId[] }
  | { kind: "publication_delete_known_and_retry" }
  | { kind: "publication_nothing_published_retry" }
  | { kind: "renewal_adopt_replacements"; replacementMessageIds: readonly MessageId[] }
  | { kind: "renewal_delete_replacements_and_retry" }
  | { kind: "renewal_no_replacement" }
  | { kind: "renewal_manual_cleanup"; orphanMessageIds: readonly MessageId[] };

export type PublicationPlan =
  | { kind: "forward"; reason: "whitelisted_channel" }
  | { kind: "copy"; reason: "unlisted_channel" | "direct_queue_post" | "chat_origin" | "unknown_origin" }
  | { kind: "copy_with_inline_byline"; name: string }
  | { kind: "copy_with_separate_byline"; name: string }
  | { kind: "blocked"; reason: "unknown_origin" | "unsupported_content" | "mixed_album_origin" };

export type NormalizedTelegramErrorKind =
  | "rate_limited"
  | "transient_network"
  | "transient_server"
  | "source_missing"
  | "content_protected"
  | "unsupported_content"
  | "permission_denied"
  | "invalid_content_or_entities"
  | "destination_unavailable"
  | "ambiguous_send_result"
  | "unknown_permanent";

export type NormalizedTelegramError = {
  kind: NormalizedTelegramErrorKind;
  code?: number;
  description: string;
  retryAfterSeconds?: number;
  method?: string;
  cause?: unknown;
};

export type Clock = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

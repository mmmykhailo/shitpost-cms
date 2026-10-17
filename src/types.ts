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
  schemaVersion: 1 | 2;
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
  /** Bot API update order disambiguates edits with the same edit_date. */
  telegramUpdateId?: number;
  /** Native origin as observed on the current Telegram representation. */
  nativeOrigin?: SemanticOrigin;
  /** Stable payload fingerprint; excludes view and reaction counters. */
  contentFingerprint?: string;
  mediaFingerprint?: string;
  linkPreviewOptions?: { isDisabled?: boolean; url?: string; preferSmallMedia?: boolean; preferLargeMedia?: boolean; showAboveText?: boolean };
  replyMarkup?: Record<string, unknown>;
};

export type DeliveryMode = "copy" | "forward";
export type PreparationState = "unprepared" | "preparing" | "ready" | "refresh_pending" | "refreshing" | "failed" | "uncertain";
export type RepresentationKind = "raw" | "prepared";
export type MemberRole = "content" | "credit";

export type PreparedMember = {
  memberKey: string;
  messageId: MessageId;
  role: MemberRole;
  deliveryMode: DeliveryMode;
  albumKey?: string;
  snapshot: StoredMessageSnapshot;
};

export type AttributionDescriptor =
  | { ownership: "none" }
  | { ownership: "admin"; previousMemberKey?: string }
  | { ownership: "bot"; placement: "inline_text" | "inline_caption" | "separate"; memberKey: string; generatedText: string; generatedStartUtf16: number; generatedLengthUtf16: number; appliedNicknameRevision: number };

export type TransferStep = { stepKey: string; mode: DeliveryMode; grouped: boolean; members: readonly PreparedMember[] };

export type PreparationContractV1 = {
  version: 1;
  kind: "prepare" | "refresh";
  itemId: number;
  capturedContentVersion: number;
  capturedSourceGeneration: number;
  originalOrigin: SemanticOrigin;
  deliveryMode: DeliveryMode;
  capturedMembers: readonly PreparedMember[];
  steps: readonly TransferStep[];
  targetNicknameRevision: number;
  targetNicknameKey?: string;
  targetName?: string;
  attribution: AttributionDescriptor;
};

export type PreparedPublicationContractV2 = {
  version: 2;
  kind: "prepared_delivery";
  capturedContentVersion: number;
  capturedSourceGeneration: number;
  sourceIds: readonly MessageId[];
  steps: readonly TransferStep[];
  expectedOutputMessageCount: number;
};

export type PreparedRenewalContractV2 = {
  version: 2;
  kind: "prepared_renewal";
  capturedLogicalStatus: QueueItemStatus;
  capturedContentVersion: number;
  capturedSourceGeneration: number;
  sourceIds: readonly MessageId[];
  steps: readonly TransferStep[];
  expectedReplacementMessageCount: number;
};

export type RenewalExecutionProgress = {
  version: 1;
  effectiveContentVersion: number;
  members: readonly {
    memberKey: string;
    outcome: "pending" | "sent" | "confirmed_missing";
    outputIds: readonly MessageId[];
    missingEvidence?: { method: string; code?: number; description: string };
  }[];
};

export type RenewalExecutionGuard = OperationGuard & { expectedContentVersion: number };

export type ExecutionProgress = {
  version: 1;
  effectiveContentVersion: number;
  members: readonly { memberKey: string; outcome: "pending" | "sent" | "confirmed_missing"; outputIds: readonly MessageId[]; missingEvidence?: { method: string; code?: number; description: string } }[];
};

export type PreparedExecutionGuard = { operationId: string; itemId: number; capturedContentVersion: number; capturedSourceGeneration: number; expectedContentVersion: number };

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
  | "telegram_age_limit"
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
  /** Outputs safely parsed from an invalid/short creation response. */
  knownOutputs?: readonly MessageId[];
  /** True when a creation request may have reached Telegram. */
  requestMayHaveSucceeded?: boolean;
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

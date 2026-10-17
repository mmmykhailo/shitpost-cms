import type { AttributionDescriptor, DeliveryMode, MaintenanceStatus, MessageId, PreparationState, QueueItemStatus, RepresentationKind, SemanticOrigin, StoredMessageSnapshot } from "../types";

export type QueueItemRecord = {
  id: number;
  logicalSequence: number;
  queueChatId: number;
  mediaGroupId?: string;
  firstMessageId: MessageId;
  contentType: StoredMessageSnapshot["contentType"];
  origin: SemanticOrigin;
  status: QueueItemStatus;
  maintenanceStatus: MaintenanceStatus;
  maintenanceOperationId?: string;
  maintenanceRetryNotBefore?: number;
  contentVersion: number;
  sourceGeneration: number;
  preparationState?: PreparationState;
  representationKind?: RepresentationKind;
  deliveryMode?: DeliveryMode;
  policyCapturedAt?: number;
  preparedAt?: number;
  preparationOperationId?: string;
  nicknameRevisionWanted?: number;
  nicknameRevisionApplied?: number;
  nicknameRevisionWantedKey?: string;
  nicknameRevisionAppliedKey?: string;
  editorialFrozenAt?: number;
  editorialFreezeReason?: "admin_edit" | "admin_delete" | "legacy_edit_evidence" | "legacy_unverified";
  editorialFreezeMessageId?: MessageId;
  editorialFreezeUpdateId?: number;
  attribution?: AttributionDescriptor;
  attempts: number;
  enqueuedAt: number;
  physicalCreatedAt: number;
  lastRenewedAt?: number;
  retryNotBefore?: number;
  lastErrorCode?: string;
  lastError?: string;
  destinationMessageIds: MessageId[];
  claimedOperationId?: string;
  claimedAt?: number;
  albumQuietDeadline?: number;
  albumMaxDeadline?: number;
  publishedAt?: number;
  completedAt?: number;
};

export const sourceBearingStatuses = new Set<QueueItemStatus>([
  "collecting",
  "queued",
  "publishing",
  "published_cleanup_pending",
  "blocked",
  "needs_edit",
  "needs_review",
  "uncertain_publish",
  "delete_blocked",
]);

export const isSourceBearing = (status: QueueItemStatus): boolean => sourceBearingStatuses.has(status);

export const isBlockingHead = (item: QueueItemRecord, now: number): boolean => {
  if (!isSourceBearing(item.status)) return false;
  if (item.maintenanceStatus !== "idle") return true;
  if (["blocked", "needs_edit", "needs_review", "uncertain_publish", "collecting"].includes(item.status)) return true;
  return item.retryNotBefore !== undefined && item.retryNotBefore > now;
};

const validTransitions: Record<QueueItemStatus, readonly QueueItemStatus[]> = {
  collecting: ["queued", "needs_review", "deleted_external", "deleted"],
  queued: ["publishing", "blocked", "needs_edit", "needs_review", "deleted", "deleted_external", "collecting"],
  publishing: ["queued", "published_cleanup_pending", "uncertain_publish", "blocked", "needs_edit", "needs_review", "deleted_external", "deleted"],
  published_cleanup_pending: ["done", "uncertain_publish", "deleted_external"],
  blocked: ["queued", "publishing", "needs_review", "deleted", "deleted_external"],
  needs_edit: ["queued", "publishing", "deleted", "deleted_external"],
  needs_review: ["queued", "publishing", "deleted", "deleted_external"],
  uncertain_publish: ["published_cleanup_pending", "queued", "deleted", "deleted_external"],
  delete_blocked: ["deleted", "deleted_external", "queued"],
  done: [],
  deleted: [],
  deleted_external: [],
};

export const assertStatusTransition = (from: QueueItemStatus, to: QueueItemStatus): void => {
  if (!validTransitions[from].includes(to)) throw new Error(`Invalid queue state transition: ${from} -> ${to}`);
};

export const sortSnapshots = (snapshots: readonly StoredMessageSnapshot[]): StoredMessageSnapshot[] =>
  [...snapshots].sort((left, right) => left.messageId - right.messageId).map((snapshot, ordinal) => ({ ...snapshot, ordinal }));

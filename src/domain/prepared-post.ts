import type { PreparedMember, QueueItemStatus, PreparationState, RepresentationKind } from "../types";

export type PreparationReadiness = {
  status: QueueItemStatus;
  preparationState: PreparationState;
  representationKind: RepresentationKind;
  preparationOperationId?: string;
  maintenanceStatus: string;
  retryNotBefore?: number;
  nicknameRevisionWanted: number;
  nicknameRevisionApplied: number;
  nicknameRevisionWantedKey?: string;
  nicknameRevisionAppliedKey?: string;
  editorialFrozenAt?: number;
  attributionOwnership: "none" | "admin" | "bot";
  currentMembers: readonly PreparedMember[];
  hasConflictingOwner: boolean;
};

/** The prepared-only publication gate shared by scheduler and manual publish. */
export const isPreparedPostReady = (item: PreparationReadiness, now: number): boolean =>
  item.status === "queued" &&
  item.preparationState === "ready" &&
  item.representationKind === "prepared" &&
  item.preparationOperationId === undefined &&
  item.maintenanceStatus === "idle" &&
  !item.hasConflictingOwner &&
  (item.retryNotBefore === undefined || item.retryNotBefore <= now) &&
  item.currentMembers.length > 0 &&
  item.currentMembers.every((member) => member.deliveryMode === "copy" || member.deliveryMode === "forward") &&
  (item.attributionOwnership !== "bot" || item.editorialFrozenAt !== undefined || (
    item.nicknameRevisionWantedKey !== undefined || item.nicknameRevisionAppliedKey !== undefined
      ? item.nicknameRevisionWantedKey !== undefined && item.nicknameRevisionWantedKey === item.nicknameRevisionAppliedKey && item.nicknameRevisionApplied === item.nicknameRevisionWanted
      : item.nicknameRevisionApplied === item.nicknameRevisionWanted
  ));

/** Validate the structural properties needed before a prepared bundle is installed. */
export const assertPreparedMembers = (members: readonly PreparedMember[]): void => {
  if (members.length === 0) throw new Error("A prepared post must contain at least one member");
  const keys = new Set<string>();
  const ids = new Set<number>();
  for (const member of members) {
    if (!member.memberKey || keys.has(member.memberKey)) throw new Error("Prepared member keys must be non-empty and unique");
    if (!Number.isSafeInteger(member.messageId) || member.messageId <= 0 || ids.has(member.messageId)) throw new Error("Prepared member message IDs must be positive and unique");
    keys.add(member.memberKey);
    ids.add(member.messageId);
  }
};

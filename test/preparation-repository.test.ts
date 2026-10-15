import { afterEach, describe, expect, test } from "bun:test";
import { createPreparationRepository, type PreparationResult } from "../src/db/preparation-repository";
import { createQueueRepository } from "../src/db/repositories";
import { asMessageId, type PreparationContractV1 } from "../src/types";
import { createTestDatabase } from "./support";
import { snapshotFixture } from "./fixtures";

const resources: Array<{ close(): void }> = [];
const open = () => {
  const resource = createTestDatabase("preparation-repository");
  resources.push(resource);
  return { ...resource, queue: createQueueRepository(resource.database), preparation: createPreparationRepository(resource.database, { operationId: () => "prep-1" }) };
};

afterEach(() => { while (resources.length) resources.pop()!.close(); });

const contractFor = (itemId: number, contentVersion: number, generation: number, members: ReturnType<ReturnType<typeof createQueueRepository>["getCurrentMembers"]>): PreparationContractV1 => ({
  version: 1,
  kind: "prepare",
  itemId,
  capturedContentVersion: contentVersion,
  capturedSourceGeneration: generation,
  originalOrigin: members[0]!.snapshot.origin,
  deliveryMode: "copy",
  capturedMembers: members,
  steps: [{ stepKey: "content", mode: "copy", grouped: members.length > 1, members }],
  targetNicknameRevision: 0,
  attribution: { ownership: "none" },
});

const resultFor = (member: ReturnType<ReturnType<typeof createQueueRepository>["getCurrentMembers"]>[number], outputId: number): PreparationResult => {
  const snapshot = { ...member.snapshot, chatId: member.snapshot.chatId, messageId: asMessageId(outputId), ordinal: 0, nativeOrigin: { kind: "absent" as const }, origin: member.snapshot.origin };
  return { members: [{ ...member, messageId: asMessageId(outputId), snapshot }], attribution: { ownership: "none" }, nicknameRevisionApplied: 0 };
};

describe("preparation repository", () => {
  test("claims, persists contract and outputs, installs a guarded generation, then tracks cleanup", () => {
    const { database, queue, preparation } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(70) }), 1_000, "copy", 900);
    const claim = preparation.claimNextPreparation(2_000, "boot-a")!;
    expect(claim).toMatchObject({ itemId: 1, kind: "prepare", sourceIds: [asMessageId(70)], operationId: "prep-1" });
    const members = queue.getCurrentMembers(1);
    preparation.persistContract(claim.operationId, contractFor(1, claim.guard.capturedContentVersion, claim.guard.capturedSourceGeneration, members), 2_001);
    preparation.setPhase(claim.operationId, "transfer_pending", 2_002);
    const result = resultFor(members[0]!, 700);
    preparation.recordOutput(claim.operationId, { chatId: -100, messageId: 700, ordinal: 0, outputKey: "prep-1:700", stepKey: "content", sourceMemberKey: members[0]!.memberKey, role: "content", snapshot: result.members[0]!.snapshot }, 2_003);
    preparation.recordCompleteResult(claim.operationId, result, 2_004);
    expect(preparation.installPreparedGeneration(claim.operationId, 2_005)).toEqual({ itemId: 1, oldSourceIds: [asMessageId(70)], preparationState: "ready" });
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(700)]);
    expect(queue.getCurrentMembers(1)[0]).toMatchObject({ memberKey: "legacy:70", role: "content", deliveryMode: "copy" });
    expect((database.raw.query("SELECT preparation_state, representation_kind, source_generation FROM queue_items WHERE id = 1").get() as object)).toEqual({ preparation_state: "ready", representation_kind: "prepared", source_generation: 1 });
    expect(preparation.listCleanupPending()).toEqual([{ operationId: "prep-1", itemId: 1, sourceIds: [asMessageId(70)] }]);
    preparation.finishCleanup("prep-1", 2_006);
    expect(preparation.listCleanupPending()).toHaveLength(0);
  });

  test("advances only its execution version when a particular source is confirmed missing", () => {
    const { queue, preparation } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(71), mediaGroupId: "album" }), 1_000);
    queue.addAlbumMember(1, snapshotFixture({ messageId: asMessageId(72), mediaGroupId: "album", ordinal: 1 }), 1_100);
    queue.finalizeAlbums(4_000);
    const claim = preparation.claimNextPreparation(4_001, "boot-a")!;
    const members = queue.getCurrentMembers(1);
    preparation.persistContract(claim.operationId, contractFor(1, claim.guard.capturedContentVersion, claim.guard.capturedSourceGeneration, members), 4_002);
    preparation.setPhase(claim.operationId, "transfer_pending", 4_003);
    const deleted = preparation.markMemberMissing(claim.guard, members[0]!.memberKey, { method: "copyMessage", code: 400, description: "message to copy not found" }, 4_004);
    expect(deleted).toMatchObject({ remainingCount: 1, itemRemoved: false, nextGuard: { expectedContentVersion: 2 } });
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(72)]);
    const surviving = queue.getCurrentMembers(1)[0]!;
    const result = resultFor(surviving, 702);
    preparation.recordOutput(claim.operationId, { chatId: -100, messageId: 702, ordinal: 0, outputKey: "prep-1:702", stepKey: "content", sourceMemberKey: surviving.memberKey, role: "content", snapshot: result.members[0]!.snapshot }, 4_005);
    preparation.recordCompleteResult(claim.operationId, result, 4_006);
    preparation.installPreparedGeneration(claim.operationId, 4_007);
    expect(queue.currentSourceIds(1)).toEqual([asMessageId(702)]);
  });

  test("rejects an output ID already owned by another operation", () => {
    const { database, queue, preparation } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(73) }), 1_000);
    const claim = preparation.claimNextPreparation(2_000, "boot-a")!;
    database.raw.query("INSERT INTO operations (id, type, item_id, state, captured_content_version, captured_source_generation, created_at, updated_at) VALUES ('publish-other', 'publish', 1, 'failed', 1, 0, 1, 1)").run();
    database.raw.query("INSERT INTO operation_outputs (operation_id, kind, chat_id, telegram_message_id, ordinal, recorded_at) VALUES ('publish-other', 'destination', -100, 999, 0, 1)").run();
    expect(() => preparation.recordOutput(claim.operationId, { chatId: -100, messageId: 999, ordinal: 0, outputKey: "prep-1:999", stepKey: "content", role: "content" }, 2_001)).toThrow(/already owned/);
  });
});

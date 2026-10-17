import { afterEach, describe, expect, test } from "bun:test";
import { createPreparationRepository } from "../src/db/preparation-repository";
import { createPreparationRequestRepository } from "../src/db/preparation-request-repository";
import { createQueueRepository } from "../src/db/repositories";
import { asMessageId } from "../src/types";
import { createTestDatabase } from "./support";
import { snapshotFixture } from "./fixtures";

const resources: Array<{ close(): void }> = [];
const open = () => {
  const resource = createTestDatabase("preparation-request");
  resources.push(resource);
  return {
    ...resource,
    queue: createQueueRepository(resource.database),
    preparation: createPreparationRepository(resource.database, { operationId: () => "prep-request-1" }),
    requests: createPreparationRequestRepository(resource.database),
  };
};

afterEach(() => { while (resources.length) resources.pop()!.close(); });

describe("preparation request evidence", () => {
  test("a newly claimed operation with no dispatch recovers as safe work", () => {
    const { database, queue, preparation } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(80) }), 1_000);
    const claim = preparation.claimNextPreparation(2_000, "boot-a")!;
    preparation.setPhase(claim.operationId, "transfer_pending", 2_001);

    expect(preparation.recoverExpiredOperations(3_000, "boot-b")).toEqual({ requeued: 1, uncertain: 0, cleanupPending: 0 });
    expect(database.raw.query("SELECT preparation_state, preparation_operation_id, status FROM queue_items WHERE id = 1").get()).toEqual({ preparation_state: "unprepared", preparation_operation_id: null, status: "queued" });
  });

  test("an in-flight request remains uncertain after restart", () => {
    const { database, queue, preparation, requests } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(81) }), 1_000);
    const claim = preparation.claimNextPreparation(2_000, "boot-a")!;
    preparation.setPhase(claim.operationId, "transfer_pending", 2_001);
    requests.begin({ operationId: claim.operationId, method: "copyMessage", targetChatId: -100, stepKey: "member:0", now: 2_002 });

    expect(preparation.recoverExpiredOperations(3_000, "boot-b")).toEqual({ requeued: 0, uncertain: 1, cleanupPending: 0 });
    expect(database.raw.query("SELECT state FROM preparation_request_attempts WHERE operation_id = ?").get(claim.operationId)).toEqual({ state: "in_flight" });
    expect(queue.findItemById(1)).toMatchObject({ preparationState: "uncertain", status: "needs_review" });
  });

  test("definitively rejected no-output requests recover as safe work", () => {
    const { database, queue, preparation, requests } = open();
    queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(82) }), 1_000);
    const claim = preparation.claimNextPreparation(2_000, "boot-a")!;
    preparation.setPhase(claim.operationId, "transfer_pending", 2_001);
    const id = requests.begin({ operationId: claim.operationId, method: "copyMessage", targetChatId: -100, stepKey: "member:0", now: 2_002 });
    requests.finish(id, { state: "rejected", errorKind: "source_missing" }, 2_003);

    expect(preparation.recoverExpiredOperations(3_000, "boot-b")).toEqual({ requeued: 1, uncertain: 0, cleanupPending: 0 });
    expect(database.raw.query("SELECT preparation_state, preparation_operation_id, status FROM queue_items WHERE id = 1").get()).toEqual({ preparation_state: "unprepared", preparation_operation_id: null, status: "queued" });
  });
});

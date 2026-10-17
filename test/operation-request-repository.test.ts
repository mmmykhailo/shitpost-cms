import { afterEach, describe, expect, test } from "bun:test";
import { createOperationRequestRepository } from "../src/db/operation-request-repository";
import { createQueueRepository } from "../src/db/repositories";
import { asMessageId } from "../src/types";
import { snapshotFixture } from "./fixtures";
import { createTestDatabase, markQueueItemPrepared, type TestDatabase } from "./support";

const resources: TestDatabase[] = [];
const open = () => {
  const resource = createTestDatabase("request-evidence");
  resources.push(resource);
  const queue = createQueueRepository(resource.database);
  const requests = createOperationRequestRepository(resource.database);
  queue.observeQueueSnapshot(snapshotFixture({ messageId: asMessageId(901) }), 1_000);
  markQueueItemPrepared(resource.database, 1, "copy", 2_000);
  const claimed = queue.claimReadyPublication("request-operation", "publish", 3_000, undefined, undefined, [], undefined, 1)!;
  return { ...resource, queue, requests, claimed };
};

afterEach(() => { while (resources.length) resources.pop()!.close(); });

describe("operation request evidence", () => {
  test("journals each actual request in order and records accepted output IDs", () => {
    const { database, requests, claimed } = open();
    const first = requests.begin({ operationId: claimed.operationId, method: "copyMessage", targetChatId: -200, stepKey: "member:0", now: 4_000 });
    expect(requests.listForOperation(claimed.operationId)).toMatchObject([{ ordinal: 1, state: "in_flight", method: "copyMessage", stepKey: "member:0" }]);
    requests.finish(first, { state: "accepted", knownOutputIds: [902] }, 4_010);
    const second = requests.begin({ operationId: claimed.operationId, method: "deleteMessages", targetChatId: -100, now: 4_020 });
    requests.finish(second, { state: "rejected", errorKind: "rate_limited" }, 4_030);
    expect(requests.listForOperation(claimed.operationId)).toMatchObject([
      { ordinal: 1, state: "accepted", knownOutputIds: [902], startedAt: 4_000, finishedAt: 4_010 },
      { ordinal: 2, state: "rejected", errorKind: "rate_limited", startedAt: 4_020, finishedAt: 4_030 },
    ]);
    expect((database.raw.query("SELECT request_evidence_version FROM operations WHERE id = ?").get(claimed.operationId) as { request_evidence_version: number }).request_evidence_version).toBe(1);
    expect(() => requests.finish(first, { state: "accepted" }, 4_040)).toThrow(/no longer in flight/);
  });

  test("rejects malformed Telegram output IDs before storing evidence", () => {
    const { requests, claimed } = open();
    const id = requests.begin({ operationId: claimed.operationId, method: "copyMessage", targetChatId: -200, now: 4_000 });
    expect(() => requests.finish(id, { state: "accepted", knownOutputIds: [0] }, 4_001)).toThrow(/positive safe integers/);
    expect(requests.listForOperation(claimed.operationId)[0]?.state).toBe("in_flight");
  });
});

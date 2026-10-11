import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db/database";
import { createGeneratedMessageRepository, createPolicyRepository, createQueueRepository } from "../src/db/repositories";
import { createIngestionService } from "../src/services/ingestion";
import { createLogger } from "../src/logger";
import { asChatId, asMessageId } from "../src/types";
import { snapshotFixture } from "./fixtures";

const open = () => {
  const directory = mkdtempSync(join(tmpdir(), "queuebot-ingestion-"));
  const database = createDatabase(join(directory, "bot.sqlite"));
  let currentTime = 10_000;
  const service = createIngestionService({
    queueChannelId: asChatId(-100),
    queue: createQueueRepository(database),
    policy: createPolicyRepository(database),
    generated: createGeneratedMessageRepository(database),
    logger: createLogger("error"),
    now: () => currentTime,
  });
  return { directory, database, service, advance: (milliseconds: number) => { currentTime += milliseconds; } };
};

let current: ReturnType<typeof open> | undefined;
afterEach(() => {
  current?.database.close();
  if (current) rmSync(current.directory, { recursive: true, force: true });
  current = undefined;
});

describe("ingestion service", () => {
  test("groups an album, suppresses generated replacements, and ignores other chats", () => {
    current = open();
    const first = snapshotFixture({ messageId: asMessageId(30), mediaGroupId: "g" });
    const second = snapshotFixture({ messageId: asMessageId(31), mediaGroupId: "g" });
    expect(current.service.observe(first, 10_000)).toMatchObject({ accepted: true, itemId: 1 });
    expect(current.service.observe(second, 10_500)).toMatchObject({ accepted: true, itemId: 1 });
    current.advance(3_000);
    expect(current.service.finalizeAlbums()).toEqual([1]);
    current.service.observe({ ...first, messageId: asMessageId(99) }, 11_000);
    expect(current.service.observe(first, 11_000).ignoredReason).toBe("duplicate");
  });

  test("uses the persistent suppression record for renewal updates", () => {
    current = open();
    const generated = createGeneratedMessageRepository(current.database);
    generated.register(-100, [500], "renew-1", "renewal", 10_000);
    const result = current.service.observe(snapshotFixture({ messageId: asMessageId(500) }), 10_001);
    expect(result).toEqual({ accepted: false, ignoredReason: "generated_message" });
  });
});
